import { describe, expect, it } from 'vitest';
import { DRY_STILL_CONDITIONS } from '@anywhererace/core';
import type { LatLng, WeatherSpec } from '@anywhererace/core';
import type { RaceResult, RacerStatus } from '@anywhererace/sim';
import {
  F1_POINTS_TABLE,
  computeStandings,
  configForLeg,
  findTourBreaks,
  isComplete,
  legResultFromRaceResult,
  linearPointsTable,
  nextLegIndex,
  pointsForPosition,
} from '../src/index';
import type {
  Championship,
  ChampionshipLeg,
  ChampionshipRacer,
  LegFinish,
  LegResult,
  ScoringMode,
} from '../src/index';

const DRY: WeatherSpec = { kind: 'manual', conditions: DRY_STILL_CONDITIONS };

const racer = (id: string, name: string, skill: number): ChampionshipRacer => ({
  id,
  name,
  color: '#888888',
  personality: 'metronome',
  skill,
});

/** A leg on a flat point-to-point track, at an arbitrary place. */
const leg = (
  id: string,
  start: LatLng,
  finish: LatLng,
  result?: LegResult,
): ChampionshipLeg => ({
  id,
  trackId: `track-${id}`,
  trackName: `Track ${id}`,
  trackMode: 'point-to-point',
  startPoint: start,
  finishPoint: finish,
  vehicleClassId: 'road-cyclist',
  laps: 1,
  weather: DRY,
  seed: `seed-${id}`,
  ...(result ? { result } : {}),
});

const finish = (
  racerId: string,
  position: number,
  status: RacerStatus,
  totalTimeS?: number,
): LegFinish => ({
  racerId,
  position,
  status,
  ...(totalTimeS === undefined ? {} : { totalTimeS }),
});

const legResult = (finishers: LegFinish[], durationS = 3600): LegResult => ({
  simVersion: '0.1.0',
  resultHash: 'hash',
  durationS,
  completedAt: '2026-07-22T00:00:00.000Z',
  finishers,
});

const championship = (
  scoring: ScoringMode,
  racers: ChampionshipRacer[],
  legs: ChampionshipLeg[],
): Championship => ({
  id: 'champ-1',
  name: 'Test Cup',
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
  tour: false,
  scoring,
  pointsTable: F1_POINTS_TABLE,
  gridOrder: 'reverse-skill',
  racers,
  legs,
});

describe('pointsForPosition', () => {
  it('reads the table by 1-based position', () => {
    expect(pointsForPosition(F1_POINTS_TABLE, 1, true)).toBe(25);
    expect(pointsForPosition(F1_POINTS_TABLE, 3, true)).toBe(15);
    expect(pointsForPosition(F1_POINTS_TABLE, 10, true)).toBe(1);
  });

  it('awards the finisher floor below the table', () => {
    const table = { perPosition: [10, 6, 4], finisherFloor: 1 };
    expect(pointsForPosition(table, 5, true)).toBe(1);
  });

  it('scores nothing for a retirement, wherever it is classified', () => {
    expect(pointsForPosition(F1_POINTS_TABLE, 1, false)).toBe(0);
    expect(pointsForPosition(F1_POINTS_TABLE, 8, false)).toBe(0);
  });
});

describe('computeStandings — points mode', () => {
  it('ranks by total points, most first', () => {
    const racers = [racer('a', 'Ana', 0.9), racer('b', 'Bo', 0.8), racer('c', 'Cy', 0.7)];
    const legs = [
      leg('1', { lat: 0, lng: 0 }, { lat: 0, lng: 1 }, legResult([
        finish('a', 1, 'finished', 3600),
        finish('b', 2, 'finished', 3610),
        finish('c', 3, 'finished', 3620),
      ])),
      leg('2', { lat: 0, lng: 1 }, { lat: 0, lng: 2 }, legResult([
        finish('c', 1, 'finished', 3500),
        finish('a', 2, 'finished', 3505),
        finish('b', 3, 'finished', 3520),
      ])),
    ];
    const standings = computeStandings(championship('points', racers, legs));

    // a: 25 + 18 = 43, c: 15 + 25 = 40, b: 18 + 15 = 33
    expect(standings.map((r) => r.racerId)).toEqual(['a', 'c', 'b']);
    expect(standings[0]?.points).toBe(43);
    expect(standings[0]?.rank).toBe(1);
    expect(standings[1]?.points).toBe(40);
  });
});

