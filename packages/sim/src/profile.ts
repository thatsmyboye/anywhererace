import type { Track, TrackNode, WeatherSpec } from '@anywhererace/core';
import { GRAVITY_MS2, conditionsAt, degToRad, kphToMs } from '@anywhererace/core';
import type { VehicleClass } from './data/vehicles';
import { TUNING } from './tuning';

/**
 * Everything that can be computed once, before the first tick, is computed
 * here.
 *
 * Two reasons, and the second one matters more:
 *
 * 1. Speed. A 40-racer, 50-lap race is millions of tick-racer evaluations;
 *    re-deriving a corner limit inside that loop is wasteful.
 *
 * 2. Determinism. `Math.sin`, `Math.cos`, `Math.log` and `Math.pow` are all
 *    "implementation-approximated" in the ECMAScript spec, so two engines may
 *    legally disagree in the last bit. Every one of them is confined to this
 *    file and to track baking, both of which run a bounded number of times
 *    before the race starts. Inside the tick the only non-arithmetic operation
 *    is `Math.sqrt`, which every real engine implements with the correctly
 *    rounded hardware instruction.
 */

export type TrackProfile = {
  readonly nodes: readonly TrackNode[];
  readonly lapLengthM: number;
  /** Uniform node spacing produced by the baker, in meters. */
  readonly spacingM: number;

  /**
   * Per node, the fastest speed a racer of this class could be doing *at* that
   * node — the lesser of the cornering limit and any junction cap. Straights
   * are effectively unbounded here; the power-limited term caps them.
   */
  readonly cornerLimitMs: Float64Array;

  /**
   * Per node, the fastest speed a racer could be doing at that node and still
   * scrub to every corner limit ahead of it. This is the braking profile, and
   * it is what makes an open-wheel car brake at the board rather than at the
   * apex.
   */
  readonly brakingLimitMs: Float64Array;

  /** Unit heading components per node, for the wind dot product. */
  readonly headingNorth: Float64Array;
  readonly headingEast: Float64Array;

  /** Per node, the class's surface speed multiplier. Folded in once. */
  readonly surfaceSpeedScale: Float64Array;

  /** Per node, usable width expressed in vehicle widths. */
  readonly widthInVehicles: Float64Array;
};

/**
 * Baked wind, as north/east components in m/s at each weather sample. Sampling
 * the direction here rather than in the tick keeps trigonometry out of the hot
 * loop entirely — and interpolating the vector is more correct than
 * interpolating the bearing anyway.
 */
export type WindProfile = {
  readonly offsetsS: Float64Array;
  readonly north: Float64Array;
  readonly east: Float64Array;
};

export const buildTrackProfile = (track: Track, vehicle: VehicleClass): TrackProfile => {
  const nodes = track.nodes;
  const count = nodes.length;
  const lapLengthM = track.lengthMeters;
  // Read the spacing off the baked nodes rather than deriving it from the node
  // count: a circuit omits the duplicate closing node and a point-to-point
  // course keeps its final one, so count-based arithmetic is off by one for
  // exactly one of the two modes.
  const spacingM =
    count > 1
      ? (nodes[1] as TrackNode).distance - (nodes[0] as TrackNode).distance
      : lapLengthM;

  const topSpeedMs = kphToMs(vehicle.topSpeedKph);
  const cornerLimitMs = new Float64Array(count);
  const headingNorth = new Float64Array(count);
  const headingEast = new Float64Array(count);
  const surfaceSpeedScale = new Float64Array(count);
  const widthInVehicles = new Float64Array(count);

  for (let i = 0; i < count; i++) {
    const node = nodes[i] as TrackNode;
    const surfaceScale = vehicle.surfacePenalty[node.surface];

    // Radii above the straight threshold are treated as straight. Without this
    // an `Infinity` radius propagates an `Infinity` speed limit, which is fine
    // arithmetically but makes every downstream min() harder to reason about.
    const radius = Math.min(node.curvatureRadius, TUNING.cornering.straightRadiusM);

    // Cornering limit. Surface affects grip as well as speed, so it appears
    // inside the sqrt via the grip product.
    const gripG = vehicle.lateralGripG * surfaceScale;
    const corner = Math.sqrt(gripG * GRAVITY_MS2 * radius);

    // A junction — signals, a stop, a right-angle turn the router flagged —
    // caps speed regardless of how much grip is available. This is what makes
    // a technically legal but turn-heavy route *feel* like one.
    const junctionCap = topSpeedMs * node.junctionPenalty;

    cornerLimitMs[i] = Math.min(corner, junctionCap);
    surfaceSpeedScale[i] = surfaceScale;
    widthInVehicles[i] = node.widthMeters / vehicle.widthMeters;

    const bearingRad = degToRad(node.bearing);
    headingNorth[i] = Math.cos(bearingRad);
    headingEast[i] = Math.sin(bearingRad);
  }

  return {
    nodes,
    lapLengthM,
    spacingM,
    cornerLimitMs,
    brakingLimitMs: buildBrakingProfile(cornerLimitMs, spacingM, vehicle.brakingMs2, track.mode),
    headingNorth,
    headingEast,
    surfaceSpeedScale,
    widthInVehicles,
  };
};

