
import type { RaceEvent } from '@anywhererace/sim';
import type { RacerView } from '../useRaceClient';

/**
 * A running feed of notable moments.
 *
 * This exists because the event log already carries everything needed for it —
 * typed overtakes with both racers and the position fought over, mistakes with
 * their cause and cost, crashes with the lap. Rendering it is nearly free and
 * it answers the question the map cannot: *what just happened over there?*
 *
 * Only the events a spectator would point at are shown. Sector and lap
 * crossings are in the log but would drown everything else at forty racers.
 */

export type EventFeedProps = {
  events: readonly RaceEvent[];
  racersById: ReadonlyMap<string, RacerView>;
  limit?: number;
};

const DEFAULT_LIMIT = 8;

export const EventFeed = ({ events, racersById, limit = DEFAULT_LIMIT }: EventFeedProps) => {
  const notable = events.filter(isNotable).slice(0, limit);
  if (notable.length === 0) return null;

  return (
    <ul className="flex w-[19rem] flex-col gap-1">
      {notable.map((event, index) => (
        <li
          key={`${event.tick}-${event.type}-${index}`}
          className="flex items-baseline gap-2 rounded border border-[#2b3543] bg-[#161b24]/85 px-2.5 py-1.5 text-xs backdrop-blur"
        >
          <span className="shrink-0 tabular-nums text-[#8d9bb0]">{clockLabel(event.atS)}</span>
          <span className={`shrink-0 font-semibold uppercase ${toneClass(event)}`}>
            {label(event)}
          </span>
          <span className="min-w-0 flex-1 truncate text-[#e6ebf2]">
            {describe(event, racersById)}
          </span>
        </li>
      ))}
    </ul>
  );
};

/**
 * Always `m:ss`, even under a minute. The shared duration formatter drops the
 * minutes for short times, which in a list of timestamps reads as a bare number
 * — "30" next to "1:05" looks like two different kinds of thing.
 */
const clockLabel = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
};

type NotableEvent = Extract<
  RaceEvent,
  { type: 'overtake' | 'mistake' | 'crash' | 'mechanical' | 'finish' }
>;

const isNotable = (event: RaceEvent): event is NotableEvent =>
  event.type === 'overtake' ||
  event.type === 'mistake' ||
  event.type === 'crash' ||
  event.type === 'mechanical' ||
  event.type === 'finish';

const label = (event: NotableEvent): string => {
  switch (event.type) {
    case 'overtake':
      return 'Pass';
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

const toneClass = (event: NotableEvent): string => {
  switch (event.type) {
    case 'overtake':
      return 'text-[#3ddc97]';
    case 'mistake':
      return 'text-[#ffb020]';
    case 'crash':
    case 'mechanical':
      return 'text-[#ff5c5c]';
    case 'finish':
      return 'text-[#4da3ff]';
  }
};

const describe = (event: NotableEvent, racersById: ReadonlyMap<string, RacerView>): string => {
  const name = (id: string): string => racersById.get(id)?.name ?? id;

  switch (event.type) {
    case 'overtake':
      return `${name(event.racerId)} past ${name(event.victimId)} for P${event.forPosition}`;
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