describe('computeStandings — time mode', () => {
  it('ranks by cumulative time, least first', () => {
    const racers = [racer('a', 'Ana', 0.9), racer('b', 'Bo', 0.8)];
    const legs = [
      leg('1', { lat: 0, lng: 0 }, { lat: 0, lng: 1 }, legResult([
        finish('a', 2, 'finished', 3700), // slower here
        finish('b', 1, 'finished', 3600),
      ])),
      leg('2', { lat: 0, lng: 1 }, { lat: 0, lng: 2 }, legResult([
        finish('a', 1, 'finished', 3400), // much faster here
        finish('b', 2, 'finished', 3800),
      ])),
    ];
    const standings = computeStandings(championship('time', racers, legs));
    // a: 7100, b: 7400 → a wins on time despite one win each
    expect(standings.map((r) => r.racerId)).toEqual(['a', 'b']);
    expect(standings[0]?.cumulativeTimeS).toBe(7100);
  });

  it('penalises a retirement above the slowest finisher', () => {
    const racers = [racer('a', 'Ana', 0.9), racer('b', 'Bo', 0.8)];
    const legs = [
      leg('1', { lat: 0, lng: 0 }, { lat: 0, lng: 1 }, legResult([
        finish('b', 1, 'finished', 3600),
        finish('a', 2, 'dnf-crash'), // retired, no time
      ])),
    ];
    const standings = computeStandings(championship('time', racers, legs));
    const ana = standings.find((r) => r.racerId === 'a');
    // slowest finisher was 3600; penalty is 1.5x = 5400
    expect(ana?.cumulativeTimeS).toBe(5400);
    expect(ana?.retirements).toBe(1);
    expect(ana?.perLeg[0]?.penalised).toBe(true);
    // b finished, so b is ahead
    expect(standings[0]?.racerId).toBe('b');
  });
});

describe('computeStandings — hybrid mode', () => {
  it('uses points to break an exact time tie', () => {
    const racers = [racer('a', 'Ana', 0.9), racer('b', 'Bo', 0.8)];
    // Identical cumulative times, but b out-scores a on points (b won a leg).
    const legs = [
      leg('1', { lat: 0, lng: 0 }, { lat: 0, lng: 1 }, legResult([
        finish('b', 1, 'finished', 3600),
        finish('a', 2, 'finished', 3700),
      ])),
      leg('2', { lat: 0, lng: 1 }, { lat: 0, lng: 2 }, legResult([
        finish('a', 1, 'finished', 3600),
        finish('b', 2, 'finished', 3700),
      ])),
    ];
    const standings = computeStandings(championship('hybrid', racers, legs));
    // both total 7300; a has 25+18, b has 18+25 → equal points too, falls to wins (1 each) then name
    expect(standings[0]?.cumulativeTimeS).toBe(standings[1]?.cumulativeTimeS);
    // With everything level, the deterministic name tiebreak decides: Ana < Bo
    expect(standings.map((r) => r.name)).toEqual(['Ana', 'Bo']);
  });

  it('lets points decide when times tie but points differ', () => {
    const racers = [racer('a', 'Ana', 0.9), racer('b', 'Bo', 0.8)];
    // Same times, but a finished top-10 both legs and b floored out of the points.
    const table = { perPosition: [25, 18], finisherFloor: 0 };
    const base = championship('hybrid', racers, [
      leg('1', { lat: 0, lng: 0 }, { lat: 0, lng: 1 }, legResult([
        finish('a', 1, 'finished', 3600),
        finish('b', 3, 'finished', 3600), // tied time, but out of points
      ])),
    ]);
    const standings = computeStandings({ ...base, pointsTable: table });
    expect(standings[0]?.racerId).toBe('a');
    expect(standings[0]?.points).toBe(25);
    expect(standings[1]?.points).toBe(0);
  });
});

describe('perLeg', () => {
  it('distinguishes a leg not raced from a retirement', () => {
    const racers = [racer('a', 'Ana', 0.9)];
    const legs = [
      leg('1', { lat: 0, lng: 0 }, { lat: 0, lng: 1 }, legResult([finish('a', 1, 'dnf-crash')])),
      leg('2', { lat: 0, lng: 1 }, { lat: 0, lng: 2 }), // not raced yet
    ];
    const standings = computeStandings(championship('points', racers, legs));
    expect(standings[0]?.perLeg[0]?.status).toBe('dnf-crash');
    expect(standings[0]?.perLeg[1]).toBeUndefined();
    expect(standings[0]?.legsCompleted).toBe(1);
  });
});

