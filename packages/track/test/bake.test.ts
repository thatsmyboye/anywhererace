import { describe, expect, it } from 'vitest';
import type { LatLng, RouteAnnotation, RouteJunction, TrackMode } from '@anywhererace/core';
import { destinationPoint, polylineLengthMeters } from '@anywhererace/core';
import { bakeNodes, resampleForBake } from '../src/bake';
import { BAKE } from '../src/constants';
import { computeCurvatureRadii, countCorners, rollingMean, rollingMedian } from '../src/curvature';
import { resamplePolyline } from '../src/resample';

const ORIGIN: LatLng = { lat: 51.5, lng: -0.12 };

/** A straight line with deliberately uneven vertex spacing. */
const straightPolyline = (lengthM: number, gaps: number[]): LatLng[] => {
  const points: LatLng[] = [ORIGIN];
  let distance = 0;
  let i = 0;
  while (distance < lengthM) {
    distance += gaps[i % gaps.length] as number;
    i += 1;
    if (distance >= lengthM) break;
    points.push(destinationPoint(ORIGIN, 90, distance));
  }
  points.push(destinationPoint(ORIGIN, 90, lengthM));
  return points;
};

/** A closed circle of the given radius, sampled every `stepDeg`. */
const circlePolyline = (radiusM: number, stepDeg = 5): LatLng[] => {
  const points: LatLng[] = [];
  for (let angle = 0; angle < 360; angle += stepDeg) {
    points.push(destinationPoint(ORIGIN, angle, radiusM));
  }
  points.push(points[0] as LatLng);
  return points;
};

const flatElevations = (count: number, value = 100): number[] =>
  new Array<number>(count).fill(value);

describe('resamplePolyline', () => {
  it('preserves length to within 0.5%', () => {
    // The property CLAUDE.md asks for. Uneven input spacing is the whole point:
    // raw OSM geometry looks like this.
    for (const gaps of [[3, 40, 7, 120, 15], [1, 2, 3], [200, 5]]) {
      const polyline = straightPolyline(2000, gaps);
      const sourceLength = polylineLengthMeters(polyline);
      const resampled = resamplePolyline(polyline, BAKE.nodeSpacingM, 'point-to-point');
      const resampledLength = polylineLengthMeters(resampled.points);
      expect(Math.abs(resampledLength - sourceLength) / sourceLength).toBeLessThan(0.005);
    }
  });

  it('produces genuinely uniform spacing', () => {
    const resampled = resamplePolyline(
      straightPolyline(1000, [3, 40, 7, 120]),
      BAKE.nodeSpacingM,
      'point-to-point',
    );
    for (let i = 1; i < resampled.distances.length; i++) {
      const gap = (resampled.distances[i] as number) - (resampled.distances[i - 1] as number);
      expect(gap).toBeCloseTo(resampled.spacingM, 9);
    }
    expect(resampled.spacingM).toBeCloseTo(BAKE.nodeSpacingM, 0);
  });

  it('omits the duplicate closing sample on a circuit and keeps the end on a point-to-point', () => {
    const circle = circlePolyline(200);
    const asCircuit = resamplePolyline(circle, BAKE.nodeSpacingM, 'circuit');
    const asLine = resamplePolyline(circle, BAKE.nodeSpacingM, 'point-to-point');
    expect(asLine.points).toHaveLength(asCircuit.points.length + 1);
    expect(asCircuit.distances[0]).toBe(0);
  });

  it('survives a degenerate polyline instead of throwing', () => {
    expect(resamplePolyline([], 5, 'point-to-point').points).toHaveLength(0);
    expect(resamplePolyline([ORIGIN], 5, 'point-to-point').points).toHaveLength(1);
  });
});

describe('computeCurvatureRadii', () => {
  it('reports a straight as Infinity', () => {
    const resampled = resamplePolyline(straightPolyline(500, [10, 30]), 5, 'point-to-point');
    const radii = computeCurvatureRadii(resampled.points, resampled.spacingM, 'point-to-point');
    for (const radius of radii) expect(radius).toBe(Infinity);
  });

  it('recovers the radius of a known circle', () => {
    for (const radius of [60, 150, 400]) {
      const resampled = resamplePolyline(circlePolyline(radius, 2), 5, 'circuit');
      const radii = computeCurvatureRadii(resampled.points, resampled.spacingM, 'circuit');
      const finite = radii.filter((r) => Number.isFinite(r));
      expect(finite.length).toBeGreaterThan(radii.length * 0.9);
      const mean = finite.reduce((total, r) => total + r, 0) / finite.length;
      // 5% is generous, but the input is a polygon approximating a circle and
      // then resampled, so a few percent of error is inherent.
      expect(Math.abs(mean - radius) / radius).toBeLessThan(0.05);
    }
  });

  it('is always finite-and-positive or Infinity, never negative or NaN', () => {
    // The property test CLAUDE.md asks for, run over a deliberately nasty
    // input: a circle sampled coarsely enough to produce near-collinear triples.
    const resampled = resamplePolyline(circlePolyline(80, 30), 5, 'circuit');
    const radii = computeCurvatureRadii(resampled.points, resampled.spacingM, 'circuit');
    for (const radius of radii) {
      expect(Number.isNaN(radius)).toBe(false);
      expect(radius).toBeGreaterThan(0);
      if (Number.isFinite(radius)) expect(radius).toBeGreaterThanOrEqual(BAKE.minRadiusM);
    }
  });

  it('rejects single-node spikes rather than smearing them', () => {
    const values = [100, 100, 100, 3, 100, 100, 100];
    const smoothed = rollingMedian(values, 5, false);
    // A mean would drag the neighbors down toward the spike; a median deletes it.
    expect(smoothed[3]).toBe(100);
  });

  it('counts a long sweeper as one corner, not forty', () => {
    const resampled = resamplePolyline(circlePolyline(120, 2), 5, 'circuit');
    const radii = computeCurvatureRadii(resampled.points, resampled.spacingM, 'circuit');
    // A full circle read as a lap is a single continuous corner.
    expect(countCorners(radii)).toBeLessThanOrEqual(2);
  });
});

