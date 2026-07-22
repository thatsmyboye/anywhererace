import { describe, expect, it } from 'vitest';
import type { GroupEvent } from '../src/events';
import { eventsOfType } from '../src/events';
import type { GroupMember } from '../src/groups';
import { buildGrouping, classifyPass, roleOf } from '../src/groups';
import { createRace, runRace } from '../src/race';
import { TUNING } from '../src/tuning';
import type { RaceInput } from '../src/types';
import { getVehicleClass } from '../src/data/vehicles';
import { makeConfig, makeField, makeSyntheticTrack, manualWeather } from './fixtures';

/**
 * The field's shape, and the noise suppression it exists to make possible.
 *
 * The load-bearing property throughout is that none of this is behavior: these
 * tests assert what gets *said* about a race, never what happens in it. The
 * determinism suite covers the other half — that adding all of this moved no
 * result at all.
 */

/** A field at fixed positions, all doing the same speed. */
const fieldAt = (distances: number[], speedMs = 10): GroupMember[] =>
  distances.map((distanceM, index) => ({
    id: `r${index}`,
    distanceM,
    speedMs,
  }));

describe('buildGrouping', () => {
  it('puts a bunch riding together in one group', () => {
    // Ten riders, five meters apart at 10 m/s: half a second between wheels.
    const grouping = buildGrouping(fieldAt([45, 40, 35, 30, 25, 20, 15, 10, 5, 0]));

    expect(grouping.groups).toHaveLength(1);
    expect(grouping.groups[0]).toHaveLength(10);
    expect(grouping.roles[0]).toBe('peloton');
  });

  it('splits on a gap wider than the threshold', () => {
    const beyond = TUNING.groups.splitGapS * 10 + 50; // comfortably over, at 10 m/s
    const grouping = buildGrouping(fieldAt([beyond + 10, beyond + 5, beyond, 10, 5, 0]));

    expect(grouping.groups).toHaveLength(2);
    expect(grouping.groups[0]).toHaveLength(3);
    expect(grouping.groups[1]).toHaveLength(3);
  });

  it('keeps a group together at a gap just inside the threshold', () => {
    // Every rider one second short of the split gap.
    const step = (TUNING.groups.splitGapS - 1) * 10;
    const grouping = buildGrouping(fieldAt([step * 3, step * 2, step, 0]));
    expect(grouping.groups).toHaveLength(1);
  });

  it('names the largest group the peloton and a small group up the road the lead', () => {
    const gap = TUNING.groups.splitGapS * 10 + 50;
    const grouping = buildGrouping(
      fieldAt([gap * 2 + 5, gap * 2, 20, 15, 10, 5, 0]),
    );

    expect(grouping.roles[0]).toBe('lead');
    expect(grouping.roles[1]).toBe('peloton');
    expect(roleOf(grouping, 'r0')).toBe('lead');
    expect(roleOf(grouping, 'r6')).toBe('peloton');
  });

  it('calls a group behind the peloton dropped', () => {
    const gap = TUNING.groups.splitGapS * 10 + 50;
    const grouping = buildGrouping(fieldAt([20, 15, 10, 5, 0, -gap, -gap - 5]));

    expect(grouping.roles[0]).toBe('peloton');
    expect(grouping.roles[1]).toBe('dropped');
  });

  it('orders identically however the members arrive', () => {
    const members = fieldAt([30, 20, 10, 0]);
    const forwards = buildGrouping(members);
    const backwards = buildGrouping(members.slice().reverse());
    expect(backwards.groups).toEqual(forwards.groups);
  });

  it('breaks a tie on racer id rather than on array order', () => {
    // Two racers on precisely the same meter. Without the tie-break this is
    // whatever Array.prototype.sort happened to do, and the race stops being
    // reproducible.
    const same = [
      { id: 'zulu', distanceM: 100, speedMs: 10 },
      { id: 'alpha', distanceM: 100, speedMs: 10 },
    ];
    expect(buildGrouping(same).groups[0]).toEqual(['alpha', 'zulu']);
    expect(buildGrouping(same.slice().reverse()).groups[0]).toEqual(['alpha', 'zulu']);
  });

  it('handles an empty field and a field of one', () => {
    expect(buildGrouping([]).groups).toEqual([]);
    expect(buildGrouping(fieldAt([0])).groups).toEqual([['r0']]);
  });
});

describe('classifyPass', () => {
  const gap = TUNING.groups.splitGapS * 10 + 50;
  const grouping = buildGrouping(fieldAt([gap + 5, gap, 10, 5, 0]));

  it('calls a pass for the lead a lead change whatever the groups say', () => {
    expect(classifyPass(grouping, 'r1', 'r0', 1)).toBe('lead-change');
  });

  it('calls a shuffle inside one bunch in-group', () => {
    expect(classifyPass(grouping, 'r3', 'r2', 4)).toBe('in-group');
  });

  it('calls a pass across a gap between-groups', () => {
    expect(classifyPass(grouping, 'r2', 'r1', 2)).toBe('between-groups');
  });

  it('falls back to in-group for a racer it has never seen', () => {
    // A pass in the first seconds, before any shape has settled. Reporting it
    // as a between-groups move would be inventing structure that is not there.
    expect(classifyPass(grouping, 'stranger', 'r2', 3)).toBe('in-group');
  });
});

// ---------------------------------------------------------------------------
// Against real races
// ---------------------------------------------------------------------------

const CIRCUIT = makeSyntheticTrack({ lengthM: 2400, mode: 'circuit', curvatureRadius: 90 });

