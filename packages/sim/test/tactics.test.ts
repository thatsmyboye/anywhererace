import { describe, expect, it } from 'vitest';
import { attackChance, chaseChance, echelonDepth, fieldUrge, pullLengthS } from '../src/tactics';
import type { AttackSituation } from '../src/tactics';
import { getArchetype, rollTraits } from '../src/traits';
import { createRng } from '@anywhererace/core';
import type { Traits } from '../src/traits';
import { TUNING } from '../src/tuning';

/**
 * The decisions, as numbers.
 *
 * These are the odds the tick rolls against. Testing them here rather than
 * through whole races is the point of `tactics.ts` being pure: an assertion that
 * a rider is three times likelier to attack with a group ten seconds up the road
 * is a statement about a function, and running two hundred races to observe it
 * would be measuring the RNG rather than the model.
 */

const traitsOf = (archetype: string): Traits => {
  const preset = getArchetype(archetype);
  if (preset === undefined) throw new Error(`no archetype ${archetype}`);
  return rollTraits(preset, createRng(`traits:${archetype}`));
};

const situation = (overrides: Partial<AttackSituation> = {}): AttackSituation => ({
  traits: traitsOf('metronome'),
  progress: 0.5,
  roadAppeal: 0,
  groupSize: 12,
  gapToGroupAheadS: Number.POSITIVE_INFINITY,
  ...overrides,
});

describe('reading the road', () => {
  it('a selection point makes an attack markedly likelier than open road', () => {
    const openRoad = attackChance(situation({ roadAppeal: 0 }));
    const hardClimb = attackChance(situation({ roadAppeal: 1 }));

    expect(hardClimb / openRoad).toBeCloseTo(1 + TUNING.tactics.selectionAppealBonus, 6);
  });

  it('appeal outside 0-1 cannot smuggle in an arbitrary multiplier', () => {
    // `severity` is documented as 0-1 and the sweep produces it that way, but a
    // hand-built track is not obliged to.
    expect(attackChance(situation({ roadAppeal: 9 }))).toBe(
      attackChance(situation({ roadAppeal: 1 })),
    );
  });
});

