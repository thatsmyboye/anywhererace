import { destinationPoint, err, haversineMeters, ok } from '@anywhererace/core';
import type {
  LatLng,
  Result,
  RoutingProfile,
  RoutingProvider,
  TrackMode,
} from '@anywhererace/core';
import { legPairsFor } from './legs';

/**
 * "Find the nearest legal loop."
 *
 * CLAUDE.md asks for this in the builder, and the reason is one-way networks: a
 * user drops four corners of a city block and finds that three of the four
 * streets run the wrong way. The builder already knows *which* corner is
 * impossible, because the router reports an unroutable leg distinctly from an
 * outage. What was missing is the search — nudging that corner until the loop
 * closes.
 *
 * Three things shape it:
 *
 * 1. **It is a helper, not a solver.** Every candidate costs at least one
 *    request to a free, shared router, so the search is a bounded spiral
 *    outward from the offending waypoint and gives up rather than grinding. A
 *    user who wants an exotic loop can still drag the waypoint themselves.
 *
 * 2. **Nearest genuinely means nearest.** Candidates are tried in order of how
 *    far they move the waypoint, so the first success is the smallest change to
 *    what the user drew. A helper that silently relocated a corner three
 *    hundred meters to save two requests would not be a helper.
 *
 * 3. **An outage is not "no such loop".** If the router stops answering
 *    mid-search that is reported as itself. Telling a user their loop is
 *    impossible because a public service was rate-limiting us would be the
 *    exact lie the fallback rules elsewhere exist to prevent.
 */

export type LoopSearchOptions = {
  /**
   * How far to nudge, in meters, ring by ring. The first is about the slack in
   * a junction; the last is as far as a waypoint can move before it stops
   * being the place the user pointed at, at which point they should move it
   * themselves.
   */
  radiiM: readonly number[];
  /** Directions per ring. Eight is a compass rose; sixteen doubles the cost. */
  bearings: number;
  /**
   * The hardest limit here. Bounded because the router is free, shared and
   * rate-limited, and because a search that took a minute would be abandoned
   * long before it finished anyway.
   */
  maxRequests: number;
};

export const LOOP_SEARCH: LoopSearchOptions = {
  radiiM: [20, 45, 90, 180],
  bearings: 8,
  maxRequests: 60,
};

export type LegalLoopFix = {
  /** Which waypoint to move. */
  waypointIndex: number;
  from: LatLng;
  to: LatLng;
  movedByMeters: number;
  /**
   * Breaks elsewhere in the loop that this move does not touch.
   *
   * Moving one waypoint can only fix the legs that touch it. Two independent
   * breaks need two moves, and saying so is better than either silently fixing
   * half the problem or refusing to fix any of it.
   */
  remainingBreaks: number;
};

export type LegalLoopErrorKind =
  /** Nothing was reported broken, so there is nothing to search for. */
  | 'nothing-to-fix'
  /** Searched the whole budget and every candidate was still unroutable. */
  | 'exhausted'
  /** The router stopped answering. Explicitly not the same as `exhausted`. */
  | 'provider-unavailable'
  | 'aborted';

export type LegalLoopError = {
  kind: LegalLoopErrorKind;
  message: string;
};

export type LegalLoopInput = {
  waypoints: readonly LatLng[];
  mode: TrackMode;
  profile: RoutingProfile;
  routing: RoutingProvider;
  /** `fromIndex` of every leg the builder could not route. */
  failedFromIndices: readonly number[];
  signal?: AbortSignal | undefined;
  /** Called as the search proceeds, for a progress readout. */
  onProgress?: ((tried: number, budget: number) => void) | undefined;
  search?: Partial<LoopSearchOptions> | undefined;
};

