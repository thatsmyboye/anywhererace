import type { Track } from '@anywhererace/core';

/**
 * What is stored locally, and what deliberately is not.
 *
 * Local-first: a saved track has to work with no network at all, which means
 * the *baked* nodes are stored, not just the waypoints. Re-deriving them would
 * need the router and the DEM, and a track saved today has to still race in a
 * tunnel tomorrow.
 *
 * Nothing here accumulates against a racer. There is no career, no ELO, no form
 * carried between races — that is ruled out in CLAUDE.md, not merely deferred,
 * and the absence of a results table is deliberate.
 */

/** Bumped whenever the stored shape changes. Dexie migrates on open. */
export const STORE_VERSION = 1;

export type StoredTrack = {
  /** Primary key. Same id the `Track` carries. */
  id: string;
  name: string;
  /** ISO-8601. Stored as a string so it survives structured clone unambiguously. */
  createdAt: string;
  updatedAt: string;
  /**
   * The full baked track. Stored whole rather than normalised: it is a single
   * self-contained document, it is only ever read as a whole, and splitting the
   * nodes into their own table would buy nothing but joins.
   */
  track: Track;
  /**
   * Which providers produced it. Worth keeping: a track built while the router
   * was degraded to the mock is not the same artefact as one built against
   * real OSM data, and a user should be able to tell.
   */
  builtWith: {
    routing: string;
    elevation: string;
    /**
     * Which services fell back while this track was built.
     *
     * Recorded per service rather than as one flag, because they mean
     * completely different things: a synthetic *route* is not a real place at
     * all, while synthetic *terrain* means real streets with invented hills.
     * Telling a user "synthetic" when only the DEM was unavailable would be
     * needlessly alarming and, more to the point, wrong.
     */
    degraded: DegradedSources;
  };
};

export type DegradedSources = {
  routing: boolean;
  elevation: boolean;
};

/** What a track list needs, without deserialising every node of every track. */
export type TrackSummary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  mode: Track['mode'];
  routingProfile: Track['routingProfile'];
  lengthMeters: number;
  nodeCount: number;
  degraded: DegradedSources;
};

export const toSummary = (stored: StoredTrack): TrackSummary => ({
  id: stored.id,
  name: stored.name,
  createdAt: stored.createdAt,
  updatedAt: stored.updatedAt,
  mode: stored.track.mode,
  routingProfile: stored.track.routingProfile,
  lengthMeters: stored.track.lengthMeters,
  nodeCount: stored.track.nodes.length,
  degraded: normalizeDegraded(stored.builtWith.degraded),
});

/**
 * Tolerate the older single-boolean shape.
 *
 * IndexedDB keeps whatever was written, so a record saved before this became
 * per-service is still out there in someone's browser. Treating a bare `true`
 * as "both" is the safe reading — it over-reports rather than quietly
 * presenting synthetic data as real.
 */
export const normalizeDegraded = (value: DegradedSources | boolean | undefined): DegradedSources => {
  if (typeof value === 'boolean') return { routing: value, elevation: value };
  return { routing: value?.routing ?? false, elevation: value?.elevation ?? false };
};
