import type { Track } from '@anywhererace/core';
import type { DebugToggles, RaceConfig, RaceEvent, RaceResult, RaceSnapshot } from '@anywhererace/sim';
import type {
  ErrorMessage,
  PlaybackOptions,
  PlaybackSpeed,
  RacerIdentity,
  ReadyMessage,
  WorkerRequest,
  WorkerRequestBody,
  WorkerResponse,
} from './protocol';

/**
 * Main-thread handle on a simulation worker.
 *
 * The UI never talks to `packages/sim` directly — it talks to this. That is
 * what keeps the guarantee that fast-forwarding a fifty-lap race cannot freeze
 * the interface: every tick of work happens on the other side of this
 * boundary.
 */

export type RaceClientEvents = {
  /** Fired once, after the worker has validated the config and built the race. */
  onReady?: (info: ReadyMessage) => void;
  /**
   * Fired on every posted frame. `events` are only the ones since the previous
   * frame — the client does not accumulate them for you, because a long race
   * produces tens of thousands and most consumers only want the recent ones.
   */
  onFrame?: (snapshot: RaceSnapshot, events: RaceEvent[], progress: number) => void;
  onFinished?: (result: RaceResult, recordedTicks: number[]) => void;
  onError?: (error: ErrorMessage['error']) => void;
};

export type RaceClient = {
  play(speed: Exclude<PlaybackSpeed, 0>): void;
  pause(): void;
  skipToEnd(): void;
  /** Only meaningful once the race has finished. */
  seek(tick: number): void;
  /** Terminates the worker. The client is unusable afterwards. */
  dispose(): void;
};

export type CreateRaceClientOptions = {
  /**
   * The worker to drive. Constructing it is the caller's job because every
   * bundler spells that differently — Vite wants
   * `new Worker(new URL('@anywhererace/worker/worker', import.meta.url), { type: 'module' })`.
   * Taking the instance rather than a URL keeps this package free of bundler
   * assumptions and makes it trivial to substitute a fake in tests.
   */
  worker: Worker;
  track: Track;
  config: RaceConfig;
  toggles?: Partial<DebugToggles>;
  playback?: PlaybackOptions;
  handlers?: RaceClientEvents;
};

export const createRaceClient = (options: CreateRaceClientOptions): RaceClient => {
  const { worker, handlers = {} } = options;
  let requestId = 0;
  let disposed = false;

  const send = (request: WorkerRequestBody): void => {
    if (disposed) return;
    requestId += 1;
    worker.postMessage({ ...request, requestId } as WorkerRequest);
  };

  worker.onmessage = (event: MessageEvent<WorkerResponse>): void => {
    const message = event.data;
    switch (message.type) {
      case 'ready':
        handlers.onReady?.(message);
        return;
      case 'frame':
        handlers.onFrame?.(message.snapshot, message.events, message.progress);
        return;
      case 'finished':
        handlers.onFinished?.(message.result, message.recordedTicks);
        return;
      case 'error':
        handlers.onError?.(message.error);
        return;
    }
  };

  worker.onerror = (event: ErrorEvent): void => {
    handlers.onError?.({
      kind: 'worker-failure',
      message: event.message || 'The simulation worker failed to start.',
    });
  };

  send({
    type: 'init',
    track: options.track,
    config: options.config,
    ...(options.toggles ? { toggles: options.toggles } : {}),
    ...(options.playback ? { options: options.playback } : {}),
  });

  return {
    play: (speed) => send({ type: 'play', speed }),
    pause: () => send({ type: 'pause' }),
    skipToEnd: () => send({ type: 'skip-to-end' }),
    seek: (tick) => send({ type: 'seek', tick }),
    dispose: () => {
      if (disposed) return;
      send({ type: 'dispose' });
      disposed = true;
      worker.terminate();
    },
  };
};

export type { RacerIdentity, ReadyMessage };
