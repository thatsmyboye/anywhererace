import type {
  LatLng,
  RouteAnnotation,
  RouteJunction,
  SurfaceType,
  TrackMode,
  TrackNode,
} from '@anywhererace/core';
import { bearingDegrees, clamp, cumulativeDistances } from '@anywhererace/core';
import { BAKE, JUNCTION_PENALTIES, SHARP_TURN_PENALTY } from './constants';
import { computeCurvatureRadii, rollingMean } from './curvature';
import { defaultWidthFor } from './surface';
import { resamplePolyline } from './resample';

/**
 * Turn a snapped route plus its attributes into baked `TrackNode`s.
 *
 * Order matters: resample first, then everything else reads off the uniform
 * grid. Computing curvature or gradient on raw geometry produces nonsense,
 * because raw OSM vertex density has nothing to do with the road's shape.
 */

export type BakeInput = {
  polyline: readonly LatLng[];
  mode: TrackMode;
  /** Spans over `polyline` indices describing surface, width and highway type. */
  annotations: readonly RouteAnnotation[];
  junctions: readonly RouteJunction[];
  /**
   * Elevation in meters at each *resampled* node, from a DEM. Must be the same
   * length as the resampled node array — call `resampleForBake` first to find
   * out how many samples the DEM lookup needs.
   */
  elevations: readonly number[];
};

export type BakedTrack = {
  nodes: TrackNode[];
  lengthMeters: number;
  spacingM: number;
};

/**
 * Step one on its own, so a caller can find out where the nodes will be, fetch
 * elevation for exactly those points, and then bake. Splitting it this way is
 * what keeps the DEM lookup to one batch per track.
 */
export const resampleForBake = (
  polyline: readonly LatLng[],
  mode: TrackMode,
): ReturnType<typeof resamplePolyline> =>
  resamplePolyline(polyline, BAKE.nodeSpacingM, mode);

export const bakeNodes = (input: BakeInput): BakedTrack => {
  const { polyline, mode, annotations, junctions, elevations } = input;
  const resampled = resampleForBake(polyline, mode);
  const { points, distances, spacingM, totalLengthM } = resampled;
  const count = points.length;
  const wraps = mode === 'circuit';

  const radii = computeCurvatureRadii(points, spacingM, mode);
  const bearings = computeBearings(points, wraps);
  const gradients = computeGradients(elevations, spacingM, wraps, count);
  const attributes = mapAttributes(polyline, annotations, distances);
  const junctionPenalties = mapJunctions(polyline, junctions, distances, totalLengthM, wraps);

  const nodes: TrackNode[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const point = points[i] as LatLng;
    const attribute = attributes[i] as NodeAttributes;
    nodes[i] = {
      distance: distances[i] as number,
      lat: point.lat,
      lng: point.lng,
      bearing: bearings[i] as number,
      curvatureRadius: radii[i] as number,
      gradient: gradients[i] as number,
      surface: attribute.surface,
      surfaceConfidence: attribute.confidence,
      widthMeters: attribute.widthMeters,
      junctionPenalty: junctionPenalties[i] as number,
      // Elevation comes straight from the DEM, never from route geometry —
      // OSM ways carry no height, and inferring it produces flat trails.
      elevation: elevations[i] ?? 0,
    };
  }

  return { nodes, lengthMeters: totalLengthM, spacingM };
};

const computeBearings = (points: readonly LatLng[], wraps: boolean): number[] => {
  const count = points.length;
  const bearings: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const nextIndex = i + 1 >= count ? (wraps ? 0 : i - 1) : i + 1;
    // The final node of a point-to-point route has no node after it, so it
    // inherits the bearing of the segment that arrives at it.
    const [from, to] =
      i + 1 >= count && !wraps
        ? [points[nextIndex] as LatLng, points[i] as LatLng]
        : [points[i] as LatLng, points[nextIndex] as LatLng];
    bearings[i] = bearingDegrees(from, to);
  }
  return bearings;
};

/**
 * Gradient from the DEM, smoothed first. SRTM is 30m-posted and noisy at the
 * meter scale; differentiating raw samples 5m apart yields 20% grades on a
 * flat road. Smooth, then take a central difference, then clamp.
 */
