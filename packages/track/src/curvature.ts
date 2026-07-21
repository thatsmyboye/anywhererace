import type { LatLng, TrackMode } from '@anywhererace/core';
import { toLocalMeters } from '@anywhererace/core';
import { BAKE } from './constants';

/**
 * Corner radius per node, via the circumscribed circle through three points
 * spanning ±`curvatureWindowM`, then smoothed with a rolling median.
 *
 * The median is doing real work here. Three near-collinear points produce a
 * radius that blows up toward infinity, and three points where the middle one
 * is a hair off the line produce an absurdly tight radius. Both show up as
 * single-node spikes surrounded by sane values, which a median rejects
 * outright and a mean would smear over the whole window.
 */
export const computeCurvatureRadii = (
  points: readonly LatLng[],
  spacingM: number,
  mode: TrackMode,
): number[] => {
  const count = points.length;
  const raw: number[] = new Array(count);
  const offset = Math.max(1, Math.round(BAKE.curvatureWindowM / spacingM));
  const wraps = mode === 'circuit';

  for (let i = 0; i < count; i++) {
    const before = indexAt(i - offset, count, wraps);
    const after = indexAt(i + offset, count, wraps);
    if (before === undefined || after === undefined) {
      // Ends of a point-to-point route have no window on one side. Treating
      // them as straight is safer than fitting a circle to a shorter window,
      // which would systematically over-report curvature at both ends.
      raw[i] = Infinity;
      continue;
    }
    raw[i] = circumscribedRadius(
      points[before] as LatLng,
      points[i] as LatLng,
      points[after] as LatLng,
    );
  }

  return rollingMedian(raw, BAKE.curvatureMedianWindow, wraps).map(normalizeRadius);
};

const indexAt = (index: number, count: number, wraps: boolean): number | undefined => {
  if (wraps) return ((index % count) + count) % count;
  return index < 0 || index >= count ? undefined : index;
};

/**
 * Radius of the circle through three points: `R = abc / 4A`, where A is the
 * triangle's area. Projected into a local meter plane first — over a 30m window
 * the projection error is far below the noise in the underlying geometry.
 */
const circumscribedRadius = (a: LatLng, b: LatLng, c: LatLng): number => {
  const pa = toLocalMeters(b, a);
  const pc = toLocalMeters(b, c);
  // `b` is the projection origin, so it sits at (0, 0).

  const ab = Math.sqrt(pa.x * pa.x + pa.y * pa.y);
  const bc = Math.sqrt(pc.x * pc.x + pc.y * pc.y);
  const dx = pc.x - pa.x;
  const dy = pc.y - pa.y;
  const ca = Math.sqrt(dx * dx + dy * dy);

  // Twice the signed area, via the cross product of (a->b) and (b->c).
  const twiceArea = Math.abs(pa.x * pc.y - pa.y * pc.x);
  if (twiceArea === 0) return Infinity;

  return (ab * bc * ca) / (2 * twiceArea);
};

const normalizeRadius = (radius: number): number => {
  if (!Number.isFinite(radius) || radius >= BAKE.straightRadiusM) return Infinity;
  return Math.max(BAKE.minRadiusM, radius);
};

/**
 * Rolling median over a window of `width` samples. Exported because the
 * elevation path wants the same edge-handling behavior.
 */
export const rollingMedian = (
  values: readonly number[],
  width: number,
  wraps: boolean,
): number[] => {
  const count = values.length;
  const half = Math.floor(width / 2);
  const out: number[] = new Array(count);
  const window: number[] = [];

  for (let i = 0; i < count; i++) {
    window.length = 0;
    for (let k = -half; k <= half; k++) {
      const index = indexAt(i + k, count, wraps);
      if (index === undefined) continue;
      window.push(values[index] as number);
    }
    // Infinity sorts to the end and is a legitimate value here (a straight),
    // so the median stays meaningful without special-casing it.
    window.sort((x, y) => x - y);
    out[i] = window[Math.floor(window.length / 2)] as number;
  }
  return out;
};

/** Rolling mean, used to take the sampling noise out of DEM elevations. */
export const rollingMean = (
  values: readonly number[],
  width: number,
  wraps: boolean,
): number[] => {
  const count = values.length;
  const half = Math.floor(width / 2);
  const out: number[] = new Array(count);

  for (let i = 0; i < count; i++) {
    let sum = 0;
    let n = 0;
    for (let k = -half; k <= half; k++) {
      const index = indexAt(i + k, count, wraps);
      if (index === undefined) continue;
      sum += values[index] as number;
      n += 1;
    }
    out[i] = n === 0 ? (values[i] as number) : sum / n;
  }
  return out;
};

/**
 * Count of distinct corners, for the track builder's "detected corners"
 * readout. A corner is a run of consecutive nodes tighter than the straight
 * threshold, so a long sweeper counts once rather than forty times.
 */
export const countCorners = (radii: readonly number[], thresholdM = 200): number => {
  let corners = 0;
  let inCorner = false;
  for (const radius of radii) {
    const tight = Number.isFinite(radius) && radius < thresholdM;
    if (tight && !inCorner) corners += 1;
    inCorner = tight;
  }
  return corners;
};
