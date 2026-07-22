import { describe, expect, it } from 'vitest';
import type { BunchMember } from '../src/bunch';
import { readBunch } from '../src/bunch';
import { buildTrackProfile } from '../src/profile';
import { createRace } from '../src/race';
import { TUNING } from '../src/tuning';
import { getVehicleClass } from '../src/data/vehicles';
import { makeConfig, makeField, makeSyntheticTrack } from './fixtures';

/**
 * `bunch.ts` is the one piece of field-shape reading that the tick actually
 * consults, so unlike `groups.ts` it cannot be argued to be harmless. These
 * tests pin the three thresholds that decide who is riding with whom, because
 * every one of them changes race results.
 */

/**
 * A field laid out back from the front at fixed time gaps, all at one speed.
 * Distances are derived from the gaps so the arithmetic under test is the
 * gap-to-group logic and not the caller's mental arithmetic.
 */
const fieldAtGaps = (speedMs: number, gapsS: readonly number[]): BunchMember[] => {
  const members: BunchMember[] = [{ id: 'r00', distanceM: 0, speedMs }];
  let distanceM = 0;
  gapsS.forEach((gapS, index) => {
    distanceM -= gapS * speedMs;
    members.push({ id: `r${String(index + 1).padStart(2, '0')}`, distanceM, speedMs });
  });
  return members;
};

const stateOf = (members: readonly BunchMember[], id: string) => {
  const state = readBunch(members).get(id);
  if (state === undefined) throw new Error(`no state for ${id}`);
  return state;
};

