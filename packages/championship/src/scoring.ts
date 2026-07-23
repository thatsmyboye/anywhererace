import { haversineMeters } from '@anywhererace/core';
import type { RacerId } from '@anywhererace/core';
import { isRetirement } from '@anywhererace/sim';
import type { RaceConfig, RaceResult, RacerStatus } from '@anywhererace/sim';
import { CHAMPIONSHIP_SCORING, TOUR_JOIN_TOLERANCE_M } from './constants';
import type {
  Championship,
  ChampionshipLeg,
  LegFinish,
  LegResult,
  PointsTable,
  ScoringMode,
} from './types';

/**
 * One racer's line in the standings table.
 *
 * `perLeg` is index-aligned with `championship.legs`: a `undefined` cell is a
 * leg not yet run, which is different from a leg run and retired from (a cell
 * with a retirement status). The table has to be able to draw that difference —
 * a blank future round is not the same as a DNF.
 */
export type StandingRow = {
  racerId: RacerId;
  name: string;
  /** 1-based, after ranking. Ties are broken deterministically, never shared. */
  rank: number;
  points: number;
  /**
   * Cumulative time across completed legs, seconds, retirements penalised. Only
   * meaningful for ranking because the field is fixed and everyone contests
   * every completed leg.
   */
  cumulativeTimeS: number;
  legsCompleted: number;
  wins: number;
  retirements: number;
  perLeg: (LegStanding | undefined)[];
};

export type LegStanding = {
  position: number;
  status: RacerStatus;
  points: number;
  /** The time that entered `cumulativeTimeS`: real for a finish, penalty for a DNF. */
  scoredTimeS: number;
  /** True when `scoredTimeS` is a retirement penalty rather than a real time. */
  penalised: boolean;
};

/**
 * Points for a finishing position under a table.
 *
 * A retirement scores nothing regardless of where it is classified — a rider
 * who crashed out on lap one is often "classified" ahead of one who finished a
 * lap down, and paying the crash for that would be perverse.
 */
export const pointsForPosition = (
  table: PointsTable,
  position: number,
  isFinisher: boolean,
): number => {
  if (!isFinisher) return 0;
  const listed = table.perPosition[position - 1];
  if (listed !== undefined) return listed;
  return table.finisherFloor ?? 0;
};

/**
 * The time a racer contributes to a time classification for one leg.
 *
 * A finisher contributes their real total. A retirement has no time, so it is
 * charged a penalty scaled off the leg's slowest finisher — or, if the whole
 * field failed to be classified, off the leg's duration. See
 * `CHAMPIONSHIP_SCORING`.
 */
export const scoredTimeForLeg = (leg: ChampionshipLeg, finish: LegFinish): number => {
  if (finish.totalTimeS !== undefined && !isRetirement(finish.status)) {
    return finish.totalTimeS;
  }
  return retirementPenaltyS(leg);
};

const retirementPenaltyS = (leg: ChampionshipLeg): number => {
  const result = leg.result;
  if (result === undefined) return 0;
  const finisherTimes = result.finishers
    .filter((f) => f.totalTimeS !== undefined && !isRetirement(f.status))
    .map((f) => f.totalTimeS as number);
  if (finisherTimes.length > 0) {
    return Math.max(...finisherTimes) * CHAMPIONSHIP_SCORING.retirementTimePenaltyFactor;
  }
  return result.durationS * CHAMPIONSHIP_SCORING.retirementTimePenaltyFromDurationFactor;
};

/**
 * Compute the standings table for a championship.
 *
 * Pure and deterministic: same championship in, same table out. Only legs that
 * have been run contribute; an empty championship yields every racer level on
 * zero. The comparator depends on the scoring mode, and every tie is broken to
 * a total order so the table never depends on sort stability.
 */
export const computeStandings = (championship: Championship): StandingRow[] => {
  const { racers, legs, pointsTable, scoring } = championship;

  const rows: StandingRow[] = racers.map((racer) => {
    const perLeg: (LegStanding | undefined)[] = [];
    let points = 0;
    let cumulativeTimeS = 0;
    let legsCompleted = 0;
    let wins = 0;
    let retirements = 0;

    for (const leg of legs) {
      const finish = leg.result?.finishers.find((f) => f.racerId === racer.id);
      if (leg.result === undefined || finish === undefined) {
        perLeg.push(undefined);
        continue;
      }
      const finisher = !isRetirement(finish.status);
      const legPoints = pointsForPosition(pointsTable, finish.position, finisher);
      const scoredTimeS = scoredTimeForLeg(leg, finish);

      points += legPoints;
      cumulativeTimeS += scoredTimeS;
      legsCompleted += 1;
      if (finisher && finish.position === 1) wins += 1;
      if (!finisher) retirements += 1;

      perLeg.push({
        position: finish.position,
        status: finish.status,
        points: legPoints,
        scoredTimeS,
        penalised: !finisher,
      });
    }

    return {
      racerId: racer.id,
      name: racer.name,
      rank: 0,
      points,
      cumulativeTimeS,
      legsCompleted,
      wins,
      retirements,
      perLeg,
    };
  });

  rows.sort(comparatorFor(scoring));
  rows.forEach((row, index) => {
    row.rank = index + 1;
  });
  return rows;
};

