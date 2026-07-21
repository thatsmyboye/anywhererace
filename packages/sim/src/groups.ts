import type { RacerId } from '@anywhererace/core';
import type { GroupEvent, GroupEventKind, PassSignificance, RaceEvent } from './events';
import { TICK_SECONDS, TUNING } from './tuning';

/**
 * Reading the shape of the field.
 *
 * A bike race is not told as a list of overtakes. Forty riders in a bunch swap
 * places continuously and none of it means anything; what means something is
 * that four riders went up the road, that one of them came back, that the
 * peloton split on the climb. This module derives that structure — who is
 * riding with whom — so the event log can carry it.
 *
 * **This is observation, not behavior.** Nothing here is consulted by the tick.
 * No racer goes faster or slower because of which group they are in, no roll is
 * made against any of it, and it never touches an `Rng`. It reads distances and
 * speeds that already exist and writes events. Deleting the whole file would
 * not move a single finishing time, which is exactly why it cannot move the
 * determinism goldens either.
 *
 * The behavioral half — a field that actually splits on the climbs the course
 * sweep found — is deliberately not here. See IDEAS.md.
 */

/** The minimum a racer has to be for their position in the field to be read. */
export type GroupMember = {
  readonly id: RacerId;
  readonly distanceM: number;
  readonly speedMs: number;
};

/**
 * Where a group sits in the race. Named the way a bike race is called, because
 * that is what this vocabulary is for.
 */
export type GroupRole =
  /** Out in front of the peloton. The break. */
  | 'lead'
  /** Between the lead group and the peloton. */
  | 'chase'
  /** The largest group on the road. */
  | 'peloton'
  /** Behind the peloton. The grupetto, and everyone who has come off. */
  | 'dropped';

/** The field's shape at one instant: groups front to back, members front to back. */
export type Grouping = {
  readonly groups: readonly (readonly RacerId[])[];
  readonly roles: readonly GroupRole[];
  /** Time gap from each group to the one ahead. Index 0 is always 0. */
  readonly gapsS: readonly number[];
  readonly indexOf: ReadonlyMap<RacerId, number>;
};

const EMPTY_GROUPING: Grouping = {
  groups: [],
  roles: [],
  gapsS: [],
  indexOf: new Map(),
};

/**
 * Split a field into groups on road gap.
 *
 * The gap is measured in seconds rather than meters because that is the unit a
 * bike race is called in, and because it stays meaningful across classes — see
 * `TUNING.groups.splitGapS`. Members arrive in whatever order the caller had
 * them and are sorted here, with an id tie-break, so two racers on precisely
 * the same meter can never produce a different answer on different runs.
 *
 * `previous` supplies hysteresis: two racers who were already riding together
 * stay together until they exceed `splitGapS`, while two who were not have to
 * close to the much tighter `mergeGapS` before they count as one group. Without
 * it, a field whose natural spacing sits anywhere near the threshold flaps
 * across it indefinitely and the event log fills with moves that never
 * happened. Omitting it — as a caller reading a single instant does — simply
 * applies `splitGapS` throughout.
 */
