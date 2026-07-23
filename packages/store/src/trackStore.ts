import Dexie from 'dexie';
import type { EntityTable } from 'dexie';
import type { Championship } from '@anywhererace/championship';
import type { Track } from '@anywhererace/core';
import { err, ok } from '@anywhererace/core';
import type { Result } from '@anywhererace/core';
import type {
  ChampionshipSummary,
  RosterPresetSummary,
  RosterRow,
  StoredChampionship,
  StoredRace,
  StoredRaceSummary,
  StoredRosterPreset,
  StoredTrack,
  TrackSummary,
} from './schema';
import {
  STORE_VERSION,
  toChampionshipSummary,
  toPresetSummary,
  toRaceSummary,
  toSummary,
} from './schema';

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

  saveRosterPreset(input: SaveRosterPresetInput): Promise<Result<StoredRosterPreset, StoreError>>;
  listRosterPresets(): Promise<Result<RosterPresetSummary[], StoreError>>;
  getRosterPreset(id: string): Promise<Result<StoredRosterPreset, StoreError>>;
  removeRosterPreset(id: string): Promise<Result<void, StoreError>>;

  saveRace(race: StoredRace): Promise<Result<StoredRace, StoreError>>;
  listRaces(trackId?: string): Promise<Result<StoredRaceSummary[], StoreError>>;
  getRace(id: string): Promise<Result<StoredRace, StoreError>>;
  removeRace(id: string): Promise<Result<void, StoreError>>;

  saveChampionship(
    input: SaveChampionshipInput,
  ): Promise<Result<StoredChampionship, StoreError>>;
  listChampionships(): Promise<Result<ChampionshipSummary[], StoreError>>;
  getChampionship(id: string): Promise<Result<StoredChampionship, StoreError>>;
  removeChampionship(id: string): Promise<Result<void, StoreError>>;

  close(): void;
}

export type SaveChampionshipInput = {
  championship: Championship;
  /** ISO-8601 timestamp. Injected so tests are not at the mercy of the clock. */
  now?: string;
};

export type SaveRosterPresetInput = {
  id: string;
  name: string;
  racers: readonly RosterRow[];
  now?: string;
};

type Schema = Dexie & {
  tracks: EntityTable<StoredTrack, 'id'>;
  rosterPresets: EntityTable<StoredRosterPreset, 'id'>;
  races: EntityTable<StoredRace, 'id'>;
  championships: EntityTable<StoredChampionship, 'id'>;
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
  // Dexie migrates forward on open; adding a table needs no data migration.
  db.version(STORE_VERSION).stores({
    tracks: 'id, name, updatedAt',
    rosterPresets: 'id, name, updatedAt',
    // Indexed by track so a track's races can be listed, and by date for
    // ordering. Nothing is indexed by racer: there is no per-racer history to
    // query, by design.
    races: 'id, trackId, createdAt',
    // Standings are held on the championship document, not indexed here — a
    // championship is only ever read whole, and there is nothing to query
    // across championships by racer, again by design.
    championships: 'id, name, updatedAt',
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

    async saveRosterPreset(input) {
      const timestamp = input.now ?? new Date().toISOString();
      try {
        const existing = await db.rosterPresets.get(input.id);
        const record: StoredRosterPreset = {
          id: input.id,
          name: input.name,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
          // Copied field by field rather than spread, so that a caller handing
          // over a full RacerSpec cannot smuggle race-specific state — a grid
          // slot, or anything a future change adds — into a reusable template.
          racers: input.racers.map((racer) => ({
            name: racer.name,
            color: racer.color,
            personality: racer.personality,
            skill: racer.skill,
          })),
        };
        await db.rosterPresets.put(record);
        return ok(record);
      } catch (error: unknown) {
        return err(toStoreError(error, 'write-failed'));
      }
    },

    async listRosterPresets() {
      try {
        const records = await db.rosterPresets.orderBy('updatedAt').reverse().toArray();
        return ok(records.map(toPresetSummary));
      } catch (error: unknown) {
        return err(toStoreError(error, 'read-failed'));
      }
    },

    async getRosterPreset(id) {
      try {
        const record = await db.rosterPresets.get(id);
        if (record === undefined) {
          return err({ kind: 'not-found', message: `No saved roster with id "${id}".` });
        }
        return ok(record);
      } catch (error: unknown) {
        return err(toStoreError(error, 'read-failed'));
      }
    },

    async removeRosterPreset(id) {
      try {
        await db.rosterPresets.delete(id);
        return ok(undefined);
      } catch (error: unknown) {
        return err(toStoreError(error, 'write-failed'));
      }
    },

    async saveRace(race) {
      try {
        await db.races.put(race);
        return ok(race);
      } catch (error: unknown) {
        return err(toStoreError(error, 'write-failed'));
      }
    },

    async listRaces(trackId) {
      try {
        const records =
          trackId === undefined
            ? await db.races.orderBy('createdAt').reverse().toArray()
            : await db.races.where('trackId').equals(trackId).reverse().sortBy('createdAt');
        return ok(records.map(toRaceSummary));
      } catch (error: unknown) {
        return err(toStoreError(error, 'read-failed'));
      }
    },

    async getRace(id) {
      try {
        const record = await db.races.get(id);
        if (record === undefined) {
          return err({ kind: 'not-found', message: `No saved race with id "${id}".` });
        }
        return ok(record);
      } catch (error: unknown) {
        return err(toStoreError(error, 'read-failed'));
      }
    },

    async removeRace(id) {
      try {
        await db.races.delete(id);
        return ok(undefined);
      } catch (error: unknown) {
        return err(toStoreError(error, 'write-failed'));
      }
    },

    async saveChampionship(input) {
      const timestamp = input.now ?? new Date().toISOString();
      try {
        const existing = await db.championships.get(input.championship.id);
        const record: StoredChampionship = {
          ...input.championship,
          // The store owns these timestamps, exactly as it does for a track:
          // the first save stamps the creation date, later saves keep it. The
          // document's own `createdAt` is not a second source of truth.
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        await db.championships.put(record);
        return ok(record);
      } catch (error: unknown) {
        return err(toStoreError(error, 'write-failed'));
      }
    },

    async listChampionships() {
      try {
        const records = await db.championships.orderBy('updatedAt').reverse().toArray();
        return ok(records.map(toChampionshipSummary));
      } catch (error: unknown) {
        return err(toStoreError(error, 'read-failed'));
      }
    },

    async getChampionship(id) {
      try {
        const record = await db.championships.get(id);
        if (record === undefined) {
          return err({ kind: 'not-found', message: `No saved championship with id "${id}".` });
        }
        return ok(record);
      } catch (error: unknown) {
        return err(toStoreError(error, 'read-failed'));
      }
    },

    async removeChampionship(id) {
      try {
        await db.championships.delete(id);
        return ok(undefined);
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
