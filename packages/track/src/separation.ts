import type {
  SeparationKind,
  SeparationPoint,
  SurfaceType,
  TrackMode,
  TrackNode,
} from '@anywhererace/core';
import { clamp01 } from '@anywhererace/core';
import { BAKE, SEPARATION } from './constants';

/**
 * The separation sweep.
 *
 * One pass over the baked nodes, at course-creation time, looking for stretches
 * of road where a bunch could come apart: climbs, pinch points, technical
 * sections, rough surfaces, and long exposed drags.
 *
 * Three things this deliberately is not:
 *
 *   It is not a prediction. Nothing in `packages/sim` reads the output, no
 *   racer behaves differently because of it, and the same course raced twice
 *   will not necessarily split in the same places — or at all. It is a read on
 *   the *road*, in the same family as corner count and total climb.
 *
 *   It is not weather-aware. The sweep runs when the course is saved, long
 *   before any race bakes a forecast, so the one kind that depends on
 *   conditions — `exposed` — says so in its own copy rather than pretending.
 *
 *   It is not per-class. The thresholds are calibrated for road cycling because
 *   that is the format the question is asked about, and because it is the
 *   strictest case: a bunch of cyclists holds together through things that
 *   would already have strung out a field of cars.
 *
 * It is cheap enough to run unconditionally at bake time — a handful of linear
 * passes over an array that already exists, no allocation per node, and no
 * trigonometry.
 */

export type SweepInput = {
  nodes: readonly TrackNode[];
  mode: TrackMode;
  /** Uniform node spacing. Defaults to the bake spacing every baked track uses. */
  spacingM?: number;
  /** Total route length, needed to express a run that wraps the start line. */
  totalLengthM: number;
};

export const sweepForSeparation = (input: SweepInput): SeparationPoint[] => {
  const { nodes, mode, totalLengthM } = input;
  const spacingM = input.spacingM ?? BAKE.nodeSpacingM;
  const count = nodes.length;
  if (count < 2 || spacingM <= 0) return [];

  const wraps = mode === 'circuit';
  const ctx: SweepContext = { nodes, count, spacingM, wraps, totalLengthM };

  const points = [
    ...findClimbs(ctx),
    ...findNarrows(ctx),
    ...findTechnical(ctx),
    ...findRoughSurfaces(ctx),
    ...findExposed(ctx),
  ];

  // Rank, keep the best, then present in the order they are ridden — a race
  // director reads a course front to back, but wants the trivial stuff dropped.
  return points
    .sort((a, b) => b.severity - a.severity)
    .slice(0, SEPARATION.maxPoints)
    .sort((a, b) => a.startM - b.startM);
};

type SweepContext = {
  readonly nodes: readonly TrackNode[];
  readonly count: number;
  readonly spacingM: number;
  readonly wraps: boolean;
  readonly totalLengthM: number;
};

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * A contiguous stretch of nodes, inclusive at both ends. On a circuit a run may
 * wrap the start line, in which case `endIndex < startIndex`.
 */
type Run = { startIndex: number; endIndex: number };

const runNodeCount = (run: Run, count: number): number =>
  run.endIndex >= run.startIndex
    ? run.endIndex - run.startIndex + 1
    : count - run.startIndex + run.endIndex + 1;

const runIndices = (run: Run, count: number): number[] => {
  const total = runNodeCount(run, count);
  const indices: number[] = new Array(total);
  for (let k = 0; k < total; k++) indices[k] = (run.startIndex + k) % count;
  return indices;
};

/**
 * Length of a run in meters. Measured across the *gaps* between its nodes, not
 * across the nodes themselves — a run of one node is a point, not 5m of road.
 */
const runLengthM = (run: Run, ctx: SweepContext): number =>
  (runNodeCount(run, ctx.count) - 1) * ctx.spacingM;

/**
 * Every maximal stretch over which `holds` is true.
 *
 * On a circuit, a stretch that touches both ends of the array is one feature
 * that happens to straddle the start line, not two. Without the merge, a climb
 * placed across a circuit's start/finish would be reported as a short ramp at
 * 0km and another one at the far end of the lap — which is not what is on the
 * ground, and reads as a bug the first time a user sees it.
 */
