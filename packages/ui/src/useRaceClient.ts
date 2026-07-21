import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Track } from '@anywhererace/core';
import type { DebugToggles, RaceConfig, RaceEvent, RaceResult, RaceSnapshot } from '@anywhererace/sim';
import type { ErrorMessage, PlaybackSpeed, RaceClient, RacerIdentity } from '@anywhererace/worker';
import { createRaceClient } from '@anywhererace/worker';
import type { RacerAppearance } from './palette';
import { buildPalette } from './palette';

/**
 * React binding for the simulation worker.
 *
 * The important design decision here is what does *not* go into React state.
 * Frames arrive at 10Hz and the map renders at 60fps, so positions live in a
 * mutable ref that the map's animation loop reads directly. Putting them in
 * state would re-render the whole tree sixty times a second to move some dots.
 *
 * What does go into state is what changes slowly and must be declarative: the
 * running/finished status, the ordering for the timing tower, the recent event
 * feed, and the final result.
 */

export type RacerView = RacerIdentity & {
  appearance: RacerAppearance;
  /** 1-based race number, shown on the marker. */
  number: number;
};

/** Interpolation source, read by the map on every animation frame. */
export type FrameBuffer = {
  previous: RaceSnapshot | undefined;
  current: RaceSnapshot | undefined;
  /** `performance.now()` when `current` arrived. */
  currentAtMs: number;
  /** Milliseconds the previous frame is expected to take, for interpolation. */
  frameDurationMs: number;
};

export type RaceStatus = 'connecting' | 'ready' | 'running' | 'finished' | 'error';

export type UseRaceClientOptions = {
  track: Track;
  config: RaceConfig;
  toggles?: Partial<DebugToggles>;
  /**
   * Constructs the worker. Passed in rather than built here because every
   * bundler spells worker construction differently, and because a test can
   * hand over a fake.
   */
  createWorker: () => Worker;
  /** Maximum events kept for the live feed. Older ones are dropped. */
  eventFeedLength?: number;
};

const DEFAULT_FEED_LENGTH = 40;

/** Only used until the first two frames establish the real cadence. */
const ASSUMED_FRAME_MS = 100;

export const useRaceClient = (options: UseRaceClientOptions) => {
  const { track, config, toggles, createWorker, eventFeedLength = DEFAULT_FEED_LENGTH } = options;

  const [status, setStatus] = useState<RaceStatus>('connecting');
  const [racers, setRacers] = useState<RacerView[]>([]);
  const [snapshot, setSnapshot] = useState<RaceSnapshot | undefined>(undefined);
  const [feed, setFeed] = useState<RaceEvent[]>([]);
  /**
   * The complete log, kept separately from the capped feed because the results
   * page derives everything from it — charts, sector bests, the narrative.
   * A fifty-lap, forty-car race produces on the order of ten thousand events,
   * which is a few hundred kilobytes and well worth holding onto.
   */
  const [events, setEvents] = useState<RaceEvent[]>([]);
  const [result, setResult] = useState<RaceResult | undefined>(undefined);
  const [recordedTicks, setRecordedTicks] = useState<number[]>([]);
  const [error, setError] = useState<ErrorMessage['error'] | undefined>(undefined);
  const [speed, setSpeed] = useState<PlaybackSpeed>(0);
  const [progress, setProgress] = useState(0);

  const clientRef = useRef<RaceClient | undefined>(undefined);
  const frameRef = useRef<FrameBuffer>({
    previous: undefined,
    current: undefined,
    currentAtMs: 0,
    frameDurationMs: ASSUMED_FRAME_MS,
  });

  // The worker is created once per race. Rebuilding it on every render would
  // restart the race, so the effect deliberately depends only on identity of
  // the track and config rather than on their contents.
  useEffect(() => {
    let disposed = false;
    const worker = createWorker();

    const client = createRaceClient({
      worker,
      track,
      config,
      ...(toggles ? { toggles } : {}),
      handlers: {
        onReady: (info) => {
          if (disposed) return;
          const palette = buildPalette(info.racers.length);
          setRacers(
            info.racers.map((racer, index) => ({
              ...racer,
              number: index + 1,
              appearance: palette[index] as RacerAppearance,
            })),
          );
          setStatus('ready');
        },
        onFrame: (next, newEvents, frameProgress) => {
          if (disposed) return;
          const buffer = frameRef.current;
          const now = performance.now();
          // Measure the real gap between frames instead of assuming it: the
          // worker throttles frames, and a browser under load delivers them
          // unevenly. Interpolating against a wrong duration is what makes
          // markers stutter or run ahead and snap back.
          const measured = buffer.currentAtMs === 0 ? ASSUMED_FRAME_MS : now - buffer.currentAtMs;
          buffer.previous = buffer.current;
          buffer.current = next;
          buffer.currentAtMs = now;
          buffer.frameDurationMs = clampFrameDuration(measured);

          setSnapshot(next);
          setProgress(frameProgress);
          if (newEvents.length > 0) {
            setEvents((current) => [...current, ...newEvents]);
            setFeed((current) => [...newEvents, ...current].slice(0, eventFeedLength));
          }
          setStatus((current) => (current === 'finished' ? current : 'running'));
        },
        onFinished: (raceResult, ticks) => {
          if (disposed) return;
          setResult(raceResult);
          setRecordedTicks(ticks);
          setStatus('finished');
          setSpeed(0);
        },
        onError: (workerError) => {
          if (disposed) return;
          setError(workerError);
          setStatus('error');
        },
      },
    });

    clientRef.current = client;
    return () => {
      disposed = true;
      client.dispose();
      clientRef.current = undefined;
    };
    // Deliberately not an exhaustive dependency list. Depending on `track` and
    // `config` by identity would tear the worker down and restart the race on
    // every render; the dependencies below are the values that actually make it
    // a different race. The react-hooks eslint plugin is not installed, so this
    // is enforced by review rather than by lint.
  }, [track.id, config.seed, config.vehicleClassId, config.laps]);

  const play = useCallback((nextSpeed: Exclude<PlaybackSpeed, 0>) => {
    clientRef.current?.play(nextSpeed);
    setSpeed(nextSpeed);
  }, []);

  const pause = useCallback(() => {
    clientRef.current?.pause();
    setSpeed(0);
  }, []);

  const skipToEnd = useCallback(() => {
    clientRef.current?.skipToEnd();
    setSpeed(0);
  }, []);

  const seek = useCallback((tick: number) => {
    // Scrubbing must not interpolate from wherever the race happened to be, or
    // markers fly across the map on every drag.
    const buffer = frameRef.current;
    buffer.previous = undefined;
    clientRef.current?.seek(tick);
  }, []);

  const racersById = useMemo(
    () => new Map(racers.map((racer) => [racer.racerId, racer])),
    [racers],
  );

  return {
    status,
    error,
    racers,
    racersById,
    snapshot,
    frameRef,
    feed,
    events,
    result,
    recordedTicks,
    speed,
    progress,
    controls: { play, pause, skipToEnd, seek },
  };
};

/**
 * Keep the interpolation window sane. A backgrounded tab produces an enormous
 * measured gap, and one absurd sample would otherwise freeze the markers for
 * as long as it took to come back.
 */
const clampFrameDuration = (measuredMs: number): number =>
  Math.min(400, Math.max(30, measuredMs));
