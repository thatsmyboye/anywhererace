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

/**
 * How much a pass is worth saying out loud.
 *
 * Every pass is still logged — this only says which ones matter, so a consumer
 * can decide without re-deriving the field's shape. It exists because a bunch
 * race generates hundreds of position changes that mean nothing: forty riders
 * shuffling inside a peloton is not forty overtakes, it is one peloton.
 */
export type PassSignificance =
  /** For the race lead. Always worth reporting, in any format. */
  | 'lead-change'
  /** The two racers were in different groups on the road: real ground changed hands. */
  | 'between-groups'
  /** A shuffle inside a single bunch. The noise a cycling feed suppresses. */
  | 'in-group';

export type OvertakeEvent = EventBase & {
  type: 'overtake';
  racerId: RacerId;
  /** Who was passed. */
  victimId: RacerId;
  /** Position the passer moved into. */
  forPosition: number;
  distanceM: number;
  /**
   * Classified against the group structure at the time of the pass. Always
   * present — the sim knows which group each racer was in and a consumer does
   * not, so leaving this to be inferred downstream would mean inferring it
   * wrong.
   */
  significance: PassSignificance;
};

/** What happened to the shape of the field. See `groups.ts`. */
export type GroupEventKind =
  /** One racer went clear of the group they were in. */
  | 'attack'
  /** One racer crossed the gap from their group to the one ahead. */
  | 'bridge'
  /** A group came apart into two. */
  | 'split'
  /** A group caught the one ahead and the two became one. */
  | 'catch'
  /** One racer came off the back of the group they were in. */
  | 'dropped';

/**
 * A change in the shape of the field: the unit a bunch race is actually told
 * in. Emitted for every race, not just cycling ones — a strung-out field simply
 * produces very few of them, which is itself the correct description of it.
 */
export type GroupEvent = EventBase & {
  type: 'group';
  kind: GroupEventKind;
  /**
   * The racer the move is about: the attacker, the bridger, the dropped rider.
   * Absent for `split` and `catch`, which are about groups rather than anyone
   * in particular.
   */
  racerId?: RacerId;
  /** Racers in the group at the front of the move, front to back. */
  frontGroup: RacerId[];
  /** Racers in the group behind it, front to back. */
  chaseGroup: RacerId[];
  /** Road gap between the two groups at the moment the move was confirmed. */
  gapS: number;
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
  | GroupEvent
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
