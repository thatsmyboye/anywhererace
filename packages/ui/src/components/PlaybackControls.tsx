import { formatDurationS } from '@anywhererace/core';
import type { PlaybackSpeed } from '@anywhererace/worker';

/**
 * Transport controls.
 *
 * The speeds are the ones CLAUDE.md specifies — pause, 1x, 2x, 8x, skip to end
 * — and they are all the same code path underneath: the worker simply runs more
 * ticks per wall-clock second. The scrubber only appears once the race is over,
 * because seeking mid-race would mean either re-simulating from the start or
 * pretending a race that has not happened yet can be rewound.
 */

const SPEEDS: Exclude<PlaybackSpeed, 0>[] = [1, 2, 8];

export type PlaybackControlsProps = {
  speed: PlaybackSpeed;
  finished: boolean;
  elapsedS: number;
  progress: number;
  /** Ticks of the recorded frames, for the scrubber. Empty until finished. */
  recordedTicks: readonly number[];
  currentTick: number;
  simHz: number;
  onPlay: (speed: Exclude<PlaybackSpeed, 0>) => void;
  onPause: () => void;
  onSkipToEnd: () => void;
  onSeek: (tick: number) => void;
};

export const PlaybackControls = ({
  speed,
  finished,
  elapsedS,
  progress,
  recordedTicks,
  currentTick,
  simHz,
  onPlay,
  onPause,
  onSkipToEnd,
  onSeek,
}: PlaybackControlsProps) => {
  const lastTick = recordedTicks[recordedTicks.length - 1] ?? 0;

  return (
    <div className="pointer-events-auto flex w-full max-w-2xl flex-col gap-2 rounded-lg border border-[#2b3543] bg-[#161b24]/90 px-3 py-2 backdrop-blur">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onPause}
          disabled={finished || speed === 0}
          className={buttonClass(speed === 0 && !finished)}
          aria-label="Pause"
        >
          Pause
        </button>

        {SPEEDS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onPlay(option)}
            disabled={finished}
            className={buttonClass(speed === option)}
            aria-label={`Play at ${option} times speed`}
            aria-pressed={speed === option}
          >
            {option}x
          </button>
        ))}

        <button
          type="button"
          onClick={onSkipToEnd}
          disabled={finished}
          className={buttonClass(false)}
        >
          Skip to end
        </button>

        <span className="ml-auto text-sm tabular-nums text-[#e6ebf2]">
          {formatDurationS(elapsedS, 1)}
        </span>
      </div>

      {finished && recordedTicks.length > 1 ? (
        <label className="flex items-center gap-2 text-xs text-[#8d9bb0]">
          <span className="sr-only">Scrub through the race</span>
          <input
            type="range"
            min={0}
            max={lastTick}
            value={Math.min(currentTick, lastTick)}
            step={Math.max(1, Math.round(simHz / 5))}
            onChange={(event) => onSeek(Number(event.target.value))}
            className="h-1 w-full cursor-pointer appearance-none rounded bg-[#2b3543] accent-[#4da3ff]"
          />
        </label>
      ) : (
        // Progress is a rough estimate from expected duration, so it is drawn
        // as a bar rather than a percentage that would visibly lie.
        <div className="h-1 w-full overflow-hidden rounded bg-[#2b3543]">
          <div
            className="h-full rounded bg-[#4da3ff] transition-[width] duration-200"
            style={{ width: `${Math.round(Math.min(1, progress) * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
};

const buttonClass = (active: boolean): string =>
  [
    'rounded px-2.5 py-1 text-sm font-medium transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-40',
    active
      ? 'bg-[#4da3ff] text-[#0b0e13]'
      : 'bg-[#1f2632] text-[#e6ebf2] hover:bg-[#2b3543] disabled:hover:bg-[#1f2632]',
  ].join(' ');
