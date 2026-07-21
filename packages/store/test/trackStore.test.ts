import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTrackStore, isStorageAvailable } from '../src/trackStore';
import { normalizeDegraded } from '../src/schema';
import type { TrackStore } from '../src/trackStore';
import { makeSyntheticTrack } from '../../sim/test/fixtures';

/**
 * Storage tests against fake-indexeddb. Each test gets its own database and its
 * own IDBFactory, so nothing leaks between them.
 */

const builtWith = {
  routing: 'valhalla',
  elevation: 'open-topo-data',
  degraded: { routing: false, elevation: false },
};

let store: TrackStore;
let counter = 0;

beforeEach(() => {
  counter += 1;
  store = createTrackStore({
    databaseName: `test-${counter}`,
    indexedDB: new IDBFactory(),
    keyRange: IDBKeyRange,
  });
});

const track = (id: string, name = 'Test track') => ({
  ...makeSyntheticTrack({ lengthM: 1000, mode: 'circuit' as const }),
  id,
  name,
});

describe('saving and reading tracks', () => {
  it('round-trips a baked track', async () => {
    const saved = await store.save({ track: track('t1'), builtWith, now: '2026-07-21T10:00:00Z' });
    expect(saved.ok).toBe(true);

    const loaded = await store.get('t1');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    // The baked nodes must survive: re-deriving them would need the router and
    // the DEM, and a saved track has to work with no network at all.
    expect(loaded.value.track.nodes.length).toBeGreaterThan(100);
    expect(loaded.value.track.nodes[0]?.curvatureRadius).toBeDefined();
    expect(loaded.value.builtWith.routing).toBe('valhalla');
  });

  it('reports a missing track rather than returning undefined', async () => {
    const result = await store.get('nope');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });

  it('keeps the original creation date when saving over a track', async () => {
    await store.save({ track: track('t1'), builtWith, now: '2026-07-01T10:00:00Z' });
    const again = await store.save({
      track: track('t1', 'Renamed'),
      builtWith,
      now: '2026-07-21T10:00:00Z',
    });

    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.createdAt).toBe('2026-07-01T10:00:00Z');
    expect(again.value.updatedAt).toBe('2026-07-21T10:00:00Z');
  });

  it('survives a reopened database', async () => {
    // The whole point of local-first: a reload must not lose the track.
    const factory = new IDBFactory();
    const first = createTrackStore({ databaseName: 'persist', indexedDB: factory, keyRange: IDBKeyRange });
    await first.save({ track: track('t1'), builtWith });
    first.close();

    const second = createTrackStore({ databaseName: 'persist', indexedDB: factory, keyRange: IDBKeyRange });
    const loaded = await second.get('t1');
    expect(loaded.ok).toBe(true);
    second.close();
  });
});

describe('listing tracks', () => {
  it('summarises without loading every node', async () => {
    await store.save({ track: track('t1', 'Alpha'), builtWith });
    const list = await store.list();

    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value[0]?.name).toBe('Alpha');
    expect(list.value[0]?.nodeCount).toBeGreaterThan(100);
    expect(list.value[0]?.mode).toBe('circuit');
    expect(list.value[0]).not.toHaveProperty('track');
  });

  it('puts the most recently edited track first', async () => {
    await store.save({ track: track('old', 'Old'), builtWith, now: '2026-01-01T00:00:00Z' });
    await store.save({ track: track('new', 'New'), builtWith, now: '2026-07-01T00:00:00Z' });
    await store.save({ track: track('mid', 'Mid'), builtWith, now: '2026-04-01T00:00:00Z' });

    const list = await store.list();
    if (!list.ok) throw new Error('expected a list');
    expect(list.value.map((entry) => entry.name)).toEqual(['New', 'Mid', 'Old']);
  });

  it('returns an empty list rather than failing on a fresh database', async () => {
    const list = await store.list();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toEqual([]);
  });

  it('records which services were degraded, not merely that one was', async () => {
    // A synthetic route is not a real place; synthetic terrain is real streets
    // with invented hills. Collapsing the two into one flag would make the
    // track list wrong about whichever case it was not written for.
    await store.save({
      track: track('t1'),
      builtWith: {
        routing: 'valhalla',
        elevation: 'mock-elevation',
        degraded: { routing: false, elevation: true },
      },
    });
    const list = await store.list();
    if (!list.ok) throw new Error('expected a list');
    expect(list.value[0]?.degraded).toEqual({ routing: false, elevation: true });
  });

  it('reads a legacy boolean flag as both services degraded', async () => {
    // Records written before this became per-service are still in real
    // browsers. Over-reporting is the safe direction: it never presents
    // synthetic data as real.
    expect(normalizeDegraded(true)).toEqual({ routing: true, elevation: true });
    expect(normalizeDegraded(false)).toEqual({ routing: false, elevation: false });
    expect(normalizeDegraded(undefined)).toEqual({ routing: false, elevation: false });
  });
});

describe('renaming and deleting', () => {
  it('renames in both places so they cannot drift', async () => {
    await store.save({ track: track('t1', 'Before'), builtWith });
    const renamed = await store.rename('t1', 'After');

    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.value.name).toBe('After');
    expect(renamed.value.track.name).toBe('After');
  });

  it('refuses to rename a track that is not there', async () => {
    const result = await store.rename('nope', 'x');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });

  it('deletes', async () => {
    await store.save({ track: track('t1'), builtWith });
    expect((await store.remove('t1')).ok).toBe(true);
    expect((await store.get('t1')).ok).toBe(false);
  });

  it('treats deleting a missing track as success', async () => {
    // The end state the caller wanted is the end state they got.
    expect((await store.remove('never-existed')).ok).toBe(true);
  });
});

describe('storage availability', () => {
  it('detects a browser with no IndexedDB', () => {
    expect(isStorageAvailable(undefined)).toBe(false);
    expect(isStorageAvailable(new IDBFactory())).toBe(true);
  });
});