export const findNearestLegalLoop = async (
  input: LegalLoopInput,
): Promise<Result<LegalLoopFix, LegalLoopError>> => {
  const options: LoopSearchOptions = { ...LOOP_SEARCH, ...input.search };
  const pairs = legPairsFor(input.waypoints, input.mode);
  const broken = pairs.filter((pair) => input.failedFromIndices.includes(pair.fromIndex));

  if (broken.length === 0) {
    return err({ kind: 'nothing-to-fix', message: 'Every leg of this route already routes.' });
  }

  // Only the endpoints of a broken leg are worth moving: nudging a waypoint
  // that is nowhere near the break cannot change whether the break routes.
  const movable = new Set<number>();
  for (const pair of broken) {
    movable.add(pair.fromIndex);
    movable.add(pair.toIndex);
  }

  const candidates = orderedCandidates([...movable], input.waypoints, options);
  const budget = Math.min(options.maxRequests, candidates.length * 2);
  let requests = 0;

  // One request per (from, to) pair, however many candidates ask for it. A ring
  // of eight candidates around one waypoint shares the legs of its neighbours
  // far more often than it looks.
  const cache = new Map<string, boolean>();

  const routes = async (from: LatLng, to: LatLng): Promise<boolean | 'unavailable'> => {
    const key = `${from.lat.toFixed(6)},${from.lng.toFixed(6)}|${to.lat.toFixed(6)},${to.lng.toFixed(6)}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    requests += 1;
    const result = await input.routing.routeLeg({ from, to, profile: input.profile });
    if (!result.ok && result.error.kind === 'provider-unavailable') return 'unavailable';

    cache.set(key, result.ok);
    return result.ok;
  };

  for (const candidate of candidates) {
    if (input.signal?.aborted === true) {
      return err({ kind: 'aborted', message: 'The search was cancelled.' });
    }
    if (requests >= budget) break;

    const moved = input.waypoints.slice();
    moved[candidate.waypointIndex] = candidate.to;
    const touching = legPairsFor(moved, input.mode).filter(
      (pair) =>
        pair.fromIndex === candidate.waypointIndex || pair.toIndex === candidate.waypointIndex,
    );

    let allRoute = true;
    for (const pair of touching) {
      const outcome = await routes(pair.from, pair.to);
      if (outcome === 'unavailable') {
        return err({
          kind: 'provider-unavailable',
          message:
            'The routing service stopped responding while searching, so this is not an answer about your loop. Try again shortly.',
        });
      }
      if (!outcome) {
        allRoute = false;
        break;
      }
    }

    input.onProgress?.(Math.min(requests, budget), budget);
    if (!allRoute) continue;

    const untouched = broken.filter(
      (pair) =>
        pair.fromIndex !== candidate.waypointIndex && pair.toIndex !== candidate.waypointIndex,
    );
    return ok({
      waypointIndex: candidate.waypointIndex,
      from: input.waypoints[candidate.waypointIndex] as LatLng,
      to: candidate.to,
      movedByMeters: candidate.movedByMeters,
      remainingBreaks: untouched.length,
    });
  }

  return err({
    kind: 'exhausted',
    message: `No legal loop was found within ${options.radiiM[options.radiiM.length - 1] ?? 0}m of the waypoints in question. Try moving one further by hand, or switch the routing profile.`,
  });
};

type Candidate = { waypointIndex: number; to: LatLng; movedByMeters: number };

/**
 * Every candidate position, nearest first.
 *
 * Sorted across waypoints rather than within them, so a 20m nudge of the
 * *second* endpoint is tried before a 180m relocation of the first. The user
 * cares how far their drawing moved, not which corner moved.
 */
const orderedCandidates = (
  waypointIndices: readonly number[],
  waypoints: readonly LatLng[],
  options: LoopSearchOptions,
): Candidate[] => {
  const candidates: Candidate[] = [];

  for (const waypointIndex of waypointIndices) {
    const origin = waypoints[waypointIndex];
    if (origin === undefined) continue;
    for (const radiusM of options.radiiM) {
      for (let step = 0; step < options.bearings; step++) {
        const bearingDeg = (360 / options.bearings) * step;
        const to = destinationPoint(origin, bearingDeg, radiusM);
        candidates.push({ waypointIndex, to, movedByMeters: haversineMeters(origin, to) });
      }
    }
  }

  return candidates.sort((a, b) => a.movedByMeters - b.movedByMeters);
};