/**
 * Backward pass: the speed at node i is capped by what the racer can still
 * scrub off before the next corner, i.e. `sqrt(v_next^2 + 2*a*spacing)`.
 *
 * On a circuit the constraint wraps, so we run the loop twice around and stop
 * early once nothing changes. Two passes is always enough in practice because
 * the braking distance from the fastest point on any real track is far shorter
 * than a lap, but the convergence check means a pathological track cannot
 * produce a wrong profile — only a slower build.
 */
const buildBrakingProfile = (
  cornerLimitMs: Float64Array,
  spacingM: number,
  brakingMs2: number,
  mode: Track['mode'],
): Float64Array => {
  const count = cornerLimitMs.length;
  const limit = new Float64Array(cornerLimitMs);
  const wraps = mode === 'circuit';
  const maxSweeps = wraps ? 3 : 1;
  // v^2 = u^2 + 2*a*s, rearranged: how much faster you may be one node earlier.
  const gainSquared = 2 * brakingMs2 * spacingM;

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let changed = false;
    for (let step = count - 1; step >= 0; step--) {
      const next = step + 1;
      const nextIndex = next >= count ? (wraps ? 0 : count - 1) : next;
      if (nextIndex === step) continue;
      const nextLimit = limit[nextIndex] as number;
      const allowed = Math.sqrt(nextLimit * nextLimit + gainSquared);
      const current = limit[step] as number;
      if (allowed < current) {
        limit[step] = allowed;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return limit;
};

export const buildWindProfile = (weather: WeatherSpec, durationS: number): WindProfile => {
  // A manual spec is one constant sample; a live spec keeps its baked timeline.
  const offsets =
    weather.kind === 'manual'
      ? [0]
      : weather.timeline.map((s) => s.atOffsetS);

  // Always bracket the race so `windAt` never has to extrapolate.
  if ((offsets[offsets.length - 1] ?? 0) < durationS) offsets.push(durationS);

  const offsetsS = new Float64Array(offsets.length);
  const north = new Float64Array(offsets.length);
  const east = new Float64Array(offsets.length);

  for (let i = 0; i < offsets.length; i++) {
    const offset = offsets[i] as number;
    const conditions = conditionsAt(weather, offset);
    // Meteorological convention: `windFromDegrees` is where it blows FROM, so
    // the direction it pushes a racer is 180 degrees around.
    const blowingToRad = degToRad(conditions.windFromDegrees + 180);
    offsetsS[i] = offset;
    north[i] = conditions.windSpeedMs * Math.cos(blowingToRad);
    east[i] = conditions.windSpeedMs * Math.sin(blowingToRad);
  }

  return { offsetsS, north, east };
};

/** Interpolated wind vector at `elapsedS`. Pure arithmetic. */
export const windAt = (
  profile: WindProfile,
  elapsedS: number,
): { north: number; east: number } => {
  const offsets = profile.offsetsS;
  const last = offsets.length - 1;
  if (last <= 0) return { north: profile.north[0] ?? 0, east: profile.east[0] ?? 0 };
  if (elapsedS <= (offsets[0] as number)) {
    return { north: profile.north[0] as number, east: profile.east[0] as number };
  }
  if (elapsedS >= (offsets[last] as number)) {
    return { north: profile.north[last] as number, east: profile.east[last] as number };
  }
  for (let i = 1; i <= last; i++) {
    const b = offsets[i] as number;
    if (b < elapsedS) continue;
    const a = offsets[i - 1] as number;
    const span = b - a;
    const t = span === 0 ? 0 : (elapsedS - a) / span;
    const n0 = profile.north[i - 1] as number;
    const n1 = profile.north[i] as number;
    const e0 = profile.east[i - 1] as number;
    const e1 = profile.east[i] as number;
    return { north: n0 + (n1 - n0) * t, east: e0 + (e1 - e0) * t };
  }
  return { north: profile.north[last] as number, east: profile.east[last] as number };
};

/**
 * Node index for a distance measured in *race* coordinates, where 0 is the
 * start line. Wraps for circuits.
 */
export const nodeIndexAt = (
  profile: TrackProfile,
  startLineM: number,
  raceDistanceM: number,
): number => {
  const count = profile.nodes.length;
  if (count === 0) return 0;
  const lap = profile.lapLengthM;
  let alongRoute = (startLineM + raceDistanceM) % lap;
  if (alongRoute < 0) alongRoute += lap;
  const index = Math.floor(alongRoute / profile.spacingM);
  return index < 0 ? 0 : index >= count ? count - 1 : index;
};