const findRuns = (ctx: SweepContext, holds: (index: number) => boolean): Run[] => {
  const { count, wraps } = ctx;
  const runs: Run[] = [];
  let start: number | undefined;

  for (let i = 0; i < count; i++) {
    if (holds(i)) {
      if (start === undefined) start = i;
    } else if (start !== undefined) {
      runs.push({ startIndex: start, endIndex: i - 1 });
      start = undefined;
    }
  }
  if (start !== undefined) runs.push({ startIndex: start, endIndex: count - 1 });

  if (wraps && runs.length > 1) {
    const first = runs[0] as Run;
    const last = runs[runs.length - 1] as Run;
    if (first.startIndex === 0 && last.endIndex === count - 1) {
      runs.shift();
      runs.pop();
      runs.push({ startIndex: last.startIndex, endIndex: first.endIndex });
    }
  }

  // The whole lap qualifying is not a separation point, it is the course. This
  // is the flat-and-featureless circuit whose every node is "exposed".
  return runs.filter((run) => runNodeCount(run, count) < count);
};

/**
 * `startM`/`endM` for a run. A run that wraps a circuit's start line reports an
 * `endM` past the lap length rather than one that reads as being behind its own
 * start; `SeparationPoint` documents this.
 */
const spanOf = (run: Run, ctx: SweepContext): { startM: number; endM: number } => {
  const startM = (ctx.nodes[run.startIndex] as TrackNode).distance;
  const rawEndM = (ctx.nodes[run.endIndex] as TrackNode).distance;
  return {
    startM,
    endM: rawEndM >= startM ? rawEndM : rawEndM + ctx.totalLengthM,
  };
};

/** Weighted blend of a feature's defining quantity and how long it goes on for. */
const blend = (primary: number, lengthTerm: number, primaryWeight: number): number =>
  clamp01(primary * primaryWeight + lengthTerm * (1 - primaryWeight));

const normalize = (value: number, from: number, to: number): number =>
  to === from ? 0 : clamp01((value - from) / (to - from));

const point = (
  kind: SeparationKind,
  run: Run,
  ctx: SweepContext,
  severity: number,
  detail: string,
): SeparationPoint => ({ ...spanOf(run, ctx), kind, severity, detail });

// ---------------------------------------------------------------------------
// Climbs
// ---------------------------------------------------------------------------

const findClimbs = (ctx: SweepContext): SeparationPoint[] => {
  const { nodes } = ctx;
  const runs = findRuns(ctx, (i) => (nodes[i] as TrackNode).gradient >= SEPARATION.minClimbGradient);
  const points: SeparationPoint[] = [];

  for (const run of runs) {
    const lengthM = runLengthM(run, ctx);
    if (lengthM < SEPARATION.minClimbLengthM) continue;

    const indices = runIndices(run, ctx.count);
    let gradientSum = 0;
    for (const index of indices) gradientSum += (nodes[index] as TrackNode).gradient;
    const meanGradient = gradientSum / indices.length;

    // Length and gradient can both pass while the climb gains almost nothing.
    const gainM = meanGradient * lengthM;
    if (gainM < SEPARATION.minClimbGainM) continue;

    const severity = blend(
      normalize(meanGradient, SEPARATION.minClimbGradient, SEPARATION.fullClimbGradient),
      normalize(lengthM, SEPARATION.minClimbLengthM, SEPARATION.fullClimbLengthM),
      SEPARATION.climbGradientWeight,
    );

    points.push(
      point(
        'climb',
        run,
        ctx,
        severity,
        `${(meanGradient * 100).toFixed(1)}% for ${formatDistance(lengthM)}, ${Math.round(gainM)}m of climbing`,
      ),
    );
  }

  return points;
};

// ---------------------------------------------------------------------------
// Narrows
// ---------------------------------------------------------------------------

