import { describe, expect, it } from 'vitest';
import { createRace } from '../src/race';
import type { RaceEvent } from '../src/events';
import type { RaceConfig, RaceResult } from '../src/types';
import {
  buildIncidentTimeline,
  buildLapChart,
  buildPositionChart,
  buildSectorSummary,
  isRetirement,
  placesGained,
} from '../src/results';
import { buildNarrative } from '../src/narrative';
import { makeConfig, makeField, makeSyntheticTrack } from './fixtures';

/**
 * Results are derived from the event log, never stored alongside it. These
 * tests run a real race and read it back, which is the only way to be sure the
 * derivation agrees with what the simulation actually did.
 */

const TRACK = makeSyntheticTrack({ lengthM: 1800, mode: 'circuit', curvatureRadius: 75 });

const runRace = (overrides: Partial<RaceConfig> = {}) => {
  const created = createRace({
    track: TRACK,
    config: makeConfig({
      trackId: TRACK.id,
      laps: 5,
      vehicleClassId: 'hot-hatch',
      racers: makeField({ size: 8 }),
      seed: 'results-test',
      gridOrder: 'reverse-skill',
      ...overrides,
    }),
  });
  if (!created.ok) throw new Error(created.error.message);
  const result = created.value.runToEnd();
  if (!result.ok) throw new Error(result.error.message);
  return { result: result.value, events: created.value.events as RaceEvent[] };
};

const attritionRace = () =>
  runRace({ laps: 25, vehicleClassId: 'rally-car', seed: 'attrition' });

const names = (result: RaceResult): Map<string, string> =>
  new Map(result.finishers.map((f, i) => [f.racerId, `Racer ${i + 1}`]));

const gridOf = (events: readonly RaceEvent[]): string[] => {
  const start = events.find((event) => event.type === 'race-start');
  return start?.type === 'race-start' ? start.grid : [];
};

describe('lap chart', () => {
  it('has a column per lap and a row per racer', () => {
    const { result } = runRace();
    const chart = buildLapChart(result);

    expect(chart.lapNumbers).toEqual([1, 2, 3, 4, 5]);
    expect(chart.rows).toHaveLength(8);
    for (const row of chart.rows) expect(row.laps).toHaveLength(5);
  });

  it('leaves a gap where a racer did not complete a lap', () => {
    // A retirement has to show as a line that stops, never as a zero.
    const { result } = attritionRace();
    const retired = result.finishers.find((f) => isRetirement(f.status));
    if (retired === undefined) return;

    const row = buildLapChart(result).rows.find((r) => r.racerId === retired.racerId);
    expect(row?.laps.some((lap) => lap === undefined)).toBe(true);
  });

  it('finds the fastest lap of the race', () => {
    const { result } = runRace();
    const allTimes = result.finishers.flatMap((f) => f.laps.map((lap) => lap.timeS));
    expect(buildLapChart(result).fastest?.timeS).toBeCloseTo(Math.min(...allTimes), 9);
  });

  it('accounts for exactly the lap events the sim emitted', () => {
    const { result, events } = runRace();
    const cells = buildLapChart(result)
      .rows.flatMap((row) => row.laps)
      .filter((lap) => lap !== undefined);
    expect(cells).toHaveLength(events.filter((event) => event.type === 'lap').length);
  });
});

