import type { LatLng, TrackMode } from '@anywhererace/core';
import { cumulativeDistances, interpolateLatLng } from '@anywhererace/core';

/**
 * Resample a polyline to uniform spacing.
 *
 * This is the first step of baking and everything else depends on it. The
 * output spacing is the requested spacing adjusted slightly so that a whole
 * number of samples fits the route exactly — otherwise a circuit would have one
 * short segment at the join, and the sim's node-index arithmetic (which assumes
 * uniform spacing) would drift by that much every lap.
 *
 * Circuits omit the closing sample, because it would be a duplicate of the
 * first. Point-to-point routes keep their final sample, because the finish line
 * is there.
 */
export type ResampledPolyline = {
  points: LatLng[];
  /** Distance from the route start at each point. */
  distances: number[];
  /** Actual spacing used, which is at most a few percent from the requested one. */
  spacingM: number;
  totalLengthM: number;
};

export const resamplePolyline = (
  polyline: readonly LatLng[],
  targetSpacingM: number,
  mode: TrackMode,
): ResampledPolyline => {
  if (polyline.length < 2) {
    const only = polyline[0];
    return {
      points: only === undefined ? [] : [only],
      distances: only === undefined ? [] : [0],
      spacingM: targetSpacingM,
      totalLengthM: 0,
    };
  }

  const sourceDistances = cumulativeDistances(polyline);
  const totalLengthM = sourceDistances[sourceDistances.length - 1] as number;

  // At least four segments, or curvature fitting has nothing to work with.
  const segments = Math.max(4, Math.round(totalLengthM / targetSpacingM));
  const spacingM = totalLengthM / segments;
  const sampleCount = mode === 'circuit' ? segments : segments + 1;

  const points: LatLng[] = new Array(sampleCount);
  const distances: number[] = new Array(sampleCount);

  // Walk the source polyline once rather than searching it per sample.
  let cursor = 1;
  for (let i = 0; i < sampleCount; i++) {
    const target = i * spacingM;
    while (cursor < sourceDistances.length - 1 && (sourceDistances[cursor] as number) < target) {
      cursor += 1;
    }
    const before = sourceDistances[cursor - 1] as number;
    const after = sourceDistances[cursor] as number;
    const span = after - before;
    const t = span <= 0 ? 0 : (target - before) / span;
    points[i] = interpolateLatLng(
      polyline[cursor - 1] as LatLng,
      polyline[cursor] as LatLng,
      // Clamped because the last sample of a point-to-point route can land a
      // hair past the final vertex through floating-point accumulation.
      t < 0 ? 0 : t > 1 ? 1 : t,
    );
    distances[i] = target;
  }

  return { points, distances, spacingM, totalLengthM };
};
