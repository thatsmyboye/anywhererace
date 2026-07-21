import { describe, expect, it } from 'vitest';
import { eventsOfType } from '../src/events';
import { createRace, runRace } from '../src/race';
import type { RaceInput } from '../src/types';
import { makeConfig, makeField, makeSyntheticTrack, manualWeather } from './fixtures';

const circuitInput = (overrides: Partial<RaceInput['config']> = {}): RaceInput => {
  const track = makeSyntheticTrack({ lengthM: 2000, mode: 'circuit', curvatureRadius: 80 });
  return {
    track,
    config: makeConfig({
      trackId: track.id,
      laps: 5,
      vehicleClassId: 'hot-hatch',
      racers: makeField({ size: 8 }),
      seed: 'race-test',
      ...overrides,
    }),
  };
};

const runOrThrow = (input: RaceInput) => {
  const result = runRace(input);
  if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.message}`);
  return result.value;
};

describe('race results', () => {
  it('classifies every racer exactly once, in an unbroken position sequence', () => {
    const result = runOrThrow(circuitInput());
    const positions = result.finishers.map((f) => f.position).sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: 8 }, (_, i) => i + 1));
    expect(new Set(result.finishers.map((f) => f.racerId)).size).toBe(8);
  });

  it('orders finishers by time, with the winner carrying no gap', () => {
    const result = runOrThrow(circuitInput());
    const finished = result.finishers.filter((f) => f.status === 'finished');
    expect(finished.length).toBeGreaterThan(0);

    expect(finished[0]?.gapToWinnerS).toBeUndefined();
    for (let i = 1; i < finished.length; i++) {
      const previous = finished[i - 1]?.totalTimeS ?? 0;
      const current = finished[i]?.totalTimeS ?? 0;
      expect(current).toBeGreaterThanOrEqual(previous);
      expect(finished[i]?.gapToWinnerS).toBeCloseTo(current - (finished[0]?.totalTimeS ?? 0), 6);
    }
  });

  it('records one lap per lap, with times that sum to the total', () => {
    const result = runOrThrow(circuitInput({ laps: 5 }));
    const winner = result.finishers[0];
    expect(winner?.status).toBe('finished');
    expect(winner?.laps).toHaveLength(5);
    expect(winner?.lapsCompleted).toBe(5);

    const sum = (winner?.laps ?? []).reduce((total, lap) => total + lap.timeS, 0);
    expect(sum).toBeCloseTo(winner?.totalTimeS ?? 0, 6);

    const fastest = Math.min(...(winner?.laps ?? []).map((lap) => lap.timeS));
    expect(winner?.bestLapS).toBeCloseTo(fastest, 9);
  });

  it('splits each lap into sectors that sum to the lap time', () => {
    const result = runOrThrow(circuitInput({ laps: 3 }));
    const winner = result.finishers[0];
    for (const lap of winner?.laps ?? []) {
      expect(lap.sectors).toHaveLength(3);
      const sum = lap.sectors.reduce((total, sector) => total + sector.timeS, 0);
      expect(sum).toBeCloseTo(lap.timeS, 6);
    }
  });

  it('refuses to hand back a result before the race is over', () => {
    const created = createRace(circuitInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    created.value.step(10);
    const early = created.value.result();
    expect(early.ok).toBe(false);
    if (early.ok) return;
    expect(early.error.kind).toBe('race-did-not-terminate');
  });
});

describe('the event log', () => {
  it('opens with the grid and closes with a reason', () => {
    const created = createRace(circuitInput());
    if (!created.ok) throw new Error(created.error.message);
    created.value.runToEnd();

    const events = created.value.events;
    expect(events[0]?.type).toBe('race-start');
    expect(events[events.length - 1]?.type).toBe('race-end');
    expect(eventsOfType(events, 'race-start')[0]?.grid).toHaveLength(8);
  });

  it('is ordered in time', () => {
    const created = createRace(circuitInput());
    if (!created.ok) throw new Error(created.error.message);
    created.value.runToEnd();

    // Line crossings are interpolated within a tick, so two events in the same
    // tick can be a few milliseconds apart in either direction; ticks
    // themselves must never go backwards.
    let tick = -1;
    for (const event of created.value.events) {
      expect(event.tick).toBeGreaterThanOrEqual(tick);
      tick = event.tick;
    }
  });

  it('emits a finish event for every classified finisher, matching the result', () => {
    const created = createRace(circuitInput());
    if (!created.ok) throw new Error(created.error.message);
    const result = created.value.runToEnd();
    if (!result.ok) throw new Error(result.error.message);

    const finishEvents = eventsOfType(created.value.events, 'finish');
    const finished = result.value.finishers.filter((f) => f.status === 'finished');
    expect(finishEvents).toHaveLength(finished.length);

    for (const record of finished) {
      const event = finishEvents.find((e) => e.racerId === record.racerId);
      expect(event?.position).toBe(record.position);
      expect(event?.totalTimeS).toBeCloseTo(record.totalTimeS ?? 0, 9);
    }
  });

  it('marks exactly one race-best per lap time that actually was one', () => {
    const created = createRace(circuitInput({ laps: 4 }));
    if (!created.ok) throw new Error(created.error.message);
    created.value.runToEnd();

    const lapEvents = eventsOfType(created.value.events, 'lap');
    let best = Infinity;
    for (const event of lapEvents) {
      const shouldBeRaceBest = event.lapTimeS < best;
      expect(event.raceBest).toBe(shouldBeRaceBest);
      if (shouldBeRaceBest) best = event.lapTimeS;
    }
  });

  it('never logs an overtake by or against a retired racer', () => {
    const created = createRace(
      circuitInput({ laps: 12, vehicleClassId: 'rally-car', seed: 'attrition' }),
    );
    if (!created.ok) throw new Error(created.error.message);
    const result = created.value.runToEnd();
    if (!result.ok) throw new Error(result.error.message);

    const retirementTick = new Map<string, number>();
    for (const event of created.value.events) {
      if (event.type === 'crash' || event.type === 'mechanical') {
        retirementTick.set(event.racerId, event.tick);
      }
    }

    for (const pass of eventsOfType(created.value.events, 'overtake')) {
      for (const id of [pass.racerId, pass.victimId]) {
        const retiredAt = retirementTick.get(id);
        if (retiredAt !== undefined) expect(pass.tick).toBeLessThan(retiredAt);
      }
    }
  });

  it('gives a crashed racer a DNF and no total time', () => {
    // A long rally race is the most reliable way to produce attrition, that
    // class having the lowest reliability in the launch set.
    const result = runOrThrow(
      circuitInput({ laps: 20, vehicleClassId: 'rally-car', seed: 'attrition' }),
    );
    const retired = result.finishers.filter((f) => f.status !== 'finished');
    for (const record of retired) {
      expect(record.totalTimeS).toBeUndefined();
      expect(record.gapToWinnerS).toBeUndefined();
      expect(record.distanceM).toBeLessThanOrEqual(result.finishers[0]?.distanceM ?? Infinity);
    }
  });
});

describe('race validation', () => {
  const cases: { name: string; input: RaceInput; kind: string }[] = [
    {
      name: 'a field of one',
      input: circuitInput({ racers: makeField({ size: 1 }) }),
      kind: 'invalid-field-size',
    },
    {
      name: 'an unknown vehicle class',
      input: circuitInput({ vehicleClassId: 'hovercraft' }),
      kind: 'unknown-vehicle-class',
    },
    {
      name: 'an unknown personality',
      input: circuitInput({ racers: makeField({ size: 4, personality: 'the-nihilist' }) }),
      kind: 'unknown-personality',
    },
    {
      name: 'zero laps on a circuit',
      input: circuitInput({ laps: 0 }),
      kind: 'invalid-laps',
    },
  ];

  for (const testCase of cases) {
    it(`rejects ${testCase.name}`, () => {
      const result = runRace(testCase.input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe(testCase.kind);
      expect(result.error.message.length).toBeGreaterThan(0);
    });
  }

  it('rejects duplicate racer ids', () => {
    const racers = makeField({ size: 4 });
    const duplicated = [...racers, { ...(racers[0] as (typeof racers)[number]) }];
    const result = runRace(circuitInput({ racers: duplicated }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('duplicate-racer-id');
  });

  it('ignores the lap count on a point-to-point track', () => {
    const track = makeSyntheticTrack({ lengthM: 5000 });
    const result = runRace({
      track,
      config: makeConfig({
        trackId: track.id,
        laps: 99,
        vehicleClassId: 'hot-hatch',
        racers: makeField({ size: 4 }),
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const record of result.value.finishers) expect(record.lapsCompleted).toBe(0);
  });
});

describe('traffic actually resolves', () => {
  it('reordering the grid produces real, logged overtakes', () => {
    // Regression test. Overtake detection originally compared each racer's
    // position against its own position one tick earlier — but a tick is 50ms
    // and a pass takes seconds, so a completed pass could never be detected and
    // the log showed hundreds of failed attempts and not one overtake.
    const result = createRace(
      circuitInput({ gridOrder: 'reverse-skill', laps: 6, seed: 'traffic' }),
    );
    if (!result.ok) throw new Error(result.error.message);
    result.value.runToEnd();

    expect(eventsOfType(result.value.events, 'overtake').length).toBeGreaterThan(5);
  });

  it('a faster racer starting last works their way forward', () => {
    // Neutral personality on the subject: the fixture would otherwise make the
    // highest-skill racer a Wildcard, whose pace is rerolled per race, and this
    // test is about whether traffic can be resolved, not about the dice.
    const racers = makeField({ size: 8 });
    const subject = racers[racers.length - 1];
    if (subject !== undefined) subject.personality = 'metronome';

    const created = createRace(
      circuitInput({ racers, gridOrder: 'reverse-skill', laps: 6, seed: 'climb-the-field' }),
    );
    if (!created.ok) throw new Error(created.error.message);
    const finished = created.value.runToEnd();
    if (!finished.ok) throw new Error(finished.error.message);

    // r08 has the highest skill and therefore starts last on a reverse-skill
    // grid. If passing works at all, they must not still be there at the flag.
    // This used to fail outright: the effort cap applied to a queued racer
    // erased the pace advantage that a pass attempt is gated on, so a faster
    // racer stuck behind a slower one stayed there for the whole race.
    const best = finished.value.finishers.find((f) => f.racerId === 'r08');
    expect(best?.position).toBeLessThan(8);
  });

  it('a won pass is given long enough to actually complete', () => {
    // The other half of the same regression: the commit window used to be so
    // short that a racer could win the roll, edge alongside, and drop back.
    const created = createRace(
      circuitInput({ gridOrder: 'reverse-skill', laps: 6, seed: 'traffic' }),
    );
    if (!created.ok) throw new Error(created.error.message);
    created.value.runToEnd();

    const passes = eventsOfType(created.value.events, 'overtake').length;
    const failures = eventsOfType(created.value.events, 'failed-pass').length;
    // Not a precise ratio, just a floor: attempts must convert sometimes.
    expect(passes).toBeGreaterThan(failures * 0.15);
  });
});

describe('skill outranks personality', () => {
  /** Fraction of racer pairs in which the higher-skill racer finished ahead. */
  const skillConcordance = (
    racers: ReturnType<typeof makeField>,
    result: ReturnType<typeof runOrThrow>,
  ): number => {
    const finished = result.finishers.filter((f) => f.status === 'finished');
    const skillOf = (id: string): number => racers.find((r) => r.id === id)?.skill ?? 0;

    let concordant = 0;
    let total = 0;
    for (let i = 0; i < finished.length; i++) {
      for (let j = i + 1; j < finished.length; j++) {
        const a = finished[i];
        const b = finished[j];
        if (a === undefined || b === undefined) continue;
        total += 1;
        if (skillOf(a.racerId) > skillOf(b.racerId)) concordant += 1;
      }
    }
    return total === 0 ? 0 : concordant / total;
  };

  it('sets pace by skill, even through traffic', () => {
    // CLAUDE.md: personality shapes the shape of the performance curve, skill
    // scales it. This was inverted at first — the lowest-skill racer in a mixed
    // field routinely beat the highest — because pass resolution ignored pace
    // entirely and a congested race became a lottery.
    //
    // Incidents are off here so the question is only whether a faster racer can
    // convert their pace into track position. Whether a lockup should be able
    // to cost a place is a separate question, tested below.
    const racers = makeField({ size: 8, personality: 'metronome' });
    const result = runOrThrow({
      ...circuitInput({ racers, laps: 6, seed: 'skill-order' }),
      toggles: { incidents: false, mechanicalFailures: false },
    });
    expect(skillConcordance(racers, result)).toBeGreaterThan(0.85);
  });

  it('still lets a mistake cost a place', () => {
    // The same race with incidents on must be measurably messier. If this ever
    // matched the clean run, incidents would have stopped mattering.
    const racers = makeField({ size: 8, personality: 'rookie' });
    const messy = runOrThrow(circuitInput({ racers, laps: 6, seed: 'skill-order' }));
    expect(skillConcordance(racers, messy)).toBeLessThan(1);
  });

  it('the most skilled racer usually reaches the podium', () => {
    // Long enough that a pace advantage accumulates past the noise of a
    // lockup or two.
    const seeds = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
    const podiums = seeds.filter((seed) => {
      // The fixture cycles archetypes, which makes the highest-skill racer a
      // Wildcard — whose traits are rerolled every seed by design. Giving the
      // subject a neutral personality is the point: this test is about skill,
      // and it should not be measuring the Wildcard's dice.
      const racers = makeField({ size: 8 });
      const subject = racers[racers.length - 1];
      if (subject !== undefined) subject.personality = 'metronome';

      const result = runOrThrow(circuitInput({ racers, laps: 12, seed }));
      const position = result.finishers.find((f) => f.racerId === 'r08')?.position ?? 99;
      return position <= 3;
    });
    // Personality and luck should be able to beat the fastest racer in the
    // field sometimes, but not usually.
    expect(podiums.length).toBeGreaterThanOrEqual(4);
  });
});

describe('personalities are legible', () => {
  /**
   * These assert on shape rather than on a specific result. Personality is
   * meant to be visible to a viewer, so it has to survive being averaged over
   * many seeds — if a Front-Runner does not actually lead early, the archetype
   * is not doing its job no matter how the vector reads.
   */
  const averageOverSeeds = (
    personality: string,
    sample: (input: RaceInput) => number,
  ): number => {
    const seeds = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
    const values = seeds.map((seed) => {
      const racers = makeField({ size: 6, personality: 'metronome', skill: 0.7 });
      const subject = racers[0];
      if (subject !== undefined) subject.personality = personality;
      return sample(circuitInput({ racers, seed, laps: 6 }));
    });
    return values.reduce((total, value) => total + value, 0) / values.length;
  };

  const finishPosition = (personality: string): number =>
    averageOverSeeds(personality, (input) => {
      const result = runOrThrow(input);
      return result.finishers.find((f) => f.racerId === 'r01')?.position ?? 99;
    });

  it('a Front-Runner is up the road early and a Closer is behind', () => {
    // Measured as distance relative to the rest of the field rather than as
    // position: the subject starts on pole either way in a field of equal
    // skill, so position cannot tell the two apart in the opening minutes.
    const earlyAdvantageM = (personality: string): number =>
      averageOverSeeds(personality, (input) => {
        const created = createRace(input);
        if (!created.ok) throw new Error(created.error.message);
        // A minute in, well before the pacing curves cross over.
        created.value.step(20 * 60);

        const racers = created.value.snapshot().racers;
        const subject = racers.find((r) => r.racerId === 'r01');
        const others = racers.filter((r) => r.racerId !== 'r01');
        const meanOthers =
          others.reduce((total, r) => total + r.distanceAlongRoute, 0) / others.length;
        return (subject?.distanceAlongRoute ?? 0) - meanOthers;
      });

    expect(earlyAdvantageM('front-runner')).toBeGreaterThan(earlyAdvantageM('closer'));
  });

  it('a Closer finishes ahead of where a Front-Runner does', () => {
    // Identical skill and vehicle; the only difference is the pacing curve.
    expect(finishPosition('closer')).toBeLessThan(finishPosition('front-runner'));
  });

  it('a Charger has more incidents than a Metronome', () => {
    const incidents = (personality: string): number =>
      averageOverSeeds(personality, (input) => {
        const created = createRace(input);
        if (!created.ok) throw new Error(created.error.message);
        created.value.runToEnd();
        return created.value.events.filter(
          (e) => (e.type === 'mistake' || e.type === 'crash') && e.racerId === 'r01',
        ).length;
      });

    expect(incidents('charger')).toBeGreaterThan(incidents('metronome'));
  });

  it('a Wildcard rerolls its traits per seed, and nobody else does', () => {
    const traitsFor = (personality: string, seed: string) => {
      const racers = makeField({ size: 4, personality: 'metronome', skill: 0.7 });
      const subject = racers[0];
      if (subject !== undefined) subject.personality = personality;
      const result = runOrThrow(circuitInput({ racers, seed, laps: 2 }));
      return result.finishers.find((f) => f.racerId === 'r01')?.traits;
    };

    expect(traitsFor('wildcard', 'seed-a')).not.toEqual(traitsFor('wildcard', 'seed-b'));
    expect(traitsFor('metronome', 'seed-a')).toEqual(traitsFor('metronome', 'seed-b'));
  });
});

describe('weather reaches the race', () => {
  it('a race in the rain is slower than the same race in the dry', () => {
    const dry = runOrThrow(circuitInput({ seed: 'weather' }));
    const wet = runOrThrow(
      circuitInput({
        seed: 'weather',
        weather: manualWeather({ precipitationMmPerHour: 6, temperatureC: 9 }),
      }),
    );

    const winnerTime = (result: ReturnType<typeof runOrThrow>): number =>
      result.finishers.find((f) => f.status === 'finished')?.totalTimeS ?? Infinity;

    expect(winnerTime(wet)).toBeGreaterThan(winnerTime(dry));
  });
});