describe('bunch: reading who is riding with whom', () => {
  it('an empty field produces nothing', () => {
    expect(readBunch([]).size).toBe(0);
  });

  it('a lone racer is on the front of a group of one, with no shelter', () => {
    const state = stateOf([{ id: 'r00', distanceM: 100, speedMs: 10 }], 'r00');
    expect(state).toEqual({
      shelterDepth: 0,
      groupPaceMs: 10,
      groupSize: 1,
      onFront: true,
      // Nobody ahead and nobody behind. Infinity rather than a sentinel, because
      // it is the literal answer and it reads correctly everywhere: an infinite
      // gap is never bridgeable and never worth waiting for.
      gapToGroupAheadS: Number.POSITIVE_INFINITY,
      gapToGroupBehindS: Number.POSITIVE_INFINITY,
    });
  });

  it('reports the gaps to the groups either side, and only to those', () => {
    // Three groups: a lone leader, a pair, then a lone straggler.
    const split = TUNING.bunch.cohesionGapS + 2;
    const states = readBunch(fieldAtGaps(10, [split, 0.5, split + 3]));

    // The leader has open road ahead and the pair behind.
    expect(states.get('r00')?.gapToGroupAheadS).toBe(Number.POSITIVE_INFINITY);
    expect(states.get('r00')?.gapToGroupBehindS).toBeCloseTo(split, 6);

    // Both members of the middle group see the same two gaps, because both are
    // facts about the group rather than about either rider in it.
    expect(states.get('r01')?.gapToGroupAheadS).toBeCloseTo(split, 6);
    expect(states.get('r02')?.gapToGroupAheadS).toBeCloseTo(split, 6);
    expect(states.get('r01')?.gapToGroupBehindS).toBeCloseTo(split + 3, 6);
    expect(states.get('r02')?.gapToGroupBehindS).toBeCloseTo(split + 3, 6);

    // The straggler has nobody behind them at all.
    expect(states.get('r03')?.gapToGroupBehindS).toBe(Number.POSITIVE_INFINITY);
  });

  it('shelter depth counts every wheel ahead, not just the one in front', () => {
    // Five riders nose to tail, well inside the slipstream.
    const members = fieldAtGaps(10, [0.5, 0.5, 0.5, 0.5]);
    const states = readBunch(members);

    expect(states.get('r00')?.shelterDepth).toBe(0);
    expect(states.get('r01')?.shelterDepth).toBe(1);
    expect(states.get('r04')?.shelterDepth).toBe(4);
    // This is the whole point of the module: without it the last rider would
    // see the same single wheel the second rider sees.
    expect(states.get('r04')?.groupSize).toBe(5);
  });

  it('the slipstream chain breaks at the draft gap while the group survives to the cohesion gap', () => {
    // One rider sitting between the two thresholds: off the wheel, but still
    // riding with the group. That interval is where riders are actually lost.
    const between = (TUNING.draft.maxGapS + TUNING.bunch.cohesionGapS) / 2;
    const states = readBunch(fieldAtGaps(10, [0.5, between, 0.5]));

    // Chain broken: no tow at all, however many riders are up the road.
    expect(states.get('r02')?.shelterDepth).toBe(0);
    // ...but still one group of four.
    expect(states.get('r02')?.groupSize).toBe(4);
    expect(states.get('r03')?.shelterDepth).toBe(1);
  });

  it('a gap past the cohesion threshold is two groups', () => {
    const states = readBunch(fieldAtGaps(10, [0.5, TUNING.bunch.cohesionGapS + 1, 0.5]));

    expect(states.get('r00')?.groupSize).toBe(2);
    expect(states.get('r01')?.groupSize).toBe(2);
    expect(states.get('r02')?.groupSize).toBe(2);
    expect(states.get('r02')?.onFront).toBe(true);
    expect(states.get('r03')?.onFront).toBe(false);
  });

  it('a long strung-out line is not one enormous group', () => {
    // Every consecutive gap is inside the cohesion threshold, but the line as a
    // whole is far longer than a bunch. Without the span cap all thirty of these
    // would take their pace from a racer minutes up the road.
    const gapS = TUNING.bunch.cohesionGapS - 0.5;
    const nodes = Math.ceil((TUNING.bunch.maxSpanS / gapS) * 3);
    const states = readBunch(fieldAtGaps(10, new Array(nodes).fill(gapS)));

    for (const state of states.values()) {
      expect(state.groupSize).toBeLessThan(nodes + 1);
    }
    expect(states.get('r00')?.groupSize).toBeLessThanOrEqual(
      Math.ceil(TUNING.bunch.maxSpanS / gapS) + 1,
    );
  });

  it('group pace is the average of the group, not the speed of whoever leads it', () => {
    // The distinction the model turns on. Reading the leader makes the group's
    // pace the strongest rider's solo pace, and everyone slower than the hang-on
    // headroom is dropped by construction.
    const members: BunchMember[] = [
      { id: 'r00', distanceM: 0, speedMs: 12 },
      { id: 'r01', distanceM: -5, speedMs: 10 },
      { id: 'r02', distanceM: -10, speedMs: 8 },
    ];
    const states = readBunch(members);

    for (const id of ['r00', 'r01', 'r02']) {
      expect(states.get(id)?.groupPaceMs).toBeCloseTo(10, 6);
    }
  });

  it('reads the same field the same way twice', () => {
    // Determinism has no business depending on Map iteration order or on a sort
    // that is not total, and this is the cheapest possible guard on both.
    const members = fieldAtGaps(11, [0.4, 1.1, 0.6, 3.0, 0.5]);
    expect([...readBunch(members).entries()]).toEqual([...readBunch(members).entries()]);
  });
});

/**
 * Turns on the front.
 *
 * The behavior that replaced a flat shelter credit every member of a group used
 * to receive. The credit had the aggregate right — a bunch rode faster than any
 * of its members could alone — while nobody was ever individually on the front
 * doing the work.
 *
 * What this asserts is that the work now circulates. What it deliberately does
 * *not* assert is that doing it costs you the race, and that is worth writing
 * down: over both a 30-minute circuit and a 50km road race, with an identical
 * field, the riders who spent the most time on the front finished *better*, not
 * worse. The effect is real — a turn on the front is ridden above the rider's
 * own sustainable effort and drains the reservoir quadratically — but it is
 * swamped by the fact that at the front of a bunch, "did the work" and "is ahead
 * on the road" are the same thing. Making fatigue decide races would need a
 * reason for a rider to bury themselves for somebody else, which is team
 * tactics. See IDEAS.md.
 */
