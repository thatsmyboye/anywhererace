import type { RaceFormat } from '@anywhererace/core';
import type { GroupEvent, RaceEvent } from '@anywhererace/sim';

/**
 * Which events reach the live feed.
 *
 * Shared by the feed component and by the race client that buffers for it, and
 * that sharing is the whole reason this is its own module rather than a helper
 * inside `EventFeed`. The client keeps only the last few dozen events; if it
 * capped the raw log and the component filtered afterwards, a bunch race would
 * show an empty feed almost permanently — a 24-rider peloton emits around two
 * thousand in-bunch position changes an hour, so any recent forty of them are
 * overwhelmingly likely to contain nothing worth showing. The cap has to be
 * applied to what will actually be displayed, which means one predicate, used
 * in both places.
 *
 * Note that this filters the *feed* only. The complete event log is kept intact
 * for the results page, the charts and the race report.
 *
 * The row copy lives here too, rather than in the component. It is pure string
 * derivation with a fair amount of judgement in it — when to name a rider and
 * when to count a group, how to phrase a move so it reads like a race and not
 * like a diff — and keeping it out of the JSX is what makes it testable.
 */

export type NotableEvent = Extract<
  RaceEvent,
  { type: 'overtake' | 'group' | 'mistake' | 'crash' | 'mechanical' | 'finish' }
>;

export const isBroadcastable = (event: RaceEvent, format: RaceFormat): event is NotableEvent => {
  switch (event.type) {
    case 'overtake':
      // The one place format matters. Outside a bunch race every pass is a
      // moment; inside one, only the ones that changed real ground are — the
      // rest is the peloton breathing.
      return format === 'standard' || event.significance === 'lead-change';
    case 'group':
      // Group moves are the unit a bunch race is told in, and a strung-out
      // field produces almost none of them — so there is nothing to suppress
      // for a motor race, and no reason to make this conditional.
      return true;
    case 'mistake':
    case 'crash':
    case 'mechanical':
    case 'finish':
      return true;
    default:
      // Sector and lap crossings are in the log but would drown everything
      // else at forty racers.
      return false;
  }
};

/** Resolves a racer id to the name a viewer would recognize. */
export type NameResolver = (racerId: string) => string;

/** The short, shouty tag at the head of a feed row. */
export const eventLabel = (event: NotableEvent): string => {
  switch (event.type) {
    case 'overtake':
      return 'Pass';
    case 'group':
      return groupLabel(event);
    case 'mistake':
      return event.kind === 'spin' ? 'Spin' : 'Lock-up';
    case 'crash':
      return 'Crash';
    case 'mechanical':
      return 'Mech';
    case 'finish':
      return 'Finish';
  }
};

const groupLabel = (event: GroupEvent): string => {
  switch (event.kind) {
    case 'attack':
      return 'Attack';
    case 'bridge':
      return 'Bridge';
    case 'split':
      return 'Split';
    case 'catch':
      return 'Caught';
    case 'dropped':
      return 'Dropped';
  }
};

/** The sentence that follows it. */
export const describeEvent = (event: NotableEvent, name: NameResolver): string => {
  switch (event.type) {
    case 'overtake':
      return `${name(event.racerId)} past ${name(event.victimId)} for P${event.forPosition}`;
    case 'group':
      return describeGroupMove(event, name);
    case 'mistake':
      return `${name(event.racerId)}${event.causedByPassAttempt ? ', move gone wrong' : ''} — ${event.timeLostS.toFixed(1)}s`;
    case 'crash':
      return `${name(event.racerId)} is out on lap ${event.lap + 1}`;
    case 'mechanical':
      return `${name(event.racerId)} stops on lap ${event.lap + 1}`;
    case 'finish':
      return `${name(event.racerId)} takes P${event.position}`;
  }
};

/**
 * Named riders where a move is about one, counted groups where it is not.
 * "Rivera goes clear" reads; "1 rider goes clear" does not, and "9 riders away
 * from 14" is the only sensible way to say the other thing.
 */
const describeGroupMove = (event: GroupEvent, name: NameResolver): string => {
  const gap = `${event.gapS.toFixed(0)}s`;

  switch (event.kind) {
    case 'attack':
      return `${name(event.racerId ?? '')} goes clear of ${riders(event.chaseGroup.length)}`;
    case 'bridge':
      return `${name(event.racerId ?? '')} bridges to ${describeTarget(event.frontGroup, name)}`;
    case 'split':
      return `the group splits, ${event.frontGroup.length} away from ${event.chaseGroup.length} at ${gap}`;
    case 'catch':
      return `${describeTarget(event.frontGroup, name)} caught by ${riders(event.chaseGroup.length)}`;
    case 'dropped':
      return `${name(event.racerId ?? '')} comes off the back, ${gap} down`;
  }
};

/** A lone rider is worth naming; a group is worth counting. */
const describeTarget = (group: readonly string[], name: NameResolver): string =>
  group.length === 1 ? name(group[0] as string) : `the ${riders(group.length)} ahead`;

const riders = (count: number): string => `${count} rider${count === 1 ? '' : 's'}`;
