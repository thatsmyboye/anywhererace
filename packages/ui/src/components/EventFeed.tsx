
import type { RaceFormat } from '@anywhererace/core';
import type { RaceEvent } from '@anywhererace/sim';
import type { NotableEvent } from '../feed';
import { describeEvent, eventLabel, isBroadcastable } from '../feed';
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
 *
 * **What counts as notable depends on the format.** A motor race is told pass
 * by pass and every one of them is worth showing. A bunch race is not: a
 * 24-rider peloton generates around two thousand position changes in an hour,
 * essentially all of them riders shuffling inside the same group, and showing
 * them buries the twenty-odd moments that decide the race. So a cycling feed
 * drops in-bunch shuffling and shows what a commentator would call instead —
 * the attacks, the bridges, the splits, the catches — which the sim has already
 * classified for us in `groups.ts`. Nothing is discarded from the log; this is
 * purely which of it reaches the screen.
 */

export type EventFeedProps = {
  events: readonly RaceEvent[];
  racersById: ReadonlyMap<string, RacerView>;
  limit?: number;
  /**
   * Which broadcast rule to apply. Defaults to `'standard'` — show everything —
   * so a caller that has not thought about it gets the old behavior rather than
   * a silently quieter race.
   */
  format?: RaceFormat;
};

const DEFAULT_LIMIT = 8;

export const EventFeed = ({
  events,
  racersById,
  limit = DEFAULT_LIMIT,
  format = 'standard',
}: EventFeedProps) => {
  // The client has usually filtered already; filtering again is cheap and keeps
  // the component correct for a caller that hands it a raw log.
  const notable = events.filter((event) => isBroadcastable(event, format)).slice(0, limit);
  if (notable.length === 0) return null;

  return (
    <ul className="flex w-[19rem] max-w-full flex-col gap-1">
      {notable.map((event, index) => (
        <li
          key={`${event.tick}-${event.type}-${index}`}
          className="flex items-baseline gap-2 rounded border border-[#2b3543] bg-[#161b24]/85 px-2.5 py-1.5 text-xs backdrop-blur"
        >
          <span className="shrink-0 tabular-nums text-[#8d9bb0]">{clockLabel(event.atS)}</span>
          <span className={`shrink-0 font-semibold uppercase ${toneClass(event)}`}>
            {eventLabel(event)}
          </span>
          <span className="min-w-0 flex-1 truncate text-[#e6ebf2]">
            {describeEvent(event, (id) => racersById.get(id)?.name ?? id)}
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

const toneClass = (event: NotableEvent): string => {
  switch (event.type) {
    case 'overtake':
      return 'text-[#3ddc97]';
    case 'group':
      // Group moves read as the same kind of good news as a pass, except a
      // rider going out the back, which is a loss like a mistake is.
      return event.kind === 'dropped' ? 'text-[#ffb020]' : 'text-[#3ddc97]';
    case 'mistake':
      return 'text-[#ffb020]';
    case 'crash':
    case 'mechanical':
      return 'text-[#ff5c5c]';
    case 'finish':
      return 'text-[#4da3ff]';
  }
};
