import type { LatLng, TrackMode } from '@anywhererace/core';

/**
 * The leg model: how a list of waypoints becomes a list of routable spans.
 *
 * Its own module because three unrelated things need exactly the same answer —
 * the builder drawing the route, the legal-loop search testing candidate
 * positions, and the bake re-routing everything at full detail — and any
 * disagreement between them shows up as a track that draws one shape and races
 * another.
 */

export type LegPair = {
  fromIndex: number;
  /** Wraps to 0 for a circuit's closing leg. */
  toIndex: number;
  from: LatLng;
  to: LatLng;
};

export const legPairsFor = (waypoints: readonly LatLng[], mode: TrackMode): LegPair[] => {
  const pairs: LegPair[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    pairs.push({
      fromIndex: i - 1,
      toIndex: i,
      from: waypoints[i - 1] as LatLng,
      to: waypoints[i] as LatLng,
    });
  }
  // The closing leg is where one-way networks bite: three sides of a block can
  // route perfectly and the fourth be impossible in that direction.
  if (mode === 'circuit' && waypoints.length > 2) {
    pairs.push({
      fromIndex: waypoints.length - 1,
      toIndex: 0,
      from: waypoints[waypoints.length - 1] as LatLng,
      to: waypoints[0] as LatLng,
    });
  }
  return pairs;
};

/**
 * Where a waypoint inserted into this leg belongs in the list.
 *
 * A new waypoint takes the position of the leg's far end and pushes that one
 * and everything after it along — so splitting the leg from waypoint 2 to
 * waypoint 3 puts the new one at index 3.
 *
 * The closing leg of a circuit is the exception worth stating: it runs from the
 * last waypoint back to the first, and "between them" is the *end* of the list,
 * not the start. Inserting at 0 there would move the start line instead of
 * reopening the loop, which is a different edit entirely and not the one the
 * user asked for by grabbing that handle.
 */
export const insertIndexForLeg = (leg: Pick<LegPair, 'toIndex'>, waypointCount: number): number =>
  leg.toIndex === 0 ? waypointCount : leg.toIndex;