describe('rollingMean', () => {
  it('smooths without shifting the average', () => {
    const values = [1, 5, 2, 8, 3, 9, 4];
    const smoothed = rollingMean(values, 3, false);
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(smoothed)).toBeCloseTo(mean(values), 0);
    // Peak-to-trough must shrink, or it did not smooth anything.
    expect(Math.max(...smoothed) - Math.min(...smoothed)).toBeLessThan(
      Math.max(...values) - Math.min(...values),
    );
  });
});

describe('bakeNodes', () => {
  const bakeStraight = (
    mode: TrackMode = 'point-to-point',
    annotations: RouteAnnotation[] = [],
    junctions: RouteJunction[] = [],
    elevate?: (index: number) => number,
  ) => {
    const polyline = straightPolyline(1000, [8, 25, 6]);
    const { points } = resampleForBake(polyline, mode);
    const elevations = elevate ? points.map((_, i) => elevate(i)) : flatElevations(points.length);
    return bakeNodes({ polyline, mode, annotations, junctions, elevations });
  };

  it('produces nodes at uniform 5m spacing covering the whole route', () => {
    const baked = bakeStraight();
    expect(baked.spacingM).toBeCloseTo(BAKE.nodeSpacingM, 0);
    expect(baked.nodes[0]?.distance).toBe(0);
    expect(baked.nodes[baked.nodes.length - 1]?.distance).toBeCloseTo(baked.lengthMeters, 6);
  });

  it('keeps gradients within plausible bounds even on nasty elevation data', () => {
    // A sawtooth DEM: exactly the noise pattern that produces imaginary cliffs
    // if you differentiate raw samples 5m apart.
    const baked = bakeStraight('point-to-point', [], [], (i) => 100 + (i % 2) * 12);
    for (const node of baked.nodes) {
      expect(Number.isFinite(node.gradient)).toBe(true);
      expect(Math.abs(node.gradient)).toBeLessThanOrEqual(BAKE.maxAbsGradient);
      // Smoothing should have flattened the sawtooth almost entirely.
      expect(Math.abs(node.gradient)).toBeLessThan(0.5);
    }
  });

  it('recovers a real gradient from clean elevation data', () => {
    // A steady 4% climb, sampled at the baked node positions.
    const baked = bakeStraight('point-to-point', [], [], (i) => 100 + i * 5 * 0.04);
    const middle = baked.nodes.slice(10, -10);
    for (const node of middle) expect(node.gradient).toBeCloseTo(0.04, 3);
  });

  it('carries surface, confidence and width through from the annotations', () => {
    const baked = bakeStraight('point-to-point', [
      {
        startIndex: 0,
        endIndex: 20,
        surface: 'gravel',
        surfaceConfidence: 'inferred',
        widthMeters: 1.5,
        highway: 'track',
      },
    ]);
    expect(baked.nodes[0]?.surface).toBe('gravel');
    expect(baked.nodes[0]?.surfaceConfidence).toBe('inferred');
    expect(baked.nodes[0]?.widthMeters).toBe(1.5);
  });

  it('applies a junction penalty that ramps in and back out', () => {
    const polyline = straightPolyline(1000, [8, 25, 6]);
    // Roughly the midpoint of the route, in source-polyline index terms.
    const midIndex = Math.floor(polyline.length / 2);
    const baked = bakeStraight('point-to-point', [], [
      { atIndex: midIndex, kind: 'signals', turnAngleDeg: 0 },
    ]);

    const penalties = baked.nodes.map((n) => n.junctionPenalty);
    const tightest = Math.min(...penalties);
    expect(tightest).toBeLessThan(0.4);
    // Far from the junction there is no penalty at all.
    expect(penalties[0]).toBe(1);
    expect(penalties[penalties.length - 1]).toBe(1);
    // And it is a ramp, not a cliff: several nodes are partially penalized.
    expect(penalties.filter((p) => p > tightest && p < 1).length).toBeGreaterThan(2);
  });

  it('defaults to no penalty and a sane width when nothing is annotated', () => {
    const baked = bakeStraight();
    for (const node of baked.nodes) {
      expect(node.junctionPenalty).toBe(1);
      expect(node.widthMeters).toBe(BAKE.defaultWidthM);
      expect(node.surfaceConfidence).toBe('inferred');
    }
  });

  it('gives every node a bearing in range', () => {
    const baked = bakeStraight('circuit');
    for (const node of baked.nodes) {
      expect(node.bearing).toBeGreaterThanOrEqual(0);
      expect(node.bearing).toBeLessThan(360);
    }
  });

  it('falls back to a flat track when the elevation array is the wrong length', () => {
    const polyline = straightPolyline(500, [10]);
    const baked = bakeNodes({
      polyline,
      mode: 'point-to-point',
      annotations: [],
      junctions: [],
      elevations: [1, 2, 3],
    });
    // Better a flat track than a silently misaligned one.
    for (const node of baked.nodes) expect(node.gradient).toBe(0);
  });
});