export const buildGrouping = (
  members: readonly GroupMember[],
  previous?: Grouping,
): Grouping => {
  if (members.length === 0) return EMPTY_GROUPING;

  const ordered = members
    .slice()
    .sort((a, b) => b.distanceM - a.distanceM || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const groups: RacerId[][] = [];
  const gapsS: number[] = [];
  let current: RacerId[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const racer = ordered[i] as GroupMember;
    if (i === 0) {
      current = [racer.id];
      gapsS.push(0);
      continue;
    }

    const ahead = ordered[i - 1] as GroupMember;
    // Below walking pace a time gap is meaningless and would explode; this
    // mirrors how the traffic model converts a distance gap.
    const gapS = (ahead.distanceM - racer.distanceM) / Math.max(racer.speedMs, 1);

    // Were these two already riding together? If so it takes a real gap to
    // break them up; if not it takes a real closing to put them together.
    // Where there is no history for the pair — a caller reading one instant, or
    // the very first sample of a race — the looser threshold is the neutral
    // choice: a one-shot read should not fragment a field that the tracker
    // would hold together.
    const priorAhead = previous?.indexOf.get(ahead.id);
    const priorRacer = previous?.indexOf.get(racer.id);
    const wasTogether =
      priorAhead === undefined || priorRacer === undefined || priorAhead === priorRacer;
    const threshold = wasTogether ? TUNING.groups.splitGapS : TUNING.groups.mergeGapS;

    if (gapS > threshold) {
      groups.push(current);
      gapsS.push(gapS);
      current = [racer.id];
    } else {
      current.push(racer.id);
    }
  }
  groups.push(current);

  const indexOf = new Map<RacerId, number>();
  groups.forEach((group, index) => {
    for (const id of group) indexOf.set(id, index);
  });

  return { groups, roles: assignRoles(groups), gapsS, indexOf };
};

/**
 * The peloton is the largest group; a tie goes to the one further forward,
 * because when the race is split clean in half the front half is the one still
 * racing for the win. Everything ahead of it is the break and its chasers,
 * everything behind it has been dropped.
 */
const assignRoles = (groups: readonly (readonly RacerId[])[]): GroupRole[] => {
  if (groups.length === 0) return [];

  let pelotonIndex = 0;
  for (let i = 1; i < groups.length; i++) {
    if ((groups[i] as readonly RacerId[]).length > (groups[pelotonIndex] as readonly RacerId[]).length) {
      pelotonIndex = i;
    }
  }

  return groups.map((_, index) => {
    if (index === pelotonIndex) return 'peloton';
    if (index > pelotonIndex) return 'dropped';
    return index === 0 ? 'lead' : 'chase';
  });
};

export const roleOf = (grouping: Grouping, racerId: RacerId): GroupRole | undefined => {
  const index = grouping.indexOf.get(racerId);
  return index === undefined ? undefined : grouping.roles[index];
};

/**
 * Classify a pass against the settled shape of the field.
 *
 * Judged against the *confirmed* grouping rather than an instantaneous one, so
 * a rider drifting a second over the split threshold and back does not turn an
 * ordinary bunch shuffle into a between-groups move.
 */
export const classifyPass = (
  grouping: Grouping,
  passerId: RacerId,
  victimId: RacerId,
  forPosition: number,
): PassSignificance => {
  if (forPosition === 1) return 'lead-change';
  const passerGroup = grouping.indexOf.get(passerId);
  const victimGroup = grouping.indexOf.get(victimId);
  if (passerGroup === undefined || victimGroup === undefined) return 'in-group';
  return passerGroup === victimGroup ? 'in-group' : 'between-groups';
};

/**
 * Watches the field's shape over time and emits the moves.
 *
 * Two mechanisms keep this from producing noise, and both are load-bearing:
 *
 *   Sampling. The shape is re-read once a second, not twenty times. A group
 *   forming is a thing that takes tens of seconds.
 *
 *   Confirmation. A new shape has to repeat for `confirmSamples` consecutive
 *   samples before it is believed. Gaps sit on the threshold constantly — a
 *   rider at 8.1 seconds through a corner and 7.9 on the exit has not attacked
 *   — and without this the feed would report a split and a catch every second
 *   for the length of the race.
 */
export class GroupTracker {
  private confirmed: Grouping = EMPTY_GROUPING;
  private pendingKey: string | undefined;
  private pendingCount = 0;
  private nextSampleTick = 0;
  private started = false;

  /** The settled shape of the field. What `classifyPass` should be read against. */
  get grouping(): Grouping {
    return this.confirmed;
  }

  /**
   * Re-read the field if this tick is a sampling tick, and emit any move that
   * has now been confirmed. Cheap to call every tick.
   */
  sample(
    members: readonly GroupMember[],
    tick: number,
    elapsedS: number,
    emit: (event: RaceEvent) => void,
  ): void {
    if (tick < this.nextSampleTick) return;
    this.nextSampleTick = tick + Math.max(1, Math.round(TUNING.groups.sampleIntervalS / TICK_SECONDS));

    // Built against the settled shape, not against the last sample: hysteresis
    // has to be measured from what the race currently *is*, or a group that is
    // mid-confirmation would keep redefining its own thresholds.
    const candidate = buildGrouping(members, this.confirmed);
    const key = groupingKey(candidate);

    if (key !== this.pendingKey) {
      this.pendingKey = key;
      this.pendingCount = 1;
      return;
    }

    this.pendingCount += 1;
    if (this.pendingCount < TUNING.groups.confirmSamples) return;
    if (key === groupingKey(this.confirmed)) return;

    const previous = this.confirmed;
    this.confirmed = candidate;

    // The field forming up off the line is not a race move. Adopt the first
    // settled shape silently, and stay silent until the grid has cleared.
    if (!this.started || elapsedS < TUNING.groups.settleS) {
      this.started = true;
      return;
    }

    for (const event of diffGroupings(previous, candidate, tick, elapsedS)) emit(event);
  }
}

/** Canonical string for a grouping, so two samples can be compared cheaply. */
const groupingKey = (grouping: Grouping): string =>
  grouping.groups.map((group) => group.join(',')).join('|');

/**
 * Turn a change in the field's shape into the moves that produced it.
 *
 * Merges are resolved before splits, and that order matters. A bridge is
 * simultaneously a rider leaving one group and joining another: read as a split
 * it looks exactly like an attack. Taking the merges first lets the riders who
 * were absorbed somewhere be struck out of the group they left, so a bridge is
 * reported once, as a bridge.
 */
const diffGroupings = (
  previous: Grouping,
  current: Grouping,
  tick: number,
  atS: number,
): GroupEvent[] => {
  // Only racers present in both readings. Someone who crashed or finished in
  // between has not changed the shape of the race by leaving it.
  const shared = new Set<RacerId>();
  for (const id of previous.indexOf.keys()) {
    if (current.indexOf.has(id)) shared.add(id);
  }
  if (shared.size === 0) return [];

  const events: GroupEvent[] = [];
  const absorbed = new Set<RacerId>();

  // --- merges ------------------------------------------------------------
  for (let index = 0; index < current.groups.length; index++) {
    const origins = partitionBy(
      (current.groups[index] as readonly RacerId[]).filter((id) => shared.has(id)),
      (id) => previous.indexOf.get(id) as number,
    );
    if (origins.length < 2) continue;

    // Front to back by where they came from: the frontmost is the group that
    // was caught, the rest are the ones that arrived.
    const [head, ...joiners] = origins;
    if (head === undefined) continue;

    for (const joiner of joiners) {
      for (const id of joiner.members) absorbed.add(id);
      const kind: GroupEventKind = joiner.members.length === 1 ? 'bridge' : 'catch';
      events.push(
        makeEvent(kind, head.members, joiner.members, previous, head.key, joiner.key, tick, atS,
          kind === 'bridge' ? joiner.members[0] : undefined),
      );
    }
  }

  // --- splits ------------------------------------------------------------
  for (let index = 0; index < previous.groups.length; index++) {
    const remaining = (previous.groups[index] as readonly RacerId[]).filter(
      (id) => shared.has(id) && !absorbed.has(id),
    );
    const fragments = partitionBy(remaining, (id) => current.indexOf.get(id) as number);
    if (fragments.length < 2) continue;

    const front = fragments[0] as Partition;
    const back = fragments[fragments.length - 1] as Partition;

    // A rider going clear off the front is an attack; one coming off the back
    // is dropped. Front takes precedence when a group sheds both at once —
    // the race is up the road, not out the back.
    const kind: GroupEventKind =
      fragments.length === 2 && front.members.length === 1
        ? 'attack'
        : fragments.length === 2 && back.members.length === 1
          ? 'dropped'
          : 'split';

    const subject =
      kind === 'attack' ? front.members[0] : kind === 'dropped' ? back.members[0] : undefined;

    events.push(
      makeEvent(kind, front.members, back.members, current, front.key, back.key, tick, atS, subject),
    );
  }

  return events;
};

type Partition = { key: number; members: RacerId[] };

/** Group ids by a bucket, keeping both the buckets and their members front to back. */
const partitionBy = (ids: readonly RacerId[], bucketOf: (id: RacerId) => number): Partition[] => {
  const byBucket = new Map<number, RacerId[]>();
  for (const id of ids) {
    const key = bucketOf(id);
    const existing = byBucket.get(key);
    if (existing === undefined) byBucket.set(key, [id]);
    else existing.push(id);
  }
  return [...byBucket.entries()]
    .map(([key, members]) => ({ key, members }))
    .sort((a, b) => a.key - b.key);
};

const makeEvent = (
  kind: GroupEventKind,
  frontGroup: readonly RacerId[],
  chaseGroup: readonly RacerId[],
  grouping: Grouping,
  frontKey: number,
  chaseKey: number,
  tick: number,
  atS: number,
  racerId: RacerId | undefined,
): GroupEvent => {
  const event: GroupEvent = {
    type: 'group',
    kind,
    tick,
    atS,
    frontGroup: [...frontGroup],
    chaseGroup: [...chaseGroup],
    gapS: gapBetween(grouping, frontKey, chaseKey),
  };
  if (racerId !== undefined) event.racerId = racerId;
  return event;
};

/**
 * Road gap between two groups. `gapsS[i]` is the gap from group `i` to the one
 * directly ahead, so the distance across a span is the sum of the gaps it
 * crosses — almost always one, since groups that interact are adjacent.
 */
const gapBetween = (grouping: Grouping, frontIndex: number, chaseIndex: number): number => {
  let total = 0;
  for (let i = frontIndex + 1; i <= chaseIndex; i++) total += grouping.gapsS[i] ?? 0;
  return total;
};
