import type { RacerId } from '@anywhererace/core';
import { TUNING } from './tuning';

/**
 * The shape of the field, as the *tick* needs it.
 *
 * This is the behavioral counterpart to `groups.ts`, and the two are
 * deliberately separate modules answering deliberately different questions.
 *
 *   `groups.ts` asks "what would a commentator call this?" — so it samples once
 *   a second, splits at a loose twelve seconds, and refuses to believe a new
 *   shape until it has survived twenty consecutive samples. All of that lag is
 *   correct for narration and fatal for physics: a rider cannot wait twenty
 *   seconds to find out whether they are still in the slipstream.
 *
 *   This module asks "who am I actually riding with, right now?" — so it is
 *   re-read every tick, with no hysteresis and no confirmation, and its
 *   thresholds are tied to the length of a slipstream rather than to the length
 *   of a sentence.
 *
 * Collapsing them into one would mean choosing a single threshold and a single
 * lag to serve both jobs, and there is no value that is right for either.
 *
 * Nothing here touches an `Rng` — it is pure derivation from distances and
 * speeds. But unlike `groups.ts`, its output *is* read by the tick, so a change
 * to anything in this file moves every result and needs a `SIM_VERSION` bump.
 */

/** The minimum a racer has to be for their place in the bunch to be read. */
export type BunchMember = {
  readonly id: RacerId;
  readonly distanceM: number;
  readonly speedMs: number;
};

/** Where one racer sits in the field, as the tick sees it. */
export type BunchState = {
  /**
   * How many racers ahead are sheltering this one: the length of the unbroken
   * chain of slipstreams reaching forward from their wheel. Zero in clean air.
   *
   * This is the number that makes a bunch a bunch rather than a queue. A rider
   * twentieth in a peloton is sheltered by the whole peloton, not by the wheel
   * in front, and until the tick knew this number it could not tell those two
   * situations apart.
   */
  readonly shelterDepth: number;
  /**
   * The pace of the group this racer is in: the mean speed of its members, in
   * m/s. Equal to the racer's own speed when they are riding alone.
   *
   * The *mean*, and not the speed of the racer on the front, which is what this
   * was first written as. Reading the front makes the group's pace equal to the
   * strongest rider's solo pace, so every rider more than a hang-on headroom
   * slower than the best one in the field is dropped by construction — measured
   * on a 24-rider race, the bunch shattered into twenty individuals inside ten
   * minutes, which is the opposite of the behavior this module exists to
   * produce. A real bunch does not ride at the pace of whoever is on the front;
   * whoever is on the front rides at the pace of the bunch, and then swings off.
   *
   * Taking an aggregate over the whole group also makes the pull symmetric —
   * riders above it are held back, riders below it are dragged along — which is
   * what puts a floor under how fast a group can shed people.
   */
  readonly groupPaceMs: number;
  /** How many racers are riding together, this one included. Never zero. */
  readonly groupSize: number;
  /** True if this racer is setting the pace — no shelter, and no free ride. */
  readonly onFront: boolean;
};

/**
 * A racer with nobody to ride with: no shelter, no pace but their own. What a
 * racer who is not in the field's ordering at all — retired, or already
 * finished — is handed, so the tick never has to reason about a missing state.
 */
export const SOLO_BUNCH: BunchState = {
  shelterDepth: 0,
  groupPaceMs: 0,
  groupSize: 1,
  onFront: true,
};

/**
 * Read the field, front to back, into one `BunchState` per racer.
 *
 * `ordering` must already be sorted front to back and contain only racers still
 * circulating. The caller has both to hand, and re-deriving them here would be a
 * second sort per tick for nothing.
 *
 * A group is a maximal run of racers in which every consecutive road gap is
 * within `cohesionGapS` *and* the whole run fits inside `maxSpanS`. The span cap
 * is what stops a long, evenly strung-out field from being read as one enormous
 * group whose "pace" is set by a racer a minute up the road.
 */
export const readBunch = (ordering: readonly BunchMember[]): Map<RacerId, BunchState> => {
  const states = new Map<RacerId, BunchState>();
  const count = ordering.length;
  if (count === 0) return states;

  // Index of the racer on the front of each racer's group, and the length of
  // the slipstream chain reaching forward from them. Both are zero for the race
  // leader, which is what the zero-initialized arrays already say.
  const frontOf = new Int32Array(count);
  const shelterOf = new Int32Array(count);
  const sizeOf = new Int32Array(count);

  let depth = 0;
  let front = 0;
  let spanFromFrontS = 0;

  for (let i = 1; i < count; i++) {
    const racer = ordering[i] as BunchMember;
    const ahead = ordering[i - 1] as BunchMember;
    // Below walking pace a time gap is meaningless and would explode. This
    // mirrors how `race.ts` converts a distance gap for the traffic model.
    const gapS = (ahead.distanceM - racer.distanceM) / Math.max(racer.speedMs, 1);

    // Two chains, broken at two different gaps. The slipstream ends where the
    // tow physically ends; the group ends rather later, because a rider who has
    // slipped off the wheel is out of the shelter but is still riding with the
    // group and still trying to hold it. That interval — out of the draft but
    // not yet dropped — is where riders are actually lost.
    depth = gapS <= TUNING.draft.maxGapS ? depth + 1 : 0;

    const spanIfJoined = spanFromFrontS + gapS;
    if (gapS > TUNING.bunch.cohesionGapS || spanIfJoined > TUNING.bunch.maxSpanS) {
      front = i;
      spanFromFrontS = 0;
    } else {
      spanFromFrontS = spanIfJoined;
    }

    shelterOf[i] = depth;
    frontOf[i] = front;
  }

  // Size and total speed per group, accumulated against the index of whichever
  // racer leads it — the one identifier every member of a group already shares.
  const speedSumOf = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const frontIndex = frontOf[i] as number;
    sizeOf[frontIndex] = (sizeOf[frontIndex] as number) + 1;
    speedSumOf[frontIndex] =
      (speedSumOf[frontIndex] as number) + (ordering[i] as BunchMember).speedMs;
  }

  for (let i = 0; i < count; i++) {
    const frontIndex = frontOf[i] as number;
    const size = sizeOf[frontIndex] as number;
    states.set((ordering[i] as BunchMember).id, {
      shelterDepth: shelterOf[i] as number,
      groupPaceMs: (speedSumOf[frontIndex] as number) / size,
      groupSize: size,
      onFront: frontIndex === i,
    });
  }

  return states;
};