describe('reading the field', () => {
  it('nobody up the road leaves the terrain-only behavior untouched', () => {
    // The lead group. This is what makes the change additive rather than a
    // rewrite: with clear road ahead, the field contributes exactly nothing.
    expect(fieldUrge(12, Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('a group just up the road is a reason to go, and a distant one is not', () => {
    const close = fieldUrge(6, 8);
    const gone = fieldUrge(6, TUNING.tactics.hopelessGapS * 2);

    expect(close).toBeGreaterThan(1.5);
    expect(gone).toBe(1);
  });

  it('the urge to chase falls away as the group grows', () => {
    // The free-rider problem: in a bunch of thirty everyone waits for somebody
    // else to ride, and in a group of three there is nobody else to wait for.
    const pair = fieldUrge(2, 10);
    const small = fieldUrge(6, 10);
    const peloton = fieldUrge(30, 10);

    expect(pair).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(peloton);
    expect(peloton).toBeLessThan(1.5);
  });

  it('a rider alone is never told to wait for the others', () => {
    // groupSize 1 must not divide by zero or produce an onus above one.
    expect(fieldUrge(1, 10)).toBeGreaterThan(1);
    expect(Number.isFinite(fieldUrge(1, 10))).toBe(true);
  });

  it('lifts the odds of attacking without replacing the road or the rider', () => {
    const alone = attackChance(situation({ roadAppeal: 0.5 }));
    const chasing = attackChance({ ...situation({ roadAppeal: 0.5 }), gapToGroupAheadS: 10 });

    expect(chasing).toBeGreaterThan(alone);
    // Still bounded: reading the field is a multiplier on a small base, not a
    // licence to attack every tick.
    expect(chasing).toBeLessThan(0.001);
  });
});

describe('reading the rider', () => {
  it('a Charger attacks far more readily than a Metronome', () => {
    const charger = attackChance(situation({ traits: traitsOf('charger') }));
    const metronome = attackChance(situation({ traits: traitsOf('metronome') }));
    expect(charger).toBeGreaterThan(metronome * 2);
  });

  it('ambition only engages late, and aggression does not wait', () => {
    const closer = traitsOf('closer'); // high ambition, low aggression
    const early = attackChance(situation({ traits: closer, progress: 0.2 }));
    const late = attackChance(situation({ traits: closer, progress: 0.95 }));
    expect(late).toBeGreaterThan(early);
  });
});

describe('chasing back on', () => {
  it('an empty rider has no chase in them however much they want one', () => {
    const willing = traitsOf('closer');
    expect(chaseChance(willing, TUNING.bunch.dropped.chaseMinReservoir - 0.01)).toBe(0);
    expect(chaseChance(willing, 1)).toBeGreaterThan(0);
  });

  it('a Veteran is likelier to dig than a Rookie', () => {
    // Composure is half of it: the Rookie has already decided this is not their
    // day, which is exactly what makes mistakes compound for them elsewhere.
    expect(chaseChance(traitsOf('veteran'), 1)).toBeGreaterThan(
      chaseChance(traitsOf('rookie'), 1),
    );
  });
});

describe('echelons', () => {
  /** A 5m road for a road cyclist: about four riders to an echelon. */
  const ROAD = 5 / 0.65;
  const shelterOf = (depth: number): number => depth / (depth + TUNING.draft.shelterHalfDepth);

  it('still air changes nothing, however deep the bunch', () => {
    for (const depth of [1, 4, 12, 30]) {
      expect(echelonDepth(depth, 0, ROAD)).toBe(depth);
    }
  });

  it('a breeze below the onset is not a crosswind', () => {
    expect(echelonDepth(12, TUNING.draft.echelonOnsetMs - 0.1, ROAD)).toBe(12);
  });

  it('riders inside the first echelon keep their shelter', () => {
    // The front of the echelon is not in the gutter and loses nothing. This is
    // why the effect is invisible in a race result: the field reorganises until
    // almost everyone is here.
    expect(echelonDepth(2, 12, ROAD)).toBe(2);
  });

  it('being caught out past the end of the echelon is expensive', () => {
    // The whole point. A rider one wheel past the width of the road is in the
    // wind, however many riders are nominally ahead of them.
    const sheltered = shelterOf(echelonDepth(3.5, 12, ROAD));
    const gutter = shelterOf(echelonDepth(4.2, 12, ROAD));

    expect(sheltered).toBeGreaterThan(0.7);
    expect(gutter).toBeLessThan(0.2);
  });

  it('each echelon further back is worse off than the one in front', () => {
    // Without this the remainder alone puts a rider pushed out of the front
    // echelon near the front of the next one, with nearly the tow they started
    // with — and a full crosswind costs a bunch nothing at all.
    const second = shelterOf(echelonDepth(1 + ROAD * TUNING.draft.echelonRidersPerWidth, 12, ROAD));
    const third = shelterOf(echelonDepth(1 + 2 * ROAD * TUNING.draft.echelonRidersPerWidth, 12, ROAD));

    expect(third).toBeLessThan(second);
  });

  it('comes on with the wind rather than switching on', () => {
    const onset = TUNING.draft.echelonOnsetMs;
    const full = TUNING.draft.echelonFullMs;
    const half = echelonDepth(12, (onset + full) / 2, ROAD);

    expect(half).toBeLessThan(12);
    expect(half).toBeGreaterThan(echelonDepth(12, full, ROAD));
  });

  it('a wide road shelters more riders than a narrow one', () => {
    const lane = 3 / 0.65;
    const dualCarriageway = 12 / 0.65;
    expect(echelonDepth(8, 12, dualCarriageway)).toBeGreaterThan(echelonDepth(8, 12, lane));
  });

  it('never returns a negative depth, which would invert the shelter curve', () => {
    for (const depth of [0.5, 1, 3.9, 4.1, 7.7, 50]) {
      expect(echelonDepth(depth, 12, ROAD)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('turns on the front', () => {
  it('a tired rider takes a shorter turn than a fresh one', () => {
    expect(pullLengthS(1)).toBeCloseTo(TUNING.bunch.pull.durationS, 6);
    expect(pullLengthS(0)).toBeCloseTo(
      TUNING.bunch.pull.durationS * TUNING.bunch.pull.emptyDurationScale,
      6,
    );
    expect(pullLengthS(0.5)).toBeLessThan(pullLengthS(1));
    expect(pullLengthS(0.5)).toBeGreaterThan(pullLengthS(0));
  });

  it('never returns a turn of zero or less, whatever the reservoir says', () => {
    // A zero-length pull would put a racer into a swing-off on the tick they
    // reached the front, and the group would stall passing the lead around.
    expect(pullLengthS(-5)).toBeGreaterThan(0);
  });
});
