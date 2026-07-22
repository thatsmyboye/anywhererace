import { describe, expect, it } from 'vitest';
import type { BunchMember } from '../src/bunch';
import { readBunch } from '../src/bunch';
import { buildTrackProfile } from '../src/profile';
import { TUNING } from '../src/tuning';
import { getVehicleClass } from '../src/data/vehicles';
import { makeSyntheticTrack } from './fixtures';

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
    });
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
