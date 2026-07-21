import { describe, expect, it } from 'vitest';
import {
  bearingDegrees,
  boundsOf,
  centroidOf,
  cumulativeDistances,
  destinationPoint,
  haversineMeters,
  interpolateLatLng,
  polylineLengthMeters,
  toLocalMeters,
} from '../src/geo';
import { bearingDeltaDeg, normalizeBearingDeg } from '../src/units';

const LONDON = { lat: 51.5074, lng: -0.1278 };
const PARIS = { lat: 48.8566, lng: 2.3522 };

describe('haversineMeters', () => {
  it('matches a known long-distance value', () => {
    // London to Paris is about 344km. Within 1km is plenty for a check that
    // the formula and the Earth radius are both right.
    expect(haversineMeters(LONDON, PARIS) / 1000).toBeCloseTo(344, 0);
  });

  it('is zero for a point against itself, and symmetric', () => {
    expect(haversineMeters(LONDON, LONDON)).toBe(0);
    expect(haversineMeters(PARIS, LONDON)).toBeCloseTo(haversineMeters(LONDON, PARIS), 6);
  });

  it('is accurate at the scale we actually resample at', () => {
    // 5m spacing is the whole basis of baking; if this drifts, every track
    // length is wrong.
    const north = destinationPoint(LONDON, 0, 5);
    expect(haversineMeters(LONDON, north)).toBeCloseTo(5, 6);
  });
});

describe('bearingDegrees', () => {
  it('reports cardinal directions correctly', () => {
    expect(bearingDegrees(LONDON, destinationPoint(LONDON, 0, 1000))).toBeCloseTo(0, 3);
    expect(bearingDegrees(LONDON, destinationPoint(LONDON, 90, 1000))).toBeCloseTo(90, 3);
    expect(bearingDegrees(LONDON, destinationPoint(LONDON, 180, 1000))).toBeCloseTo(180, 3);
    expect(bearingDegrees(LONDON, destinationPoint(LONDON, 270, 1000))).toBeCloseTo(270, 3);
  });

  it('always returns a bearing in [0, 360)', () => {
    for (let heading = -720; heading <= 720; heading += 17) {
      const bearing = bearingDegrees(LONDON, destinationPoint(LONDON, heading, 500));
      expect(bearing).toBeGreaterThanOrEqual(0);
      expect(bearing).toBeLessThan(360);
    }
  });
});

describe('destinationPoint', () => {
  it('round-trips against haversine', () => {
    for (const distance of [1, 50, 500, 5000]) {
      const target = destinationPoint(LONDON, 42, distance);
      expect(haversineMeters(LONDON, target)).toBeCloseTo(distance, 3);
    }
  });
});

describe('polyline helpers', () => {
  const polyline = [0, 100, 250, 400].map((d) => destinationPoint(LONDON, 45, d));

  it('measures total length', () => {
    expect(polylineLengthMeters(polyline)).toBeCloseTo(400, 2);
  });

  it('reports cumulative distances starting at zero', () => {
    const distances = cumulativeDistances(polyline);
    expect(distances[0]).toBe(0);
    expect(distances[3]).toBeCloseTo(400, 2);
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i] as number).toBeGreaterThan(distances[i - 1] as number);
    }
  });

  it('interpolates between vertices', () => {
    const midpoint = interpolateLatLng(polyline[0] as never, polyline[3] as never, 0.5);
    expect(haversineMeters(polyline[0] as never, midpoint)).toBeCloseTo(200, 0);
  });
});

describe('bounds and centroid', () => {
  const points = [
    { lat: 10, lng: 20 },
    { lat: -5, lng: 40 },
    { lat: 3, lng: -10 },
  ];

  it('finds the bounding box', () => {
    expect(boundsOf(points)).toEqual({ north: 10, south: -5, east: 40, west: -10 });
  });

  it('takes the center of the bounds', () => {
    expect(centroidOf(points)).toEqual({ lat: 2.5, lng: 15 });
  });

  it('throws on an empty polyline rather than inventing a point', () => {
    expect(() => boundsOf([])).toThrow();
  });
});

describe('toLocalMeters', () => {
  it('puts the origin at zero and scales to meters', () => {
    expect(toLocalMeters(LONDON, LONDON)).toEqual({ x: 0, y: 0 });
    const north = destinationPoint(LONDON, 0, 30);
    const local = toLocalMeters(LONDON, north);
    expect(local.y).toBeCloseTo(30, 2);
    expect(local.x).toBeCloseTo(0, 2);
  });
});

describe('bearing arithmetic', () => {
  it('takes the short way around the compass', () => {
    expect(bearingDeltaDeg(350, 10)).toBeCloseTo(20, 6);
    expect(bearingDeltaDeg(10, 350)).toBeCloseTo(-20, 6);
    expect(bearingDeltaDeg(0, 180)).toBeCloseTo(180, 6);
  });

  it('normalizes any input into [0, 360)', () => {
    expect(normalizeBearingDeg(-90)).toBe(270);
    expect(normalizeBearingDeg(450)).toBe(90);
    expect(normalizeBearingDeg(360)).toBe(0);
  });
});