describe('linearPointsTable', () => {
  it('scores every position down to one for the last', () => {
    const table = linearPointsTable(5);
    expect(table.perPosition).toEqual([5, 4, 3, 2, 1]);
    expect(pointsForPosition(table, 5, true)).toBe(1);
  });
});

describe('findTourBreaks', () => {
  it('flags a leg whose finish is far from the next start', () => {
    const legs = [
      leg('1', { lat: 0, lng: 0 }, { lat: 0, lng: 0.001 }), // finish ~111m east of origin
      leg('2', { lat: 0, lng: 0.001 }, { lat: 0, lng: 0.002 }), // starts where 1 finished — joins
      leg('3', { lat: 1, lng: 1 }, { lat: 1, lng: 1.001 }), // starts far away — a break after leg 2
    ];
    const breaks = findTourBreaks(legs);
    expect(breaks.map((b) => b.legIndex)).toEqual([1]);
    expect(breaks[0]?.gapM).toBeGreaterThan(500);
  });

  it('returns nothing for a continuous tour', () => {
    const legs = [
      leg('1', { lat: 0, lng: 0 }, { lat: 0, lng: 0.001 }),
      leg('2', { lat: 0, lng: 0.001 }, { lat: 0, lng: 0.002 }),
    ];
    expect(findTourBreaks(legs)).toEqual([]);
  });
});

describe('legResultFromRaceResult', () => {
  it('projects finishers and omits absent optional times', () => {
    const result: RaceResult = {
      simVersion: '0.1.0',
      seed: 'seed',
      trackId: 't',
      vehicleClassId: 'road-cyclist',
      durationS: 3600,
      totalTicks: 72000,
      resultHash: 'abc',
      segments: { segmentLengthM: 0, segmentCount: 0, perRacer: [] },
      finishers: [
        {
          racerId: 'a',
          position: 1,
          status: 'finished',
          totalTimeS: 3600,
          lapsCompleted: 1,
          distanceM: 40000,
          laps: [],
          traits: {} as never,
        },
        {
          racerId: 'b',
          position: 2,
          status: 'dnf-crash',
          lapsCompleted: 0,
          distanceM: 10000,
          laps: [],
          traits: {} as never,
        },
      ],
    };
    const projected = legResultFromRaceResult(result, '2026-07-22T00:00:00.000Z');
    expect(projected.finishers[0]).toEqual({
      racerId: 'a',
      position: 1,
      status: 'finished',
      totalTimeS: 3600,
    });
    // The retirement has no time, and the field is absent rather than undefined.
    expect('totalTimeS' in projected.finishers[1]!).toBe(false);
    expect(projected.durationS).toBe(3600);
  });
});

describe('configForLeg', () => {
  it('takes the field from the championship and race settings from the leg', () => {
    const champ = championship(
      'points',
      [racer('a', 'Ana', 0.9), racer('b', 'Bo', 0.8)],
      [leg('1', { lat: 0, lng: 0 }, { lat: 0, lng: 1 })],
    );
    const config = configForLeg(champ, champ.legs[0]!);
    expect(config.trackId).toBe('track-1');
    expect(config.seed).toBe('seed-1');
    expect(config.laps).toBe(1);
    expect(config.gridOrder).toBe('reverse-skill');
    expect(config.racers.map((r) => r.id)).toEqual(['a', 'b']);
    expect(config.fieldSize).toBe(2);
  });
});

describe('progress helpers', () => {
  it('reports the next unraced leg and completion', () => {
    const racers = [racer('a', 'Ana', 0.9)];
    const done = championship('points', racers, [
      leg('1', { lat: 0, lng: 0 }, { lat: 0, lng: 1 }, legResult([finish('a', 1, 'finished', 3600)])),
      leg('2', { lat: 0, lng: 1 }, { lat: 0, lng: 2 }),
    ]);
    expect(nextLegIndex(done)).toBe(1);
    expect(isComplete(done)).toBe(false);

    const finished = {
      ...done,
      legs: done.legs.map((l) =>
        l.result ? l : { ...l, result: legResult([finish('a', 1, 'finished', 3400)]) },
      ),
    };
    expect(nextLegIndex(finished)).toBeUndefined();
    expect(isComplete(finished)).toBe(true);
  });
});
