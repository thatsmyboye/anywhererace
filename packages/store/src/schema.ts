import type { Track } from '@anywhererace/core';
import type { Championship, ScoringMode } from '@anywhererace/championship';
import { computeStandings } from '@anywhererace/championship';
import type { RaceConfig, RacerSpec } from '@anywhererace/sim';

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
export const STORE_VERSION = 4;

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

/**
 * A saved roster: a named list of name / colour / personality / skill rows.
 *
 * This is a **template**, not an entity. Nothing about a race ever writes back
 * into it — no results, no form, no rating, no record of having been used.
 * CLAUDE.md rules persistent racer careers out rather than deferring them, and
 * the absence of any result field here is that rule made structural: there is
 * nowhere for a career to accumulate even if someone later tried.
 */
export type StoredRosterPreset = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Grid slots are deliberately dropped; they belong to a race, not a roster. */
  racers: RosterRow[];
};

/** Exactly the columns CLAUDE.md specifies for a roster row. */
export type RosterRow = Pick<RacerSpec, 'name' | 'color' | 'skill'> & {
  /** Archetype id. Inline custom personalities are not stored yet. */
  personality: string;
};

export type RosterPresetSummary = {
  id: string;
  name: string;
  updatedAt: string;
  racerCount: number;
};

export const toPresetSummary = (preset: StoredRosterPreset): RosterPresetSummary => ({
  id: preset.id,
  name: preset.name,
  updatedAt: preset.updatedAt,
  racerCount: preset.racers.length,
});

/**
 * A finished race, stored as its **inputs**.
 *
 * The simulation is deterministic, so the seed and config *are* the race —
 * storing the finishing order as well would duplicate something already
 * determined, and would rot the moment the sim changed underneath it. Opening a
 * saved race re-runs it.
 *
 * `simVersion` and `resultHash` are what make that honest. Any change to the
 * tick, the vehicle data or the tuning constants alters results; on reopening,
 * the recomputed hash is compared against the stored one and a mismatch is
 * shown to the user rather than papered over. This is the same contract
 * `SharedRace` will need, which is why it is shaped this way now.
 */
export type StoredRace = {
  id: string;
  trackId: string;
  createdAt: string;
  config: RaceConfig;
  simVersion: string;
  /** Hash of the finishing order and times when this race was saved. */
  resultHash: string;
  /** Enough to list a race without re-simulating it. */
  summary: RaceSummaryLine;
};

export type RaceSummaryLine = {
  trackName: string;
  vehicleLabel: string;
  laps: number;
  fieldSize: number;
  winnerName: string;
  /** Gap from the winner to second place. Undefined if nobody finished. */
  marginS?: number;
  retirements: number;
};

export type StoredRaceSummary = Pick<StoredRace, 'id' | 'trackId' | 'createdAt' | 'simVersion'> & {
  summary: RaceSummaryLine;
};

export const toRaceSummary = (race: StoredRace): StoredRaceSummary => ({
  id: race.id,
  trackId: race.trackId,
  createdAt: race.createdAt,
  simVersion: race.simVersion,
  summary: race.summary,
});

/**
 * A stored championship.
 *
 * The `Championship` document is self-contained and stored whole, exactly like
 * a track: it is only ever read in full, and normalising its legs or racers
 * into their own tables would buy nothing but joins. Its own `id` is the
 * primary key.
 *
 * Unlike a `StoredRace`, a championship keeps each completed leg's finishing
 * order rather than only inputs. That is not a career sneaking back in — it is
 * the standings ledger, which belongs to the championship, not to any racer —
 * and it is what lets a standings table be drawn without re-running every leg.
 * Each leg still carries the `simVersion` it ran under, so a leg raced on a
 * since-changed sim can be flagged rather than silently trusted.
 */
export type StoredChampionship = Championship;

/** What a championship list needs without walking every leg's finishing order. */
export type ChampionshipSummary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  scoring: ScoringMode;
  tour: boolean;
  fieldSize: number;
  legCount: number;
  completedLegs: number;
  /** The current leader's name, once any leg has been run. */
  leaderName?: string;
};

export const toChampionshipSummary = (championship: StoredChampionship): ChampionshipSummary => {
  const completedLegs = championship.legs.filter((leg) => leg.result !== undefined).length;
  // Only compute a leader once there is a race to lead: an all-zero table has
  // no meaningful order beyond the name tiebreak, and calling someone the
  // leader of a championship nobody has raced yet would be a small lie.
  const leaderName =
    completedLegs > 0 ? computeStandings(championship)[0]?.name : undefined;
  return {
    id: championship.id,
    name: championship.name,
    createdAt: championship.createdAt,
    updatedAt: championship.updatedAt,
    scoring: championship.scoring,
    tour: championship.tour,
    fieldSize: championship.racers.length,
    legCount: championship.legs.length,
    completedLegs,
    ...(leaderName === undefined ? {} : { leaderName }),
  };
};
