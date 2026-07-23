import type { LatLng, RacerId, TrackId, TrackMode, VehicleClassId, WeatherSpec } from '@anywhererace/core';
import type { GridOrder, RacerStatus } from '@anywhererace/sim';

/**
 * A championship is a sequence of races over a fixed field.
 *
 * It is compatible with the sim's statelessness *because* the standings live
 * here, outside the sim, and nothing a race produces is ever written back into
 * a racer. A racer has no career, no rating, no form carried between legs — the
 * only thing that accumulates is this ledger, and it is the championship's, not
 * the racer's. See CLAUDE.md: persistent racer careers are ruled out, not
 * deferred, and this feature does not reopen that.
 *
 * The field is the load-bearing constraint. Every leg is raced by the same
 * racers under the same ids, which is what makes a standings table meaningful
 * and, for a time-based championship, what makes cumulative time comparable —
 * everyone contests every leg, so everyone's total covers the same races.
 */

export type ChampionshipId = string;

/**
 * How a championship is won.
 *
 * - `time` — cumulative race time across every leg, lowest wins. A Grand Tour's
 *   general classification. A retirement is not a blank; it is scored with a
 *   time penalty (see `scoring.ts`) so the axis stays comparable.
 * - `points` — a points table applied to each leg's finishing order, highest
 *   total wins. Rewards winning over turning up.
 * - `hybrid` — time is the contest and points break a dead heat. This is the
 *   user-chosen meaning: rank by cumulative time exactly as `time` does, but
 *   when two racers are level on time the one with more points is ahead.
 */
export type ScoringMode = 'time' | 'points' | 'hybrid';

/**
 * Points awarded by finishing position.
 *
 * `perPosition[0]` is the winner's points, `perPosition[1]` second, and so on.
 * A position past the end of the array scores `finisherFloor` if the racer was
 * classified as a finisher, and nothing if they retired. Configurable per
 * championship — the user picks the table at setup, defaulting to the F1-style
 * one in `constants.ts`.
 */
export type PointsTable = {
  perPosition: number[];
  /** Points for a classified finish below the table. Defaults to 0. */
  finisherFloor?: number;
};

/**
 * A racer in the field, materialised onto the championship as a copy.
 *
 * This is deliberately a snapshot, not a link to a roster preset: a preset is a
 * template that can be edited or deleted, and a championship in progress cannot
 * have its field change underneath its standings. Colour is fixed here at
 * creation, assigned from the OkLCH palette by grid position, so the
 * two-channel colourblind guarantee holds for the whole championship.
 */
export type ChampionshipRacer = {
  id: RacerId;
  name: string;
  color: string;
  /** Archetype id. Inline custom personalities are not stored yet. */
  personality: string;
  /** 0-1. */
  skill: number;
};

/**
 * One leg of a championship: a single race, referencing a saved track.
 *
 * The track is referenced by id rather than embedded — the store holds it, and
 * a championship of ten legs should not duplicate ten baked tracks. The few
 * fields denormalised here (`trackName`, `trackMode`, endpoints) are what the
 * championship needs to list, validate tour continuity, and build a race
 * config without loading every track's nodes.
 *
 * Weather is baked per leg at the moment the leg is added, exactly as a
 * standalone race bakes it, and never re-fetched — a championship has to replay
 * identically later. The seed is per leg so two legs on the same track are
 * genuinely different races.
 */
export type ChampionshipLeg = {
  id: string;
  trackId: TrackId;
  trackName: string;
  trackMode: TrackMode;
  /** First point of the route; used for tour continuity checks. */
  startPoint: LatLng;
  /** Last point of the route; used for tour continuity checks. */
  finishPoint: LatLng;
  vehicleClassId: VehicleClassId;
  /** Circuit only; ignored for point-to-point. */
  laps: number;
  weather: WeatherSpec;
  seed: string;
  /** Present once the leg has been raced. Absent means "not run yet". */
  result?: LegResult;
};

/**
 * The standings-relevant projection of a finished leg.
 *
 * Unlike a standalone race — which stores only its inputs and re-runs to get a
 * result — a championship keeps each leg's finishing order, because the
 * standings are the whole point and re-running every leg to redraw a table
 * would be both slow and pointless. `simVersion` and `resultHash` keep it
 * honest: reopening a championship recomputes nothing silently, and a leg run
 * under a since-changed sim is flagged rather than trusted.
 */
export type LegResult = {
  simVersion: string;
  resultHash: string;
  /** Simulated duration, seconds. Used as the base for a retirement penalty. */
  durationS: number;
  /** ISO-8601, when this leg was completed and recorded. */
  completedAt: string;
  finishers: LegFinish[];
};

export type LegFinish = {
  racerId: RacerId;
  /** 1-based finishing position. */
  position: number;
  status: RacerStatus;
  /** Total race time, seconds. Absent for a retirement. */
  totalTimeS?: number;
  /** Gap to the leg winner, seconds. Absent for the winner and retirements. */
  gapToWinnerS?: number;
};

export type Championship = {
  id: ChampionshipId;
  name: string;
  /** ISO-8601. */
  createdAt: string;
  updatedAt: string;
  /**
   * Tour-style: the finish of each leg is meant to be the start of the next.
   * This build validates and presents continuity but does not stitch geometry —
   * legs are added as-is and a break is warned about, not prevented.
   */
  tour: boolean;
  scoring: ScoringMode;
  pointsTable: PointsTable;
  /** Grid order used for every leg. Fixed championship-wide for consistency. */
  gridOrder: GridOrder;
  /** The fixed field. Same racers, same ids, every leg. */
  racers: ChampionshipRacer[];
  legs: ChampionshipLeg[];
};