/**
 * The ranking comparator for each mode.
 *
 * The three modes differ only in what leads and what breaks a tie:
 * - `points` — most points; ties to less cumulative time, then more wins, then name.
 * - `time` — least cumulative time; ties to more wins, then more points, then name.
 * - `hybrid` — least cumulative time, but points break an exact time tie before
 *   anything else. This is the "time, points decide a dead heat" the championship
 *   was set up to want.
 *
 * Name is the final, total-ordering tiebreak so the sort never leans on
 * stability and the table is identical on every machine.
 */
const comparatorFor = (mode: ScoringMode) => (a: StandingRow, b: StandingRow): number => {
  const byName = a.name.localeCompare(b.name);
  const byPointsDesc = b.points - a.points;
  const byTimeAsc = a.cumulativeTimeS - b.cumulativeTimeS;
  const byWinsDesc = b.wins - a.wins;

  if (mode === 'points') {
    return byPointsDesc || byTimeAsc || byWinsDesc || byName;
  }
  if (mode === 'hybrid') {
    return byTimeAsc || byPointsDesc || byWinsDesc || byName;
  }
  // time
  return byTimeAsc || byWinsDesc || byPointsDesc || byName;
};

/**
 * Fold a finished race into the compact projection a championship stores.
 *
 * `completedAt` is injected rather than read from the clock, so this stays pure
 * and testable — nothing in this package calls `Date.now()`. Optional fields
 * are spread conditionally because `exactOptionalPropertyTypes` is on: an
 * absent time must be absent, not `undefined`.
 */
export const legResultFromRaceResult = (result: RaceResult, completedAt: string): LegResult => ({
  simVersion: result.simVersion,
  resultHash: result.resultHash,
  durationS: result.durationS,
  completedAt,
  finishers: result.finishers.map((f) => ({
    racerId: f.racerId,
    position: f.position,
    status: f.status,
    ...(f.totalTimeS === undefined ? {} : { totalTimeS: f.totalTimeS }),
    ...(f.gapToWinnerS === undefined ? {} : { gapToWinnerS: f.gapToWinnerS }),
  })),
});

/**
 * Build the race config for a leg.
 *
 * The field is the championship's, verbatim: same ids, names, colours,
 * personalities and skills every leg, which is what keeps the standings keyed
 * to stable racers. Everything race-specific — track, vehicle, laps, weather,
 * seed — comes off the leg. This is the one place a leg becomes something the
 * sim can run.
 */
export const configForLeg = (championship: Championship, leg: ChampionshipLeg): RaceConfig => ({
  trackId: leg.trackId,
  laps: leg.trackMode === 'circuit' ? leg.laps : 1,
  vehicleClassId: leg.vehicleClassId,
  weather: leg.weather,
  fieldSize: championship.racers.length,
  racers: championship.racers.map((racer) => ({
    id: racer.id,
    name: racer.name,
    color: racer.color,
    personality: racer.personality,
    skill: racer.skill,
  })),
  seed: leg.seed,
  gridOrder: championship.gridOrder,
});

export type TourBreak = {
  /** The leg whose finish fails to meet the next leg's start. */
  legIndex: number;
  gapM: number;
};

/**
 * Where a tour's legs fail to join up.
 *
 * Returns one entry per gap between consecutive legs that exceeds the
 * tolerance. Empty means every leg's finish is within tolerance of the next
 * one's start — a continuous journey. This validates and reports; it never
 * rewrites geometry, which is a deliberate scope line for this build.
 */
export const findTourBreaks = (legs: readonly ChampionshipLeg[]): TourBreak[] => {
  const breaks: TourBreak[] = [];
  for (let i = 0; i < legs.length - 1; i += 1) {
    const here = legs[i];
    const next = legs[i + 1];
    if (here === undefined || next === undefined) continue;
    const gapM = haversineMeters(here.finishPoint, next.startPoint);
    if (gapM > TOUR_JOIN_TOLERANCE_M) breaks.push({ legIndex: i, gapM });
  }
  return breaks;
};

/** Whether every leg of a championship has been raced. */
export const isComplete = (championship: Championship): boolean =>
  championship.legs.length > 0 && championship.legs.every((leg) => leg.result !== undefined);

/** The index of the next leg to race, or undefined when the championship is done. */
export const nextLegIndex = (championship: Championship): number | undefined => {
  const index = championship.legs.findIndex((leg) => leg.result === undefined);
  return index === -1 ? undefined : index;
};
