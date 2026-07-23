import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { DRY_STILL_CONDITIONS } from '@anywhererace/core';
import type { WeatherSpec } from '@anywhererace/core';
import type { Championship, LegResult } from '@anywhererace/championship';
import { createTrackStore } from '../src/trackStore';
import type { TrackStore } from '../src/trackStore';

const DRY: WeatherSpec = { kind: 'manual', conditions: DRY_STILL_CONDITIONS };

/**
 * Championship persistence, against fake-indexeddb. A championship is stored
 * whole and read whole; these pin down the round-trip and that the list
 * summary reports progress and a leader without walking every leg.
 */

let store: TrackStore;
let counter = 0;

beforeEach(() => {
  counter += 1;
  store = createTrackStore({
    databaseName: `champ-test-${counter}`,
    indexedDB: new IDBFactory(),
    keyRange: IDBKeyRange,
  });
});

const legResult = (winnerId: string): LegResult => ({
  simVersion: '0.1.0',
  resultHash: 'hash',
  durationS: 3600,
  completedAt: '2026-07-22T00:00:00.000Z',
  finishers: [
    { racerId: winnerId, position: 1, status: 'finished', totalTimeS: 3600 },
    { racerId: winnerId === 'a' ? 'b' : 'a', position: 2, status: 'finished', totalTimeS: 3650 },
  ],
});

const championship = (id: string, legsRaced: number): Championship => ({
  id,
  name: 'Grand Tour',
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
  tour: true,
  scoring: 'time',
  pointsTable: { perPosition: [25, 18], finisherFloor: 0 },
  gridOrder: 'reverse-skill',
  racers: [
    { id: 'a', name: 'Ana', color: '#111111', personality: 'metronome', skill: 0.9 },
    { id: 'b', name: 'Bo', color: '#222222', personality: 'charger', skill: 0.8 },
  ],
  legs: [
    {
      id: 'l1',
      trackId: 't1',
      trackName: 'Stage 1',
      trackMode: 'point-to-point',
      startPoint: { lat: 0, lng: 0 },
      finishPoint: { lat: 0, lng: 0.01 },
      vehicleClassId: 'road-cyclist',
      laps: 1,
      weather: DRY,
      seed: 's1',
      ...(legsRaced >= 1 ? { result: legResult('a') } : {}),
    },
    {
      id: 'l2',
      trackId: 't2',
      trackName: 'Stage 2',
      trackMode: 'point-to-point',
      startPoint: { lat: 0, lng: 0.01 },
      finishPoint: { lat: 0, lng: 0.02 },
      vehicleClassId: 'road-cyclist',
      laps: 1,
      weather: DRY,
      seed: 's2',
      ...(legsRaced >= 2 ? { result: legResult('a') } : {}),
    },
  ],
});

describe('championship persistence', () => {
  it('round-trips a championship whole', async () => {
    const saved = await store.saveChampionship({
      championship: championship('c1', 1),
      now: '2026-07-22T10:00:00Z',
    });
    expect(saved.ok).toBe(true);

    const loaded = await store.getChampionship('c1');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.legs).toHaveLength(2);
    expect(loaded.value.legs[0]?.result?.finishers[0]?.racerId).toBe('a');
    expect(loaded.value.updatedAt).toBe('2026-07-22T10:00:00Z');
  });

  it('keeps the creation date when saving over a championship', async () => {
    await store.saveChampionship({ championship: championship('c1', 1), now: '2026-07-20T10:00:00Z' });
    const again = await store.saveChampionship({
      championship: championship('c1', 2),
      now: '2026-07-22T10:00:00Z',
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.createdAt).toBe('2026-07-20T10:00:00Z');
    expect(again.value.updatedAt).toBe('2026-07-22T10:00:00Z');
  });

  it('summarises progress and a leader once a leg has run', async () => {
    await store.saveChampionship({ championship: championship('c1', 1), now: '2026-07-22T10:00:00Z' });
    const list = await store.listChampionships();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const row = list.value[0];
    expect(row?.legCount).toBe(2);
    expect(row?.completedLegs).toBe(1);
    expect(row?.fieldSize).toBe(2);
    expect(row?.leaderName).toBe('Ana');
  });

  it('names no leader before any leg has run', async () => {
    await store.saveChampionship({ championship: championship('c1', 0), now: '2026-07-22T10:00:00Z' });
    const list = await store.listChampionships();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value[0]?.completedLegs).toBe(0);
    expect(list.value[0]?.leaderName).toBeUndefined();
  });

  it('reports a missing championship rather than returning undefined', async () => {
    const result = await store.getChampionship('nope');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });

  it('removes a championship', async () => {
    await store.saveChampionship({ championship: championship('c1', 1) });
    await store.removeChampionship('c1');
    const list = await store.listChampionships();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(0);
  });
});