const findNarrows = (ctx: SweepContext): SeparationPoint[] => {
  const { nodes } = ctx;
  const runs = findRuns(
    ctx,
    (i) => (nodes[i] as TrackNode).widthMeters <= SEPARATION.narrowWidthM,
  );
  const points: SeparationPoint[] = [];

  for (const run of runs) {
    const lengthM = runLengthM(run, ctx);
    if (lengthM < SEPARATION.minNarrowLengthM) continue;

    let tightestM = Infinity;
    for (const index of runIndices(run, ctx.count)) {
      const width = (nodes[index] as TrackNode).widthMeters;
      if (width < tightestM) tightestM = width;
    }

    const severity = blend(
      normalize(tightestM, SEPARATION.narrowWidthM, SEPARATION.fullNarrowWidthM),
      normalize(lengthM, SEPARATION.minNarrowLengthM, SEPARATION.fullNarrowLengthM),
      SEPARATION.narrowWidthWeight,
    );

    points.push(
      point(
        'narrows',
        run,
        ctx,
        severity,
        `down to ${tightestM.toFixed(1)}m wide for ${formatDistance(lengthM)}`,
      ),
    );
  }

  return points;
};

// ---------------------------------------------------------------------------
// Technical sections
// ---------------------------------------------------------------------------

/**
 * Corners and junctions in quick succession.
 *
 * Density rather than runs: a single hairpin is not a selection point, and a
 * run-based test would either find every corner on the course or none of them.
 * What strings a bunch out is *repeated* braking, so the test is how much of a
 * rolling window is spent slowing down.
 */
const findTechnical = (ctx: SweepContext): SeparationPoint[] => {
  const { nodes, count, wraps } = ctx;

  const isTechnical = (index: number): boolean => {
    const node = nodes[index] as TrackNode;
    return (
      node.curvatureRadius <= SEPARATION.technicalRadiusM ||
      node.junctionPenalty <= SEPARATION.technicalJunctionPenalty
    );
  };

  const windowNodes = Math.max(1, Math.round(SEPARATION.technicalWindowM / ctx.spacingM));
  if (!wraps && windowNodes >= count) return [];

  const density: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    let technical = 0;
    let sampled = 0;
    for (let k = 0; k < windowNodes; k++) {
      const index = i + k;
      if (!wraps && index >= count) break;
      if (isTechnical(index % count)) technical += 1;
      sampled += 1;
    }
    density[i] = sampled === 0 ? 0 : technical / sampled;
  }

  const runs = findRuns(ctx, (i) => (density[i] as number) >= SEPARATION.minTechnicalDensity);
  const points: SeparationPoint[] = [];

  for (const run of runs) {
    const indices = runIndices(run, count);
    // The window looks forward, so the stretch extends past the last node whose
    // window qualified. Without this the reported section stops short of the
    // corners that put it over the threshold in the first place.
    const extended: Run = {
      startIndex: run.startIndex,
      endIndex: (run.endIndex + windowNodes - 1) % count,
    };
    const lengthM = runLengthM(extended, ctx);

    let peakDensity = 0;
    for (const index of indices) {
      const value = density[index] as number;
      if (value > peakDensity) peakDensity = value;
    }

    // Distinct features, not technical nodes: one long roundabout should read
    // as one thing, not as thirty.
    const features = countFeatures(extended, ctx, isTechnical);
    if (features < 2) continue;

    const severity = normalize(peakDensity, SEPARATION.minTechnicalDensity, 1);

    points.push(
      point(
        'technical',
        extended,
        ctx,
        severity,
        `${features} corners and junctions in ${formatDistance(lengthM)}`,
      ),
    );
  }

  return points;
};

/** Maximal sub-stretches of `run` over which `holds` is true. */
const countFeatures = (
  run: Run,
  ctx: SweepContext,
  holds: (index: number) => boolean,
): number => {
  let features = 0;
  let inside = false;
  for (const index of runIndices(run, ctx.count)) {
    const here = holds(index);
    if (here && !inside) features += 1;
    inside = here;
  }
  return features;
};

// ---------------------------------------------------------------------------
// Rough surfaces
// ---------------------------------------------------------------------------

const roughnessOf = (surface: SurfaceType): number | undefined =>
  (SEPARATION.roughSurfaceSeverity as Partial<Record<SurfaceType, number>>)[surface];

