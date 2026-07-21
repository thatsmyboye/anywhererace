import { describe, expect, it } from 'vitest';
import { createMockElevationProvider, destinationPoint, haversineMeters } from '@anywhererace/core';
import type { LatLng } from '@anywhererace/core';
import { buildPreview, previewGeometry, profileSamplePoints } from '../src/preview';

const ORIGIN: LatLng = { lat: 51.5, lng: -0.12 };

const straight = (lengthM: number, step = 40): LatLng[] => {
  const points: LatLng[] = [];
  for (let d = 0; d <= lengthM; d += step) points.push(destinationPoint(ORIGIN, 90, d));
  return points;
};

const circle = (radiusM: number, stepDeg = 4): LatLng[] => {
  const points: LatLng[] = [];
  for (let angle = 0; angle < 360; angle += stepDeg) {
    points.push(destinationPoint(ORIGIN, angle, radiusM));
  }
  points.push(points[0] as LatLng);
  return points;
};

describe('previewGeometry', () => {
  it('measures length without needing a DEM', () => {
    // The whole point of the preview: curvature and length are pure geometry,
    // so the builder can show them on every edit without spending an elevation
    // request it does not have to spend.
    const preview = previewGeometry(straight(2000), 'point-to-point');
    expect(preview.lengthMeters).toBeGreaterThan(1990);
    expect(preview.lengthMeters).toBeLessThan(2010);
  });

  it('finds no corners on a straight', () => {
    const preview = previewGeometry(straight(1000), 'point-to-point');
    expect(preview.cornerCount).toBe(0);
    expect(preview.tightestRadiusM).toBe(Infinity);
  });

  it('recovers the radius of a known circle', () => {
    const preview = previewGeometry(circle(120), 'circuit');
    expect(preview.cornerCount).toBeGreaterThan(0);
    expect(preview.tightestRadiusM).toBeGreaterThan(100);
    expect(preview.tightestRadiusM).toBeLessThan(140);
  });

  it('survives a route too short to have geometry', () => {
    expect(previewGeometry([], 'circuit').lengthMeters).toBe(0);
    expect(previewGeometry([ORIGIN], 'circuit').cornerCount).toBe(0);
  });
});

describe('profileSamplePoints', () => {
  it('keeps a track within a single elevation request', () => {
    // The public elevation service allows 100 locations per call and 1000 calls
    // a day. One request per preview is the difference between a usable budget
    // and one spent in an afternoon of editing.
    for (const lengthM of [500, 5_000, 40_000]) {
      expect(profileSamplePoints(straight(lengthM)).length).toBeLessThanOrEqual(100);
    }
  });

  it('samples roughly every 50m on a short route', () => {
    const points = profileSamplePoints(straight(1000));
    expect(points.length).toBeGreaterThan(15);
    expect(points.length).toBeLessThanOrEqual(21);
  });

  it('starts and ends on the route', () => {
    const polyline = straight(1200);
    const points = profileSamplePoints(polyline);
    const first = points[0] as LatLng;
    const last = points[points.length - 1] as LatLng;
    expect(haversineMeters(first, polyline[0] as LatLng)).toBeLessThan(1);
    expect(haversineMeters(last, polyline[polyline.length - 1] as LatLng)).toBeLessThan(1);
  });

  it('spaces samples evenly', () => {
    const points = profileSamplePoints(straight(1000));
    const gaps: number[] = [];
    for (let i = 1; i < points.length; i++) {
      gaps.push(haversineMeters(points[i - 1] as LatLng, points[i] as LatLng));
    }
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    for (const gap of gaps) expect(Math.abs(gap - mean)).toBeLessThan(1);
  });
});

describe('buildPreview', () => {
  const elevation = createMockElevationProvider({ seed: 'preview', reliefM: 60 });

  it('returns a profile with climb and descent totals', async () => {
    const result = await buildPreview(circle(400), 'circuit', elevation);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.profile.length).toBeGreaterThan(2);
    expect(result.value.climbM).toBeGreaterThan(0);
    expect(result.value.descentM).toBeGreaterThan(0);
    // A closed loop returns to its starting height, so what goes up comes down.
    expect(Math.abs(result.value.climbM - result.value.descentM)).toBeLessThan(5);
  });

  it('reports distances that run from zero to the route length', async () => {
    const result = await buildPreview(straight(2000), 'point-to-point', elevation);
    if (!result.ok) return;
    const profile = result.value.profile;
    expect(profile[0]?.distanceM).toBe(0);
    expect(profile[profile.length - 1]?.distanceM).toBeCloseTo(result.value.lengthMeters, 0);
  });

  it('keeps the geometry when the elevation service fails', async () => {
    // An outage should cost the chart, never the whole preview — the user is
    // still drawing, and a missing profile beats a dead builder.
    const failing = {
      id: 'failing',
      maxBatchSize: 100,
      lookup: async () =>
        ({ ok: false, error: { kind: 'provider-unavailable' as const, message: 'down' } }) as const,
    };
    const result = await buildPreview(circle(120), 'circuit', failing);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lengthMeters).toBeGreaterThan(0);
    expect(result.value.cornerCount).toBeGreaterThan(0);
    expect(result.value.profile).toEqual([]);
  });

  it('handles a route with nothing in it', async () => {
    const result = await buildPreview([], 'circuit', elevation);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.profile).toEqual([]);
    expect(result.value.lengthMeters).toBe(0);
  });
});
