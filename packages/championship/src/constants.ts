import type { PointsTable } from './types';

/**
 * Tuning constants for championship scoring.
 *
 * These move standings, so they live here in one named object rather than
 * inline, per CLAUDE.md. They do not touch the sim and cannot move a
 * determinism golden — a championship is scored over race *results*, and the
 * results themselves are decided entirely inside the tick.
 */
export const CHAMPIONSHIP_SCORING = {
  /**
   * A retirement's time, for a time-based classification, expressed as a
   * multiple of the leg's slowest classified finisher.
   *
   * A retirement has no finishing time, but a general classification needs one
   * comparable number per racer per leg or the whole field cannot be ranked on
   * a single axis. Zero would reward retiring; the slowest finisher's own time
   * would treat quitting as merely finishing last, which understates it. A
   * penalty above the back marker keeps a retirement clearly worse than the
   * worst finish without being so punitive that one mechanical ends a
   * championship. 1.5x is a starting point, tunable if it feels wrong.
   */
  retirementTimePenaltyFactor: 1.5,

  /**
   * Fallback penalty base when *nobody* was classified in a leg — a wet ultra
   * that timed out for the entire field, say. There is no slowest finisher to
   * scale from, so the leg's simulated duration stands in.
   */
  retirementTimePenaltyFromDurationFactor: 1.5,
} as const;

/**
 * The default points table: Formula 1's current top-ten allocation.
 *
 * Familiar, decisive, and heavily rewards winning — a legible default that a
 * user can replace. Positions past tenth score nothing.
 */
export const F1_POINTS_TABLE: PointsTable = {
  perPosition: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
  finisherFloor: 0,
};

/**
 * A gentler alternative offered in setup: every finisher scores, top to bottom.
 * Materialised for a given field size because its length tracks the field.
 */
export const linearPointsTable = (fieldSize: number): PointsTable => ({
  perPosition: Array.from({ length: Math.max(0, fieldSize) }, (_, i) => fieldSize - i),
  finisherFloor: 1,
});

/**
 * How far apart a leg's finish and the next leg's start may be, in meters,
 * before a tour is flagged as broken. Generous: a tour is a narrative
 * continuity, not a survey-grade join, and two real courses that meet "at the
 * same place" routinely have endpoints a block apart.
 */
export const TOUR_JOIN_TOLERANCE_M = 500;