const findRoughSurfaces = (ctx: SweepContext): SeparationPoint[] => {
  const { nodes } = ctx;
  const points: SeparationPoint[] = [];

  // Per surface rather than "any rough surface", so a cobbled sector running
  // straight into a gravel one is two sectors with two severities, which is
  // what they are.
  for (const surface of Object.keys(SEPARATION.roughSurfaceSeverity) as SurfaceType[]) {
    const roughness = roughnessOf(surface) as number;
    const runs = findRuns(ctx, (i) => (nodes[i] as TrackNode).surface === surface);

    for (const run of runs) {
      const lengthM = runLengthM(run, ctx);
      if (lengthM < SEPARATION.minRoughLengthM) continue;

      // If any node of the sector was guessed from the highway type rather than
      // tagged, say so — CLAUDE.md is explicit that inferred surface is
      // surfaced to the user as "assumed" rather than presented as fact.
      const assumed = runIndices(run, ctx.count).some(
        (index) => (nodes[index] as TrackNode).surfaceConfidence === 'inferred',
      );

      const severity = blend(
        roughness,
        normalize(lengthM, SEPARATION.minRoughLengthM, SEPARATION.fullRoughLengthM),
        SEPARATION.roughSurfaceWeight,
      );

      points.push(
        point(
          'surface',
          run,
          ctx,
          severity,
          `${formatDistance(lengthM)} of ${assumed ? 'assumed ' : ''}${surface}`,
        ),
      );
    }
  }

  return points;
};

// ---------------------------------------------------------------------------
// Exposed stretches
// ---------------------------------------------------------------------------

/**
 * Long stretches on a constant bearing.
 *
 * The only kind here that is conditional on something the sweep cannot see: a
 * road like this echelons in a crosswind and is a dual carriageway in still
 * air. Its severity is capped and its copy says "in a crosswind" rather than
 * implying the split is coming.
 *
 * Runs are grown greedily from a reference bearing instead of being found with
 * `findRuns`, because the predicate depends on where the stretch started — a
 * road that turns five degrees every kilometer never breaks a node-local test
 * while ending up pointing the other way.
 */
const findExposed = (ctx: SweepContext): SeparationPoint[] => {
  const { nodes, count, wraps } = ctx;
  const points: SeparationPoint[] = [];

  // On a circuit, start the scan at the first change of direction so a stretch
  // straddling the start line is grown as one rather than cut at index 0.
  const origin = wraps ? firstBearingBreak(ctx) : 0;
  const limit = wraps ? count : count - 1;

  let cursor = 0;
  while (cursor < limit) {
    const startIndex = (origin + cursor) % count;
    const reference = (nodes[startIndex] as TrackNode).bearing;

    let span = 1;
    while (cursor + span < limit) {
      const index = (origin + cursor + span) % count;
      const delta = bearingDelta((nodes[index] as TrackNode).bearing, reference);
      if (delta > SEPARATION.exposedBearingToleranceDeg) break;
      span += 1;
    }

    const run: Run = { startIndex, endIndex: (startIndex + span - 1) % count };
    const lengthM = runLengthM(run, ctx);

    if (lengthM >= SEPARATION.minExposedLengthM) {
      const severity =
        SEPARATION.maxExposedSeverity *
        normalize(lengthM, SEPARATION.minExposedLengthM, SEPARATION.fullExposedLengthM);

      points.push(
        point(
          'exposed',
          run,
          ctx,
          severity,
          `${formatDistance(lengthM)} on one bearing — echelon country if there is a crosswind`,
        ),
      );
    }

    cursor += span;
  }

  return points;
};

/** First node whose bearing differs from node 0's, or 0 if the loop is a circle. */
const firstBearingBreak = (ctx: SweepContext): number => {
  const reference = (ctx.nodes[0] as TrackNode).bearing;
  for (let i = 1; i < ctx.count; i++) {
    const delta = bearingDelta((ctx.nodes[i] as TrackNode).bearing, reference);
    if (delta > SEPARATION.exposedBearingToleranceDeg) return i;
  }
  return 0;
};

/** Smallest angle between two compass bearings, 0-180 degrees. */
const bearingDelta = (a: number, b: number): number => {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
};

// ---------------------------------------------------------------------------

const formatDistance = (meters: number): string =>
  meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