const bikeRace = (overrides: Partial<RaceInput['config']> = {}): RaceInput => ({
  track: CIRCUIT,
  config: makeConfig({
    trackId: CIRCUIT.id,
    laps: 6,
    vehicleClassId: 'road-cyclist',
    racers: makeField({ size: 24 }),
    seed: 'groups-seed-001',
    gridOrder: 'by-skill',
    weather: manualWeather(),
    ...overrides,
  }),
});

const run = (input: RaceInput) => {
  const created = createRace(input);
  if (!created.ok) throw new Error(created.error.message);
  const result = created.value.runToEnd();
  if (!result.ok) throw new Error(result.error.message);
  return created.value.events;
};

describe('a bunch race', () => {
  const events = run(bikeRace());

  it('tags every overtake with how much it is worth saying', () => {
    const passes = eventsOfType(events, 'overtake');
    expect(passes.length).toBeGreaterThan(0);
    for (const pass of passes) {
      expect(['lead-change', 'between-groups', 'in-group']).toContain(pass.significance);
    }
  });

  it('classifies the bulk of a 24-rider race as in-bunch shuffling', () => {
    // This is the whole point. If most passes in a peloton were not in-group,
    // filtering on significance would not quieten the feed and the change
    // would be cosmetic.
    const passes = eventsOfType(events, 'overtake');
    const inGroup = passes.filter((p) => p.significance === 'in-group');
    expect(inGroup.length / passes.length).toBeGreaterThan(0.5);
  });

  it('reports far fewer group moves than passes', () => {
    const passes = eventsOfType(events, 'overtake').length;
    const moves = eventsOfType(events, 'group').length;
    expect(moves).toBeLessThan(passes / 4);
  });

  it('never reports the field forming up off the line as a race move', () => {
    for (const event of eventsOfType(events, 'group')) {
      expect(event.atS).toBeGreaterThanOrEqual(TUNING.groups.settleS);
    }
  });

  it('names a rider for the moves that are about one, and none for the rest', () => {
    for (const event of eventsOfType(events, 'group')) {
      if (event.kind === 'attack' || event.kind === 'bridge' || event.kind === 'dropped') {
        expect(event.racerId).toBeDefined();
      } else {
        expect(event.racerId).toBeUndefined();
      }
    }
  });

  it('gives every group move two non-empty groups and a real gap', () => {
    for (const event of eventsOfType(events, 'group')) {
      expect(event.frontGroup.length).toBeGreaterThan(0);
      expect(event.chaseGroup.length).toBeGreaterThan(0);
      expect(event.gapS).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(event.gapS)).toBe(true);
    }
  });

  it('never puts the same rider in both sides of a move', () => {
    for (const event of eventsOfType(events, 'group')) {
      const front = new Set(event.frontGroup);
      expect(event.chaseGroup.some((id) => front.has(id))).toBe(false);
    }
  });

  it('does not report a move on the tick a rider retires', () => {
    // Someone crashing out gains a rank for everyone behind them without any
    // pair having flipped; the same must be true of the field's shape.
    const retirements = new Set(
      [...eventsOfType(events, 'crash'), ...eventsOfType(events, 'mechanical')].map((e) => e.tick),
    );
    const moveTicks = eventsOfType(events, 'group').map((e) => e.tick);
    for (const tick of moveTicks) expect(retirements.has(tick)).toBe(false);
  });
});

describe('race format', () => {
  it('marks the bunch-racing classes and only those', () => {
    const cycling = ['road-cyclist', 'e-bike'];
    for (const id of cycling) {
      expect(getVehicleClass(id)?.raceFormat).toBe('cycling');
    }
    // The e-scooter shares `micromobility` but at draftBenefit 0.2 never forms
    // a bunch; the open-wheeler tows hard but races one car at a time.
    for (const id of ['e-scooter', 'open-wheel-racer', 'runner', 'gt-racer']) {
      expect(getVehicleClass(id)?.raceFormat).toBe('standard');
    }
  });
});

describe('the shape of the field is observation, not behavior', () => {
  it('produces identical results and identical group events on a re-run', () => {
    const first = run(bikeRace());
    const second = run(bikeRace());

    const movesOf = (events: readonly { type: string }[]) =>
      JSON.stringify(eventsOfType(events as never, 'group') as GroupEvent[]);
    expect(movesOf(second)).toBe(movesOf(first));
  });

  it(
    'reports the same race whether it is stepped or run straight through',
    () => {
      // Group sampling is on a tick multiple, so a host stepping at 1x, 2x and
      // 8x must not see a different race from one that skipped to the end.
      const straight = runRace(bikeRace());
      expect(straight.ok).toBe(true);

      const created = createRace(bikeRace());
      if (!created.ok) throw new Error(created.error.message);
      const chunks = [1, 1, 7, 200, 3, 1000, 13];
      let index = 0;
      while (created.value.step(chunks[index % chunks.length] as number)) index += 1;

      const stepped = created.value.result();
      if (!stepped.ok || !straight.ok) throw new Error('race did not terminate');
      expect(stepped.value.resultHash).toBe(straight.value.resultHash);

      const reference = run(bikeRace());
      expect(JSON.stringify(eventsOfType(created.value.events, 'group'))).toBe(
        JSON.stringify(eventsOfType(reference, 'group')),
      );
    },
    // Three full runs of a 24-rider, six-lap bike race. This sat just inside the
    // default five seconds until the tick started reading the shape of the field
    // — group-shaped drafting costs a little per racer-tick, and a bunch that
    // holds together also keeps more racers circulating to the end.
    30_000,
  );
});
