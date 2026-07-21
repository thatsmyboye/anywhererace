import type { RacerId, Track, TrackId, VehicleClassId, WeatherSpec } from '@anywhererace/core';
import type { Personality, Traits } from './traits';
import type { DebugToggles } from './tuning';

export type GridOrder = 'random' | 'by-skill' | 'reverse-skill' | 'manual';

export type RacerSpec = {
  id: RacerId;
  name: string;
  /** Hex color for the marker. Paired with a pattern for colorblind safety. */
  color: string;
  /** Archetype id, or an inline custom personality. */
  personality: string | Personality;
  /** 0-1. Scales the performance curve; personality shapes it. */
  skill: number;
  /**
   * Grid slot, 0-based, used only when `gridOrder` is 'manual'. Ignored
   * otherwise.
   */
  gridSlot?: number;
};

export type RaceConfig = {
  trackId: TrackId;
  /** Ignored for point-to-point tracks. */
  laps: number;
  /** v1 runs one class for the whole field. */
  vehicleClassId: VehicleClassId;
  /** Always baked; never re-fetched at replay time. */
  weather: WeatherSpec;
  /** 2-40. Must equal `racers.length`. */
  fieldSize: number;
  racers: RacerSpec[];
  seed: string;
  gridOrder: GridOrder;
};

export type RaceInput = {
  track: Track;
  config: RaceConfig;
  /** Debug panel state. Defaults to everything on. */
  toggles?: Partial<DebugToggles>;
};

export type SimErrorKind =
  | 'unknown-vehicle-class'
  | 'unknown-personality'
  | 'invalid-field-size'
  | 'invalid-laps'
  | 'empty-track'
  | 'track-too-short'
  | 'duplicate-racer-id'
  | 'invalid-skill'
  | 'missing-grid-slot'
  | 'race-did-not-terminate';

export type SimError = {
  kind: SimErrorKind;
  message: string;
  /** The racer or class the error is about, when there is one. */
  subject?: string;
};

export type RacerStatus =
  | 'racing'
  | 'finished'
  | 'dnf-crash'
  | 'dnf-mechanical'
  /**
   * Still on the road when the flag fell — the leader finished long ago, or the
   * race hit its absolute time cap. Distinct from a mechanical because nothing
   * broke: they simply ran out of race. This is what a genuinely over-long
   * course (a wet bicycle ultra that cannot be done inside the cap) classifies
   * as, rather than pretending every straggler's machine failed at once.
   */
  | 'dnf-timeout';

/** Compact per-tick state. This is what the worker posts to the main thread. */
export type RacerSnapshot = {
  racerId: RacerId;
  /** Meters travelled along the route, cumulative across laps. */
  distanceAlongRoute: number;
  /** Meters from the centerline; positive is to the right of travel. */
  lateralOffset: number;
  speedMs: number;
  lap: number;
  /** 1-based. Finishers keep their finishing position. */
  position: number;
  status: RacerStatus;
};

export type RaceSnapshot = {
  tick: number;
  elapsedS: number;
  racers: RacerSnapshot[];
};

export type SectorTime = {
  sector: number;
  timeS: number;
};

export type LapRecord = {
  lap: number;
  timeS: number;
  sectors: SectorTime[];
};

export type FinishRecord = {
  racerId: RacerId;
  position: number;
  status: RacerStatus;
  /** Total race time, seconds. Undefined for a DNF. */
  totalTimeS?: number;
  /** Gap to the winner, seconds. Undefined for the winner and for DNFs. */
  gapToWinnerS?: number;
  /** Laps completed; useful for showing "+1 lap" and for DNF standings. */
  lapsCompleted: number;
  distanceM: number;
  laps: LapRecord[];
  bestLapS?: number;
  /** The traits actually used, after any Wildcard re-roll. */
  traits: Traits;
};

export type RaceResult = {
  simVersion: string;
  seed: string;
  trackId: TrackId;
  vehicleClassId: VehicleClassId;
  /** Wall-clock duration of the race in simulated seconds. */
  durationS: number;
  totalTicks: number;
  finishers: FinishRecord[];
  /** Hash of finishing order and times. See `hash.ts` for what is included. */
  resultHash: string;
};
