import { describe, expect, it } from 'vitest';
import { runRace } from '../src/race';
import { makeConfig, makeField, makeSyntheticTrack, manualWeather } from './fixtures';

/**
 * The sanity table.
 *
 * CLAUDE.md's rule: "a road cyclist on a flat 40km course should finish in
 * roughly 60-70 minutes. If the sim says 20, the physics is wrong." This file
 * is that table, and it is the first thing to look at when a tuning change
 * makes a race feel strange.
 *
 * These are deliberately wide. They are not asserting that the physics is
 * *right*, only that it is not absurd — a regression that halves every speed
 * has to fail something, and this is that something.
 */

type SanityCase = {
  label: string;
  vehicleClassId: string;
  distanceKm: number;
  minMinutes: number;
  maxMinutes: number;
  /** Why this range, in human terms. */
  because: string;
};

const FLAT_DRY_CASES: SanityCase[] = [
  {
    label: 'road cyclist, 40km flat',
    vehicleClassId: 'road-cyclist',
    distanceKm: 40,
    minMinutes: 60,
    maxMinutes: 70,
    because: 'the reference case from CLAUDE.md: roughly 35-40kph average',
  },
  {
    label: 'runner, 10km flat',
    vehicleClassId: 'runner',
    distanceKm: 10,
    minMinutes: 28,
    maxMinutes: 42,
    because: 'a strong club runner through to a very good one: 14-21kph',
  },
  {
    label: 'e-scooter, 10km flat',
    vehicleClassId: 'e-scooter',
    distanceKm: 10,
    minMinutes: 24,
    maxMinutes: 34,
    because: 'a speed-limited scooter cruises in the low twenties kph',
  },
  {
    label: 'e-bike, 10km flat',
    vehicleClassId: 'e-bike',
    distanceKm: 10,
    minMinutes: 19,
    maxMinutes: 27,
    because: 'assisted to roughly 30kph, so a little over 20 minutes',
  },
  {
    label: 'city car, 20km flat',
    vehicleClassId: 'city-car',
    distanceKm: 20,
    minMinutes: 7,
    maxMinutes: 12,
    because: 'unrestricted on a flat straight road, so well over 100kph average',
  },
  {
    label: 'open-wheel racer, 20km flat',
    vehicleClassId: 'open-wheel-racer',
    distanceKm: 20,
    minMinutes: 3.5,
    maxMinutes: 6,
    because: 'the fastest thing in the launch set, north of 250kph on a straight',
  },
];

/**
 * A single racer, no traffic, no incidents, so the number under test is the
 * speed model alone. A Metronome is used because their pacing curve is flat and
 * their noise is nearly zero.
 */
