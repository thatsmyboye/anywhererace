import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalResultString } from '../src/hash';
import { createRace, runRace } from '../src/race';
import type { RaceInput, RaceResult } from '../src/types';
import { makeConfig, makeField, makeSyntheticTrack, manualWeather } from './fixtures';

/**
 * Determinism is the load-bearing property of this whole product: it is what
 * makes "watch live" and "skip to the end" the same code path, and what makes a
 * shared race a hundred bytes instead of a video.
 *
 * These tests are mandatory. If one fails, the fix is never to regenerate the
 * golden — it is to find what became non-deterministic.
 *
 * The one exception is a *deliberate* tuning change, which by design alters
 * results. In that case regenerate the goldens in the same commit as the tuning
 * change, bump SIM_VERSION, and say why in the commit message.
 */

const GOLDEN_TRACK = makeSyntheticTrack({ lengthM: 2400, mode: 'circuit', curvatureRadius: 90 });

const goldenInput = (overrides: Partial<RaceInput['config']> = {}): RaceInput => ({
  track: GOLDEN_TRACK,
  config: makeConfig({
    trackId: GOLDEN_TRACK.id,
    laps: 4,
    vehicleClassId: 'gt-racer',
    racers: makeField({ size: 10 }),
    seed: 'golden-seed-001',
    gridOrder: 'by-skill',
    ...overrides,
  }),
});