const computeGradients = (
  elevations: readonly number[],
  spacingM: number,
  wraps: boolean,
  count: number,
): number[] => {
  if (elevations.length !== count) {
    // A caller that got the sample count wrong gets a flat track rather than a
    // silently misaligned one.
    return new Array<number>(count).fill(0);
  }

  const smoothed = rollingMean(elevations, BAKE.elevationMeanWindow, wraps);
  const gradients: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const previous = wraps ? (i - 1 + count) % count : Math.max(0, i - 1);
    const next = wraps ? (i + 1) % count : Math.min(count - 1, i + 1);
    const run = (next === previous ? 1 : next > previous ? next - previous : count + next - previous) * spacingM;
    const rise = (smoothed[next] as number) - (smoothed[previous] as number);
    gradients[i] = clamp(rise / run, -BAKE.maxAbsGradient, BAKE.maxAbsGradient);
  }
  return gradients;
};

type NodeAttributes = {
  surface: SurfaceType;
  confidence: TrackNode['surfaceConfidence'];
  widthMeters: number;
};

/**
 * Annotations are spans over the *source* polyline's indices; nodes live on the
 * resampled grid. Convert the spans to distance ranges once, then walk both in
 * order rather than searching per node.
 */
const mapAttributes = (
  polyline: readonly LatLng[],
  annotations: readonly RouteAnnotation[],
  distances: readonly number[],
): NodeAttributes[] => {
  const fallback: NodeAttributes = {
    surface: 'asphalt',
    confidence: 'inferred',
    widthMeters: BAKE.defaultWidthM,
  };
  if (annotations.length === 0) return distances.map(() => fallback);

  const sourceDistances = cumulativeDistances(polyline);
  const spans = annotations
    .map((annotation) => ({
      startM: sourceDistances[annotation.startIndex] ?? 0,
      endM: sourceDistances[annotation.endIndex] ?? (sourceDistances[sourceDistances.length - 1] as number),
      attributes: {
        surface: annotation.surface,
        confidence: annotation.surfaceConfidence,
        widthMeters:
          annotation.widthMeters > 0 ? annotation.widthMeters : defaultWidthFor(annotation.surface),
      } satisfies NodeAttributes,
    }))
    .sort((a, b) => a.startM - b.startM);

  const out: NodeAttributes[] = new Array(distances.length);
  let cursor = 0;
  for (let i = 0; i < distances.length; i++) {
    const distance = distances[i] as number;
    while (cursor < spans.length - 1 && (spans[cursor] as { endM: number }).endM < distance) {
      cursor += 1;
    }
    out[i] = (spans[cursor] as { attributes: NodeAttributes }).attributes;
  }
  return out;
};

/**
 * Junction speed caps, ramped in over `junctionInfluenceM` either side so a
 * racer brakes for a set of lights instead of hitting a wall of speed limit at
 * one node. Where two junctions overlap, the tighter cap wins.
 */
const mapJunctions = (
  polyline: readonly LatLng[],
  junctions: readonly RouteJunction[],
  distances: readonly number[],
  totalLengthM: number,
  wraps: boolean,
): number[] => {
  const penalties = new Array<number>(distances.length).fill(1);
  if (junctions.length === 0) return penalties;

  const sourceDistances = cumulativeDistances(polyline);

  for (const junction of junctions) {
    const atM = sourceDistances[junction.atIndex];
    if (atM === undefined) continue;
    const penalty = penaltyFor(junction);
    if (penalty >= 1) continue;

    for (let i = 0; i < distances.length; i++) {
      const separation = arcDistance(distances[i] as number, atM, totalLengthM, wraps);
      if (separation > BAKE.junctionInfluenceM) continue;
      // Full penalty at the junction, easing back to no penalty at the edge of
      // its influence.
      const strength = 1 - separation / BAKE.junctionInfluenceM;
      const ramped = 1 - (1 - penalty) * strength;
      if (ramped < (penalties[i] as number)) penalties[i] = ramped;
    }
  }
  return penalties;
};

const penaltyFor = (junction: RouteJunction): number => {
  if (junction.kind !== 'sharp-turn') return JUNCTION_PENALTIES[junction.kind];

  const angle = Math.abs(junction.turnAngleDeg);
  if (angle < SHARP_TURN_PENALTY.minAngleDeg) return 1;
  const t = clamp(
    (angle - SHARP_TURN_PENALTY.minAngleDeg) / (180 - SHARP_TURN_PENALTY.minAngleDeg),
    0,
    1,
  );
  return SHARP_TURN_PENALTY.atMin + (SHARP_TURN_PENALTY.atStraightBack - SHARP_TURN_PENALTY.atMin) * t;
};

/** Separation along the route, taking the short way around on a circuit. */
const arcDistance = (a: number, b: number, totalM: number, wraps: boolean): number => {
  const direct = Math.abs(a - b);
  return wraps ? Math.min(direct, totalM - direct) : direct;
};
