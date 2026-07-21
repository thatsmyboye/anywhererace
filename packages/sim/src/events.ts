import type { RacerId } from '@anywhererace/core';

/**
 * The event log.
 *
 * Notable moments are typed events, not strings, because the same log has to
 * feed the incident timeline, the results narrative, the commentary, and the
 * shareable summary. Anything a viewer would point at and say "did you see
 * that" belongs in here.
 */

type EventBase = {
  /** Sim tick the event occurred on. */
  tick: number;
  /** Seconds since the green flag. Redundant with tick, but every consumer wants it. */
  atS: number;
};

export type RaceStartEvent = EventBase & {
  type: 'race-start';
  /** Grid order, front to back. */
  grid: RacerId[];
};

export type LapEvent = EventBase & {
  type: 'lap';
  racerId: RacerId;
  lap: number;
  lapTimeS: number;
  /** True if this is the racer's own fastest lap so far. */
  personalBest: boolean;
  /** True if this is the fastest lap by anyone so far. */
  raceBest: boolean;
};

export type SectorEvent = EventBase & {
  type: 'sector';
  racerId: RacerId;
  lap: number;
  sector: number;
  timeS: number;
  personalBest: boolean;
  raceBest: boolean;
};

export type OvertakeEvent = EventBase & {
  type: 'overtake';
  racerId: RacerId;
  /** Who was passed. */
  victimId: RacerId;
  /** Position the passer moved into. */
  forPosition: number;
  distanceM: number;
};

export type FailedPassEvent = EventBase & {
  type: 'failed-pass';
  racerId: RacerId;
  defenderId: RacerId;
  distanceM: number;
  timeLostS: number;
};

export type MistakeKind = 'lockup' | 'spin';

export type MistakeEvent = EventBase & {
  type: 'mistake';
  racerId: RacerId;
  kind: MistakeKind;
  timeLostS: number;
  distanceM: number;
  /** Set when the mistake came out of a failed overtake rather than the racer's own error. */
  causedByPassAttempt: boolean;
};

export type CrashEvent = EventBase & {
  type: 'crash';
  racerId: RacerId;
  distanceM: number;
  lap: number;
};

export type MechanicalEvent = EventBase & {
  type: 'mechanical';
  racerId: RacerId;
  distanceM: number;
  lap: number;
};

export type FinishEvent = EventBase & {
  type: 'finish';
  racerId: RacerId;
  position: number;
  totalTimeS: number;
};

export type RaceEndEvent = EventBase & {
  type: 'race-end';
  /** Why the race stopped, for the rare non-obvious cases. */
  reason: 'all-classified' | 'timeout-after-leader' | 'hard-tick-cap';
};

export type RaceEvent =
  | RaceStartEvent
  | LapEvent
  | SectorEvent
  | OvertakeEvent
  | FailedPassEvent
  | MistakeEvent
  | CrashEvent
  | MechanicalEvent
  | FinishEvent
  | RaceEndEvent;

export type RaceEventType = RaceEvent['type'];

/** Narrow the log to one event type without a cast at every call site. */
export const eventsOfType = <T extends RaceEventType>(
  events: readonly RaceEvent[],
  type: T,
): Extract<RaceEvent, { type: T }>[] =>
  events.filter((e): e is Extract<RaceEvent, { type: T }> => e.type === type);
