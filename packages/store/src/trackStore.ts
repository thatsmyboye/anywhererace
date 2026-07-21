import Dexie from 'dexie';
import type { EntityTable } from 'dexie';
import type { Track } from '@anywhererace/core';
import { err, ok } from '@anywhererace/core';
import type { Result } from '@anywhererace/core';
import type { StoredTrack, TrackSummary } from './schema';
import { STORE_VERSION, toSummary } from './schema';

/**
 * Local-first track storage on IndexedDB.
 *
 * Errors come back as typed results rather than exceptions, because every
 * failure here is one the UI has to say something about: a browser in private
 * mode with IndexedDB disabled, a quota that is full, a track that is not
 * there any more. Throwing would push all of that into a boundary that cannot
 * do anything useful with it.
 */

export type StoreErrorKind =
  | 'unavailable' // no IndexedDB — private browsing, or a locked-down browser
  | 'quota-exceeded'
  | 'not-found'
  | 'write-failed'
  | 'read-failed';

export type StoreError = {
  kind: StoreErrorKind;
  message: string;
};

export type SaveTrackInput = {
  track: Track;
  builtWith: StoredTrack['builtWith'];
  /** ISO-8601 timestamp. Injected so tests are not at the mercy of the clock. */
  now?: string;
};

export interface TrackStore {
  save(input: SaveTrackInput): Promise<Result<StoredTrack, StoreError>>;
  get(id: string): Promise<Result<StoredTrack, StoreError>>;
  list(): Promise<Result<TrackSummary[], StoreError>>;
  remove(id: string): Promise<Result<void, StoreError>>;
  rename(id: string, name: string): Promise<Result<StoredTrack, StoreError>>;
  close(): void;
}

type Schema = Dexie & {
  tracks: EntityTable<StoredTrack, 'id'>;
};

export type TrackStoreOptions = {
  /** Database name. Overridden in tests so they do not share state. */
  databaseName?: string;
  /** Dexie's IndexedDB implementation, injected for `fake-indexeddb` in tests. */
  indexedDB?: IDBFactory;
  keyRange?: typeof IDBKeyRange;
};

const DEFAULT_DATABASE_NAME = 'anywhererace';

export const createTrackStore = (options: TrackStoreOptions = {}): TrackStore => {
  const db = new Dexie(options.databaseName ?? DEFAULT_DATABASE_NAME, {
    ...(options.indexedDB ? { indexedDB: options.indexedDB } : {}),
    ...(options.keyRange ? { IDBKeyRange: options.keyRange } : {}),
  }) as Schema;

  // Only indexed fields are listed; `track` and `builtWith` are stored but not
  // indexed, which is what Dexie's syntax means by omitting them.
  db.version(STORE_VERSION).stores({
    tracks: 'id, name, updatedAt',
  });

  return {
    async save(input) {
      const timestamp = input.now ?? new Date().toISOString();
      try {
        const existing = await db.tracks.get(input.track.id);
        const record: StoredTrack = {
          id: input.track.id,
          name: input.track.name,
          // Saving over a track keeps the date it was first created.
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
          track: input.track,
          builtWith: input.builtWith,
        };
        await db.tracks.put(record);
        return ok(record);
      } catch (error: unknown) {
        return err(toStoreError(error, 'write-failed'));
      }
    },

    async get(id) {
      try {
        const record = await db.tracks.get(id);
        if (record === undefined) {
          return err({ kind: 'not-found', message: `No saved track with id "${id}".` });
        }
        return ok(record);
      } catch (error: unknown) {
        return err(toStoreError(error, 'read-failed'));
      }
    },

    async list() {
      try {
        // Most recently edited first: the track you were just working on is
        // overwhelmingly the one you want next.
        const records = await db.tracks.orderBy('updatedAt').reverse().toArray();
        return ok(records.map(toSummary));
      } catch (error: unknown) {
        return err(toStoreError(error, 'read-failed'));
      }
    },

    async remove(id) {
      try {
        await db.tracks.delete(id);
        return ok(undefined);
      } catch (error: unknown) {
        return err(toStoreError(error, 'write-failed'));
      }
    },

    async rename(id, name) {
      try {
        const record = await db.tracks.get(id);
        if (record === undefined) {
          return err({ kind: 'not-found', message: `No saved track with id "${id}".` });
        }
        const updated: StoredTrack = {
          ...record,
          name,
          // The name lives in two places — keep them from drifting apart.
          track: { ...record.track, name },
          updatedAt: new Date().toISOString(),
        };
        await db.tracks.put(updated);
        return ok(updated);
      } catch (error: unknown) {
        return err(toStoreError(error, 'write-failed'));
      }
    },

    close() {
      db.close();
    },
  };
};

/**
 * Map a Dexie or DOM exception onto something the UI can act on.
 *
 * The two worth distinguishing are a full quota — which the user can fix by
 * deleting a track — and IndexedDB being unavailable entirely, which they
 * cannot, and which needs a different message rather than a retry button.
 */
const toStoreError = (error: unknown, fallback: StoreErrorKind): StoreError => {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);

  if (name === 'QuotaExceededError' || /quota/i.test(message)) {
    return {
      kind: 'quota-exceeded',
      message: 'There is no room left to save this track. Delete a saved track and try again.',
    };
  }
  if (name === 'InvalidStateError' || /indexeddb|not supported|denied/i.test(message)) {
    return {
      kind: 'unavailable',
      message:
        'This browser will not let the app store data locally. Private browsing usually causes this.',
    };
  }
  return { kind: fallback, message };
};

/** Whether local storage is usable at all, for a warning before anyone builds. */
export const isStorageAvailable = (factory: IDBFactory | undefined = globalThis.indexedDB): boolean =>
  factory !== undefined && factory !== null;