describe('position chart', () => {
  it('starts every racer on the grid', () => {
    const { result, events } = runRace();
    const chart = buildPositionChart(events, result);

    expect(chart.series).toHaveLength(8);
    const gridPositions = chart.series
      .map((series) => series.points.find((point) => point.lap === 0)?.position)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(gridPositions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('gives each lap a contiguous set of positions from 1', () => {
    const { result, events } = runRace();
    const chart = buildPositionChart(events, result);

    for (const lap of chart.lapNumbers) {
      const positions = chart.series
        .flatMap((series) => series.points.filter((point) => point.lap === lap))
        .map((point) => point.position)
        .sort((a, b) => a - b);
      if (positions.length === 0) continue;
      expect(positions).toEqual(Array.from({ length: positions.length }, (_, i) => i + 1));
    }
  });

  it('orders each lap by who crossed the line first', () => {
    const { result, events } = runRace();
    const chart = buildPositionChart(events, result);

    const firstOnLapOne = events
      .filter((event): event is Extract<RaceEvent, { type: 'lap' }> => event.type === 'lap')
      .filter((event) => event.lap === 1)
      .sort((a, b) => a.atS - b.atS)[0];

    const leader = chart.series.find((series) =>
      series.points.some((point) => point.lap === 1 && point.position === 1),
    );
    expect(leader?.racerId).toBe(firstOnLapOne?.racerId);
  });

  it('stops a retired racer rather than dropping them to last', () => {
    const { result, events } = attritionRace();
    const retired = result.finishers.find((f) => isRetirement(f.status));
    if (retired === undefined) return;

    const chart = buildPositionChart(events, result);
    const series = chart.series.find((s) => s.racerId === retired.racerId);
    const lastLap = Math.max(...(series?.points.map((point) => point.lap) ?? [0]));
    expect(lastLap).toBeLessThan(Math.max(...chart.lapNumbers));
  });
});

describe('sector summary', () => {
  it('finds a best for every sector', () => {
    const summary = buildSectorSummary(runRace().events);
    expect(summary.bests).toHaveLength(3);
    expect(summary.bests.map((best) => best.sector)).toEqual([0, 1, 2]);
  });

  it('reports an ideal lap no slower than the fastest real one', () => {
    // The sum of the best sectors is a lap nobody drove; it can only be quicker
    // than the best actual lap.
    const { result, events } = runRace();
    const summary = buildSectorSummary(events);
    const fastest = buildLapChart(result).fastest?.timeS ?? 0;

    expect(summary.idealLapS).toBeDefined();
    expect(summary.idealLapS ?? 0).toBeLessThanOrEqual(fastest + 1e-6);
  });

  it('records a personal best per sector per racer', () => {
    const { result, events } = runRace();
    const winner = result.finishers[0];
    if (winner === undefined) return;

    const personal = buildSectorSummary(events).personalBests.get(winner.racerId);
    expect(personal?.filter((time) => time !== undefined)).toHaveLength(3);
  });
});

describe('incident timeline', () => {
  it('is ordered in time', () => {
    const incidents = buildIncidentTimeline(attritionRace().events);

    let tick = -1;
    for (const incident of incidents) {
      expect(incident.tick).toBeGreaterThanOrEqual(tick);
      tick = incident.tick;
    }
  });

  it('marks retirements as terminal and everything else as not', () => {
    for (const incident of buildIncidentTimeline(attritionRace().events)) {
      const shouldBeTerminal = incident.kind === 'crash' || incident.kind === 'mechanical';
      expect(incident.terminal).toBe(shouldBeTerminal);
    }
  });

  it('counts every incident the sim emitted, and nothing else', () => {
    const { events } = attritionRace();
    const emitted = events.filter((event) =>
      ['mistake', 'crash', 'mechanical', 'failed-pass'].includes(event.type),
    );
    expect(buildIncidentTimeline(events)).toHaveLength(emitted.length);
  });
});

describe('placesGained', () => {
  it('conserves places across the field', () => {
    // Every place gained is a place someone else lost.
    const { result, events } = runRace();
    const grid = gridOf(events);
    const gains = result.finishers.map((f) => placesGained(f, grid) ?? 0);
    expect(gains.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('returns undefined for a racer who was not on the grid', () => {
    const { result } = runRace();
    const finisher = result.finishers[0];
    if (finisher === undefined) return;
    expect(placesGained(finisher, [])).toBeUndefined();
  });
});

describe('narrative', () => {
  it('reads as a race report with a headline and beats', () => {
    const { result, events } = runRace();
    const narrative = buildNarrative({
      result,
      events,
      names: names(result),
      trackName: 'Test loop',
    });

    expect(narrative.headline).toContain('Test loop');
    expect(narrative.beats.length).toBeGreaterThan(2);
    expect(narrative.beats[0]?.kind).toBe('headline');
    expect(narrative.text).toContain(narrative.headline);
  });

  it('is deterministic for the same race', () => {
    // The sharing model is "share inputs, not recordings". If the prose varied,
    // two people opening the same link would read different races.
    const a = runRace();
    const b = runRace();
    expect(buildNarrative({ result: b.result, events: b.events, names: names(b.result) }).text).toBe(
      buildNarrative({ result: a.result, events: a.events, names: names(a.result) }).text,
    );
  });

  it('uses names rather than racer ids', () => {
    const { result, events } = runRace();
    const narrative = buildNarrative({ result, events, names: names(result) });
    expect(narrative.text).not.toMatch(/\br0\d\b/);
  });

  it('mentions retirements when there are any', () => {
    const { result, events } = attritionRace();
    if (result.finishers.every((f) => !isRetirement(f.status))) return;

    const narrative = buildNarrative({ result, events, names: names(result) });
    expect(narrative.beats.some((beat) => beat.kind === 'attrition')).toBe(true);
  });

  it('says so when everyone finished', () => {
    const { result, events } = runRace({ laps: 2 });
    if (result.finishers.some((f) => isRetirement(f.status))) return;

    const narrative = buildNarrative({ result, events, names: names(result) });
    expect(narrative.text).toMatch(/All \d+ finished/);
  });

  it('drops beats that do not apply rather than padding', () => {
    // Two racers have no field to climb through, so there is no mover beat.
    const { result, events } = runRace({ racers: makeField({ size: 2 }), laps: 2 });
    const narrative = buildNarrative({ result, events, names: names(result) });
    expect(narrative.beats.some((beat) => beat.kind === 'mover')).toBe(false);
  });

  it('survives a race in which nothing notable happened', () => {
    const flat = makeSyntheticTrack({ lengthM: 1200, mode: 'circuit' });
    const created = createRace({
      track: flat,
      config: makeConfig({
        trackId: flat.id,
        laps: 1,
        racers: makeField({ size: 2, personality: 'metronome', skill: 0.8 }),
      }),
      toggles: { incidents: false, mechanicalFailures: false, traffic: false },
    });
    if (!created.ok) throw new Error(created.error.message);
    const result = created.value.runToEnd();
    if (!result.ok) throw new Error(result.error.message);

    const narrative = buildNarrative({
      result: result.value,
      events: created.value.events as RaceEvent[],
      names: names(result.value),
    });
    expect(narrative.headline.length).toBeGreaterThan(0);
    expect(narrative.text.length).toBeGreaterThan(0);
  });
});
