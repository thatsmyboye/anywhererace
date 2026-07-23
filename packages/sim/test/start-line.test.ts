import { describe, expect, it } from 'vitest';
import type { Track } from '@anywhererace/core';
import { createRace, runRace } from '../src/race';
import { eventsOfType } from '../src/events';
import { makeConfig, makeField, makeSyntheticTrack } from './fixtures';

/**
 * A circuit whose lap does not begin at the first waypoint.
 *
 * The sim already rotated sectors by `startLine`; what was missing was any way
 * for a user to move it. These pin the behaviour the builder now depends on:
 * moving the line changes *where* a lap is measured from, and nothing else —
 * not its length, not how many there are, not who wins.
 */

const LENGTH_M = 3000;

/** The same circuit, with the lap measured from `startLine` meters along. */
const circuitStartingAt = (startLine: number): Track => {
  const base = makeSyntheticTrack({ lengthM: LENGTH_M, mode: 'circuit' });
  return {
    ...base,
    startLine,
    finishLine: startLine + LENGTH_M,
    sectors: base.sectors.map((offset) => (startLine + offset) % LENGTH_M),
  };
};

const race = (track: Track) =>
  runRace({
    track,
    config: makeConfig({
      trackId: track.id,
      laps: 3,
      racers: makeField({ size: 4 }),
      seed: 'start-line',
      vehicleClassId: 'hot-hatch',
    }),
  });

describe('a circuit whose start line has been moved', () => {
  it('still races the same distance', () => {
    const atZero = race(circuitStartingAt(0));
    const moved = race(circuitStartingAt(LENGTH_M / 3));

    expect(atZero.ok).toBe(true);
    expect(moved.ok).toBe(true);
    if (!atZero.ok || !moved.ok) return;

    for (const finisher of moved.value.finishers) {
      expect(finisher.lapsCompleted).toBe(3);
    }
    // Same road, same laps, same field: the winner's time should be in the
    // same country as the unmoved version rather than a third longer.
    const winnerAt = (r: typeof atZero) => (r.ok ? r.value.finishers[0]?.totalTimeS ?? 0 : 0);
    expect(winnerAt(moved)).toBeGreaterThan(winnerAt(atZero) * 0.9);
    expect(winnerAt(moved)).toBeLessThan(winnerAt(atZero) * 1.1);
  });

  it('still reports three sectors per lap', () => {
    const track = circuitStartingAt(LENGTH_M / 3);
    const runner = createRace({
      track,
      config: makeConfig({
        trackId: track.id,
        laps: 3,
        racers: makeField({ size: 4 }),
        seed: 'start-line',
        vehicleClassId: 'hot-hatch',
      }),
    });
    expect(runner.ok).toBe(true);
    if (!runner.ok) return;
    runner.value.runToEnd();

    const sectors = eventsOfType(runner.value.events, 'sector');
    expect(sectors.length).toBeGreaterThan(0);
    expect(new Set(sectors.map((event) => event.sector)).size).toBe(3);
  });

  it('measures a lap from the line, not from the first waypoint', () => {
    // The lap times either side of the move describe the same loop, so they
    // should agree closely. A start line that shifted the lap *length* rather
    // than its phase would show up here immediately.
    const atZero = race(circuitStartingAt(0));
    const moved = race(circuitStartingAt(LENGTH_M / 2));
    if (!atZero.ok || !moved.ok) return;

    const meanLap = (r: typeof atZero): number => {
      if (!r.ok) return 0;
      const laps = r.value.finishers.flatMap((f) => f.laps.map((lap) => lap.timeS));
      return laps.reduce((total, value) => total + value, 0) / Math.max(1, laps.length);
    };

    expect(meanLap(moved)).toBeGreaterThan(meanLap(atZero) * 0.9);
    expect(meanLap(moved)).toBeLessThan(meanLap(atZero) * 1.1);
  });
});