const run = (input: RaceInput): RaceResult => {
  const result = runRace(input);
  if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.message}`);
  return result.value;
};

describe('determinism', () => {
  it('the same seed and config produce a byte-identical result', () => {
    const first = run(goldenInput());
    const second = run(goldenInput());

    expect(second.resultHash).toBe(first.resultHash);
    expect(canonicalResultString(second.finishers)).toBe(
      canonicalResultString(first.finishers),
    );
  });

  it('stepping tick by tick matches running straight to the end', () => {
    const reference = run(goldenInput());

    const created = createRace(goldenInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Deliberately irregular chunk sizes: this is what a UI running at 1x, 2x
    // and 8x actually does, and it must not change the outcome by a tick.
    const chunks = [1, 1, 7, 200, 3, 1000, 13];
    let index = 0;
    while (created.value.step(chunks[index % chunks.length] as number)) index += 1;

    const stepped = created.value.result();
    expect(stepped.ok).toBe(true);
    if (!stepped.ok) return;

    expect(stepped.value.resultHash).toBe(reference.resultHash);
    expect(stepped.value.totalTicks).toBe(reference.totalTicks);
  });

  it('a different seed produces a different race', () => {
    const a = run(goldenInput({ seed: 'golden-seed-001' }));
    const b = run(goldenInput({ seed: 'golden-seed-002' }));
    expect(b.resultHash).not.toBe(a.resultHash);
  });

  it('a racer keeps the same traits when the size of the field changes', () => {
    // The point of forking each racer's stream by id rather than by index: a
    // Wildcard's rolled traits must not depend on who else entered.
    const small = run(goldenInput({ racers: makeField({ size: 6 }) }));
    const large = run(goldenInput({ racers: makeField({ size: 12 }) }));

    const traitsById = (result: RaceResult, id: string) =>
      result.finishers.find((f) => f.racerId === id)?.traits;

    for (const id of ['r01', 'r03', 'r06']) {
      expect(traitsById(large, id)).toEqual(traitsById(small, id));
    }
  });

  it('turning a debug toggle off changes the result', () => {
    // If this ever passes trivially it means a toggle has been disconnected
    // from the tick and the debug panel is lying.
    const withEverything = run(goldenInput());
    const withoutDraft = run({ ...goldenInput(), toggles: { draft: false } });
    expect(withoutDraft.resultHash).not.toBe(withEverything.resultHash);
  });

  it('weather is read from the baked spec, not from anything ambient', () => {
    const wet = manualWeather({ precipitationMmPerHour: 5 });
    const a = run({
      ...goldenInput(),
      config: { ...goldenInput().config, weather: wet },
    });
    const b = run({
      ...goldenInput(),
      config: { ...goldenInput().config, weather: wet },
    });
    expect(a.resultHash).toBe(b.resultHash);
  });
});

/**
 * Golden hashes.
 *
 * GENERATED, NOT VERIFIED: these values were produced by running the simulation
 * as first written. They lock in current behavior so that an accidental change
 * is caught; they are not independent evidence that the behavior is correct.
 * The sanity-range suite is what argues the behavior is reasonable.
 */
const GOLDEN_HASHES: Record<string, string> = {
  // Recorded against SIM_VERSION 0.4.0.
  //
  // The two long, slow races were regenerated when the crash model was made
  // vehicle- and duration-aware: a crash-severity moment no longer ends the
  // race at a flat 4% for every class. Whether it is terminal is now a separate
  // roll against the vehicle's `crashProneness`, normalized to race duration,
  // and a survived crash becomes a heavy time loss rather than a retirement.
  // This stops a slow, hours-long bicycle or foot race from emptying its own
  // finishing order — the "car tactics for a foot race" bug. The gt-racer
  // circuit is short enough that no crash-severity moment fires in it, so its
  // RNG stream and hence its hash are unchanged, which is the cheap proof that
  // car behavior was left alone.
  //
  // Earlier regeneration (0.1.0 -> 0.3.0) was for the traffic and
  // skill-weighting fixes: overtake detection compared positions within a
  // single 50ms tick and so could never fire; the effort cap on a queued racer
  // erased the pace advantage that gates a pass; and skill scaled only the
  // straight-line term, letting riskTolerance outweigh talent on any track with
  // corners.
  'gt-racer circuit 4 laps, 10 racers': '8ab39f30e1db42f8',
  'road-cyclist point-to-point 40km, 8 racers': '0710395c4a88e6b3',
  'runner trail circuit, wet, 12 racers': '3e34461081004545',
};

describe('determinism: golden seeds', () => {
  const cases: { name: string; input: RaceInput }[] = [
    {
      name: 'gt-racer circuit 4 laps, 10 racers',
      input: goldenInput(),
    },
    {
      name: 'road-cyclist point-to-point 40km, 8 racers',
      input: {
        track: makeSyntheticTrack({ lengthM: 40_000 }),
        config: makeConfig({
          vehicleClassId: 'road-cyclist',
          racers: makeField({ size: 8 }),
          seed: 'golden-seed-cyclist',
          laps: 1,
        }),
      },
    },
    {
      name: 'runner trail circuit, wet, 12 racers',
      input: {
        track: makeSyntheticTrack({
          lengthM: 1800,
          mode: 'circuit',
          curvatureRadius: 45,
          surface: 'trail',
          widthMeters: 1.5,
          gradient: (distanceM) => (distanceM < 900 ? 0.06 : -0.06),
        }),
        config: makeConfig({
          vehicleClassId: 'runner',
          racers: makeField({ size: 12 }),
          seed: 'golden-seed-trail',
          laps: 3,
          weather: manualWeather({ precipitationMmPerHour: 4, temperatureC: 8 }),
        }),
      },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = run(testCase.input);
      const expected = GOLDEN_HASHES[testCase.name];

      if (expected === 'PENDING' || expected === undefined) {
        throw new Error(
          `No golden recorded for "${testCase.name}". Current hash is ${result.resultHash}.\n` +
            'If this is a deliberate change, update GOLDEN_HASHES and bump SIM_VERSION.',
        );
      }
      expect(result.resultHash).toBe(expected);
    });
  }
});

/**
 * A static check on the source, not on behavior.
 *
 * The lint config bans these too, but a lint rule is easy to disable in a
 * hurry and this failure explains *why* the ban exists. `Math.sin` and friends
 * are "implementation-approximated" per the ECMAScript spec, so two engines may
 * legally disagree in the last bit — which would make a shared race replay
 * differently in a different browser.
 */
describe('determinism: the sim stays pure', () => {
  const SIM_SRC = fileURLToPath(new URL('../src', import.meta.url));

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return path.endsWith('.ts') ? [path] : [];
    });

  const withoutComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('never reaches for a wall clock, a DOM, or an unseeded random', () => {
    const banned = [/Math\s*\.\s*random/, /Date\s*\.\s*now/, /\bnew Date\b/, /\bwindow\s*\./, /\bdocument\s*\./];
    for (const file of sourceFiles(SIM_SRC)) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      for (const pattern of banned) {
        expect(pattern.test(source), `${file} matches ${pattern}`).toBe(false);
      }
    }
  });

  it('keeps implementation-approximated math out of the per-tick path', () => {
    // These files run a bounded number of times before the first tick, so a
    // last-ulp difference cannot accumulate across a race.
    const allowed = new Set(['profile.ts', 'setup.ts', 'race.ts']);
    const transcendental = /Math\s*\.\s*(sin|cos|tan|asin|acos|atan|atan2|log|log2|log10|exp|pow|hypot|cbrt)\b/;

    for (const file of sourceFiles(SIM_SRC)) {
      if (allowed.has(file.split(/[\\/]/).pop() ?? '')) continue;
      const source = withoutComments(readFileSync(file, 'utf8'));
      expect(transcendental.test(source), `${file} uses implementation-approximated math`).toBe(
        false,
      );
    }
  });
});