describe('bunch: the work circulates', () => {
  const CIRCUIT = makeSyntheticTrack({
    lengthM: 2400,
    mode: 'circuit',
    curvatureRadius: 200,
  });

  /** How many one-second samples each racer spent leading the biggest group. */
  const frontTimeByRacer = (seed: string): Map<string, number> => {
    const created = createRace({
      track: CIRCUIT,
      config: makeConfig({
        trackId: CIRCUIT.id,
        vehicleClassId: 'road-cyclist',
        racers: makeField({ size: 16 }),
        laps: 8,
        seed,
      }),
      // Incidents off: a rider who spins out of the bunch stops taking turns for
      // reasons that have nothing to do with rotation.
      toggles: { incidents: false, mechanicalFailures: false },
    });
    if (!created.ok) throw new Error(created.error.message);
    const race = created.value;

    const samples = new Map<string, number>();
    while (race.step(20)) {
      const members = race
        .snapshot()
        .racers.filter((racer) => racer.status === 'racing')
        .map((racer) => ({
          id: racer.racerId,
          distanceM: racer.distanceAlongRoute,
          speedMs: racer.speedMs,
        }))
        .sort((a, b) => b.distanceM - a.distanceM);
      if (members.length === 0) break;

      const states = readBunch(members);
      // The peloton, meaning the biggest group on the road — not the race
      // leader, who may be up the road alone and taking no turns from anyone.
      let leader = '';
      let biggest = 1;
      for (const member of members) {
        const state = states.get(member.id);
        if (state?.onFront === true && state.groupSize > biggest) {
          biggest = state.groupSize;
          leader = member.id;
        }
      }
      if (leader === '') continue;
      samples.set(leader, (samples.get(leader) ?? 0) + 1);
    }
    return samples;
  };

  it('the front of the peloton changes hands, and no one rider owns it', () => {
    for (const seed of ['rot-1', 'rot-2', 'rot-3']) {
      const front = frontTimeByRacer(seed);
      const counts = [...front.values()];
      const total = counts.reduce((sum, value) => sum + value, 0);
      const most = Math.max(...counts);

      expect(front.size, `seed ${seed}: only ${front.size} riders ever led the bunch`).toBeGreaterThanOrEqual(8);
      expect(
        most / total,
        `seed ${seed}: one rider led ${((most / total) * 100).toFixed(0)}% of the race`,
      ).toBeLessThan(0.65);
    }
  }, 60_000);
});

describe('bunch: reading the course sweep', () => {
  const vehicle = getVehicleClass('road-cyclist');
  if (vehicle === undefined) throw new Error('road-cyclist is missing');

  it('attack appeal covers a separation point and its approach, and nothing else', () => {
    const track = makeSyntheticTrack({ lengthM: 4000 });
    const withSweep = {
      ...track,
      separationPoints: [
        {
          startM: 2000,
          endM: 2400,
          kind: 'climb' as const,
          severity: 0.6,
          detail: 'a test climb',
        },
      ],
    };

    const profile = buildTrackProfile(withSweep, vehicle);
    const appealAt = (distanceM: number): number =>
      profile.attackAppeal[Math.round(distanceM / profile.spacingM)] as number;

    // Well before the approach: nothing to go for.
    expect(appealAt(1000)).toBe(0);
    // Inside the approach, and on the climb itself.
    expect(appealAt(2000 - TUNING.tactics.approachM + 50)).toBeCloseTo(0.6, 6);
    expect(appealAt(2200)).toBeCloseTo(0.6, 6);
    // Over the top, the reason to attack is behind you.
    expect(appealAt(2800)).toBe(0);
  });

  it('a course with no sweep, and a course the sweep cleared, both read as nowhere special', () => {
    const track = makeSyntheticTrack({ lengthM: 2000 });
    const unswept = buildTrackProfile(track, vehicle);
    const swept = buildTrackProfile({ ...track, separationPoints: [] }, vehicle);

    // The two mean different things to the UI — "nobody looked" against "we
    // looked and it is flat" — but they mean the same thing to a racer choosing
    // where to go, which is: nothing.
    expect([...unswept.attackAppeal]).toEqual([...swept.attackAppeal]);
    expect([...swept.attackAppeal].every((value) => value === 0)).toBe(true);
  });
});