const soloTimeMinutes = (
  vehicleClassId: string,
  distanceKm: number,
  options: { gradient?: number; surface?: Parameters<typeof makeSyntheticTrack>[0]['surface']; weather?: ReturnType<typeof manualWeather> } = {},
): number => {
  const track = makeSyntheticTrack({
    lengthM: distanceKm * 1000,
    ...(options.gradient !== undefined ? { gradient: options.gradient } : {}),
    ...(options.surface !== undefined ? { surface: options.surface } : {}),
  });

  const result = runRace({
    track,
    config: makeConfig({
      vehicleClassId,
      racers: makeField({ size: 2, personality: 'metronome', skill: 0.8 }),
      laps: 1,
      ...(options.weather ? { weather: options.weather } : {}),
    }),
    // Incidents and mechanicals are off: a sanity range should not fail because
    // one run in fifty had a puncture.
    toggles: { incidents: false, mechanicalFailures: false },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);

  const winner = result.value.finishers[0];
  expect(winner?.totalTimeS).toBeDefined();
  return (winner?.totalTimeS ?? 0) / 60;
};

describe('sanity ranges: flat, dry, still air', () => {
  for (const testCase of FLAT_DRY_CASES) {
    it(`${testCase.label} — ${testCase.because}`, () => {
      const minutes = soloTimeMinutes(testCase.vehicleClassId, testCase.distanceKm);
      expect(minutes).toBeGreaterThanOrEqual(testCase.minMinutes);
      expect(minutes).toBeLessThanOrEqual(testCase.maxMinutes);
    });
  }
});

describe('sanity ranges: the modifiers move things the right way', () => {
  it('a 5% climb costs a cyclist far more than it costs a car', () => {
    // 10km rather than 5km: over a short course a car spends a meaningful
    // fraction of the run accelerating, which drags the flat baseline down and
    // makes the climb look cheaper than it is.
    const cyclistFlat = soloTimeMinutes('road-cyclist', 10);
    const cyclistClimb = soloTimeMinutes('road-cyclist', 10, { gradient: 0.05 });
    const carFlat = soloTimeMinutes('city-car', 10);
    const carClimb = soloTimeMinutes('city-car', 10, { gradient: 0.05 });

    const cyclistPenalty = cyclistClimb / cyclistFlat;
    const carPenalty = carClimb / carFlat;

    // A strong rider drops from roughly 38kph to roughly 23kph on 5%.
    expect(cyclistPenalty).toBeGreaterThan(1.4);
    expect(cyclistPenalty).toBeLessThan(1.9);
    // A city car does lose real speed on a sustained 5% — it is not immune,
    // it is just far less bothered.
    expect(carPenalty).toBeLessThan(1.25);
    expect(cyclistPenalty).toBeGreaterThan(carPenalty * 1.35);
  });

  it('hills are what decides an e-scooter race', () => {
    const flat = soloTimeMinutes('e-scooter', 5);
    const climb = soloTimeMinutes('e-scooter', 5, { gradient: 0.05 });
    // The steepest gradient sensitivity in the set, by design.
    expect(climb / flat).toBeGreaterThan(1.6);
  });

  it('gravel barely troubles a rally car and ruins a supercar', () => {
    const rallyAsphalt = soloTimeMinutes('rally-car', 5);
    const rallyGravel = soloTimeMinutes('rally-car', 5, { surface: 'gravel' });
    const superAsphalt = soloTimeMinutes('supercar', 5);
    const superGravel = soloTimeMinutes('supercar', 5, { surface: 'gravel' });

    expect(rallyGravel / rallyAsphalt).toBeLessThan(1.1);
    expect(superGravel / superAsphalt).toBeGreaterThan(1.4);
  });

  it('rain slows everyone, and slows the low-grip classes most', () => {
    const wet = manualWeather({ precipitationMmPerHour: 6, temperatureC: 10 });
    const dryTime = soloTimeMinutes('gt-racer', 5);
    const wetTime = soloTimeMinutes('gt-racer', 5, { weather: wet });
    // On a dead straight track rain costs visibility but not cornering, so the
    // effect is real but small. A twisty track is where wet grip shows up.
    expect(wetTime).toBeGreaterThan(dryTime);
  });

  it('a headwind costs a cyclist more than it costs a car', () => {
    // The synthetic track runs due east, so a wind from the east is a headwind.
    const headwind = manualWeather({ windSpeedMs: 8, windFromDegrees: 90 });
    const cyclistStill = soloTimeMinutes('road-cyclist', 10);
    const cyclistInto = soloTimeMinutes('road-cyclist', 10, { weather: headwind });
    const carStill = soloTimeMinutes('city-car', 10);
    const carInto = soloTimeMinutes('city-car', 10, { weather: headwind });

    expect(cyclistInto / cyclistStill).toBeGreaterThan(1.1);
    expect(carInto / carStill).toBeLessThan(1.05);
  });

  it('a tailwind is worth having', () => {
    const tailwind = manualWeather({ windSpeedMs: 8, windFromDegrees: 270 });
    const still = soloTimeMinutes('road-cyclist', 10);
    const pushed = soloTimeMinutes('road-cyclist', 10, { weather: tailwind });
    expect(pushed).toBeLessThan(still);
  });
});

describe('sanity ranges: cornering', () => {
  it('a tight circuit is slower than a straight of the same length', () => {
    const straight = makeSyntheticTrack({ lengthM: 3000, mode: 'circuit' });
    const twisty = makeSyntheticTrack({ lengthM: 3000, mode: 'circuit', curvatureRadius: 40 });

    const time = (track: ReturnType<typeof makeSyntheticTrack>): number => {
      const result = runRace({
        track,
        config: makeConfig({
          vehicleClassId: 'sports-car',
          racers: makeField({ size: 2, personality: 'metronome', skill: 0.8 }),
          laps: 2,
        }),
        toggles: { incidents: false, mechanicalFailures: false },
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value.finishers[0]?.totalTimeS ?? 0;
    };

    expect(time(twisty)).toBeGreaterThan(time(straight) * 2);
  });

  it('an open-wheel car carries far more corner speed than a city car', () => {
    const track = makeSyntheticTrack({ lengthM: 3000, mode: 'circuit', curvatureRadius: 60 });
    const lapTime = (vehicleClassId: string): number => {
      const result = runRace({
        track,
        config: makeConfig({
          vehicleClassId,
          racers: makeField({ size: 2, personality: 'metronome', skill: 0.8 }),
          laps: 2,
        }),
        toggles: { incidents: false, mechanicalFailures: false },
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value.finishers[0]?.totalTimeS ?? 0;
    };

    // Both are grip-limited on a constant-radius 60m circuit, so this compares
    // lateral grip almost directly: 2.2g against 0.85g.
    expect(lapTime('city-car') / lapTime('open-wheel-racer')).toBeGreaterThan(1.4);
  });
});

/**
 * Finishing is supposed to be the common case.
 *
 * This is the regression suite for the "car tactics in a foot race" bug. A
 * crash used to be an unconditional DNF for every class, and the crash hazard
 * was a flat per-tick rate rather than one normalized to race duration the way
 * the mechanical hazard is. A bicycle or foot race is slow, and therefore long,
 * and therefore thousands of extra ticks — so the field crashed itself out
 * until a genuinely reproducible race finished with nobody classified. The fix
 * makes the terminal-crash odds per vehicle (`crashProneness`) and
 * duration-normalized, and turns a survived crash into a time loss.
 *
 * These run with incidents ON (unlike the speed sanity ranges above, which turn
 * them off), because the whole point is the incident model.
 */
describe('sanity ranges: finishing is the common case', () => {
  type Tally = { finished: number; crashed: number; total: number; zeroFinishSeeds: number };

  // A long race is many hundreds of thousands of ticks, so these are kept to a
  // few seeds and given room past the default per-test timeout.
  const LONG_RACE_TIMEOUT_MS = 120_000;

  const tally = (vehicleClassId: string, lengthM: number, seeds: readonly string[]): Tally => {
    const result: Tally = { finished: 0, crashed: 0, total: 0, zeroFinishSeeds: 0 };
    for (const seed of seeds) {
      const track = makeSyntheticTrack({ lengthM });
      const race = runRace({
        track,
        config: makeConfig({
          vehicleClassId,
          racers: makeField({ size: 10 }),
          laps: 1,
          seed,
        }),
      });
      expect(race.ok).toBe(true);
      if (!race.ok) throw new Error(race.error.message);

      const finished = race.value.finishers.filter((f) => f.status === 'finished').length;
      result.finished += finished;
      result.crashed += race.value.finishers.filter((f) => f.status === 'dnf-crash').length;
      result.total += race.value.finishers.length;
      if (finished === 0) result.zeroFinishSeeds += 1;
    }
    return result;
  };

  const seeds = ['f1', 'f2', 'f3'];

  it(
    'a long point-to-point bicycle race is not decided by attrition',
    () => {
      // ~60km — a couple of hours of racing, well into the range where the old
      // model started emptying the finishing order.
      const t = tally('road-cyclist', 60_000, seeds);
      expect(t.zeroFinishSeeds).toBe(0);
      expect(t.finished / t.total).toBeGreaterThan(0.75);
    },
    LONG_RACE_TIMEOUT_MS,
  );

  it(
    'a runner almost never crashes out — they get up and keep running',
    () => {
      // A long trail race. crashProneness is 0.03: a fall is a time loss, not
      // the end of the race.
      const t = tally('runner', 30_000, seeds);
      expect(t.zeroFinishSeeds).toBe(0);
      expect(t.crashed / t.total).toBeLessThan(0.02);
    },
    LONG_RACE_TIMEOUT_MS,
  );

  it(
    'but a racing car still crashes out sometimes',
    () => {
      // The fix must not make crashes vanish where they belong. A twisty
      // circuit and the fastest, most fragile class in the set: a big one is
      // terminal.
      let crashed = 0;
      for (const seed of ['c1', 'c2', 'c3', 'c4']) {
        const track = makeSyntheticTrack({ lengthM: 2400, mode: 'circuit', curvatureRadius: 45 });
        const race = runRace({
          track,
          config: makeConfig({
            vehicleClassId: 'open-wheel-racer',
            racers: makeField({ size: 12 }),
            laps: 25,
            seed,
          }),
        });
        expect(race.ok).toBe(true);
        if (!race.ok) throw new Error(race.error.message);
        crashed += race.value.finishers.filter((f) => f.status === 'dnf-crash').length;
      }
      expect(crashed).toBeGreaterThan(0);
    },
    LONG_RACE_TIMEOUT_MS,
  );
});
