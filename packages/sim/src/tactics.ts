import { clamp01, lerp } from '@anywhererace/core';
import type { Traits } from './traits';
import { TUNING } from './tuning';

/**
 * What a racer decides, given the road and the field.
 *
 * Pure arithmetic, no state and no `Rng`: these return the *odds*, and the tick
 * does the rolling. That split is deliberate. The interesting part of a tactical
 * decision is the number — how much more likely a rider is to attack at the foot
 * of a climb than on a straight, or with a group ten seconds up the road than
 * five minutes — and a function that also consumed randomness could only be
 * tested by running whole races and squinting at the results.
 *
 * Everything here is read once per racer per tick, so it stays arithmetic-only
 * for the same reason the rest of the tick does. See `profile.ts`.
 */

export type AttackSituation = {
  readonly traits: Traits;
  /** 0-1 through the race, for the traits that only engage late. */
  readonly progress: number;
  /** `attackAppeal` at this node: how good a place in the road this is. */
  readonly roadAppeal: number;
  /** How many racers are riding together, this one included. */
  readonly groupSize: number;
  /** Seconds to the group up the road; `Infinity` when there is nobody there. */
  readonly gapToGroupAheadS: number;
};

/**
 * Per-tick probability of committing to an attack.
 *
 * Three multipliers over a small base, and they answer three different
 * questions: *who* (traits), *where* (the course sweep), and *whether it is
 * worth it* (the field). The last of those is the one that was missing — a rider
 * would attack a climb with equal enthusiasm whether the win was two seconds up
 * the road or five minutes gone.
 */
export const attackChance = (situation: AttackSituation): number => {
  const { traits } = situation;

  // Ambition is specifically a late-race trait: a low-percentage move at
  // one-third distance is not ambition, it is impatience, which is aggression.
  const lateness = clamp01(
    (situation.progress - TUNING.traffic.ambitionEngagesAtProgress) /
      Math.max(1 - TUNING.traffic.ambitionEngagesAtProgress, 1e-6),
  );
  const eagerness = clamp01(traits.aggression * 0.5 + traits.ambition * lateness * 0.5);

  return (
    TUNING.tactics.baseAttackPerTick *
    lerp(TUNING.tactics.minAttackMultiplier, TUNING.tactics.maxAttackMultiplier, eagerness) *
    (1 + TUNING.tactics.selectionAppealBonus * clamp01(situation.roadAppeal)) *
    fieldUrge(situation.groupSize, situation.gapToGroupAheadS)
  );
};

/**
 * How much the state of the race, as opposed to the road, argues for going now.
 *
 * 1 means the field gives no reason either way, which is exactly what a lead
 * group with clear road ahead should get: `reachableness` of an infinite gap is
 * zero, so this collapses to the terrain-only behavior it had before any of this
 * was readable.
 */
export const fieldUrge = (groupSize: number, gapToGroupAheadS: number): number => {
  // Close enough to catch is a reason to go; out of sight is a reason not to
  // bother. `clamp01` handles the infinite gap without a special case.
  const reachable = 1 - clamp01(gapToGroupAheadS / TUNING.tactics.hopelessGapS);

  // Who is expected to do the chasing. In a bunch of thirty everyone waits for
  // somebody else to ride; in a group of three there is nobody else to wait for.
  const half = TUNING.tactics.onusHalfGroupSize;
  const onus = half / (half + Math.max(0, groupSize - 1));

  return 1 + TUNING.tactics.bridgeAppeal * reachable * onus;
};

/**
 * Odds that a racer who has just lost the wheel digs to get back on, rather than
 * settling for whatever is left of their race.
 *
 * Ambition is the willingness to spend the effort and composure is whether they
 * still believe it is worth spending — a rider with neither has already decided
 * this is not their day. Below a threshold of reservoir nobody has a chase in
 * them at all, however much they might want one.
 */
export const chaseChance = (traits: Traits, reservoir: number): number =>
  reservoir < TUNING.bunch.dropped.chaseMinReservoir
    ? 0
    : clamp01(traits.ambition * 0.5 + traits.composure * 0.5);

/**
 * How long a turn on the front lasts before the rider swings off.
 *
 * Shortens as the reservoir empties, which is most of what makes the last hour
 * of a long race look different from the first: the same riders rotating through
 * the front, but far faster and at a pace none of them can hold.
 */
/**
 * Shelter depth after the crosswind has had its say.
 *
 * A bunch sheltering itself in still air is a column; in a crosswind the usable
 * air moves diagonally across the road and runs out at the gutter. Only as many
 * riders as the road is wide get the front echelon, and behind them a second
 * forms, further into the gutter with less road to work with, and so on back.
 *
 * Rather than modelling lateral position — the sim is 1D along the route and
 * stays that way — the wind reaches in and resets the depth that counts. Two
 * things make that bite, and both were found by it failing to:
 *
 *   Counting from the start of the racer's *own* echelon rather than capping the
 *   depth. Capping is almost a no-op, because the shelter curve saturates and
 *   holding a rider at four wheels instead of eleven barely moves their tow.
 *
 *   Dividing by which echelon they are in. Without it a rider pushed out of the
 *   front echelon reappears near the front of the next one with nearly the
 *   shelter they started with, and a full crosswind costs a twenty-rider bunch
 *   nothing measurable.
 *
 * Interpolated in with the strength of the crosswind rather than switched on, so
 * a wind getting up strings a field out progressively.
 */
export const echelonDepth = (
  depth: number,
  crossMs: number,
  widthInVehicles: number,
): number => {
  const severity = clamp01(
    (crossMs - TUNING.draft.echelonOnsetMs) /
      Math.max(TUNING.draft.echelonFullMs - TUNING.draft.echelonOnsetMs, 1e-6),
  );
  if (severity <= 0) return depth;

  const capacity = Math.max(1, widthInVehicles * TUNING.draft.echelonRidersPerWidth);
  if (depth <= capacity) return depth;

  // `%` and `Math.floor` on doubles are both exactly specified, so this stays as
  // reproducible as the rest of the tick.
  const echelon = Math.floor(depth / capacity);
  const inEchelon = depth - echelon * capacity;
  const compromised = inEchelon / (1 + echelon);

  return depth + (compromised - depth) * severity;
};

export const pullLengthS = (reservoir: number): number =>
  TUNING.bunch.pull.durationS *
  lerp(TUNING.bunch.pull.emptyDurationScale, 1, clamp01(reservoir));
