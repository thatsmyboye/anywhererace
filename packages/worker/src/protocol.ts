import type { Track } from '@anywhererace/core';
import type {
  DebugToggles,
  RaceConfig,
  RaceEvent,
  RaceResult,
  RaceSnapshot,
  SimError,
} from '@anywhererace/sim';

/**
 * The wire protocol between the main thread and the simulation worker.
 *
 * Everything crossing this boundary is structured-cloneable: plain objects,
 * arrays and numbers, no functions and no class instances. That rules out
 * passing a `VehicleClass` across (it holds an `accelCurve` function), which is
 * why the worker is given a `vehicleClassId` and looks the class up on its own
 * side.
 */

/** Playback rates the UI offers. `0` is paused. */
export type PlaybackSpeed = 0 | 1 | 2 | 8;

export type PlaybackOptions = {
  /**
   * How often the worker posts a frame to the main thread while playing, in Hz.
   *
   * The sim ticks at 20Hz but the UI interpolates between frames, so there is
   * no reason to post every tick. 10Hz halves the message traffic and is still
   * two frames per rendered 60fps interval at 1x.
   */
  frameHz?: number;

  /**
   * How often a frame is recorded for scrubbing, in Hz. Lower is cheaper:
   * a 40-racer frame is about 1KB, so an hour-long race at 5Hz costs roughly
   * 18MB of worker memory.
   */
  recordHz?: number;

  /**
   * Hard cap on recorded frames, so a misconfigured marathon cannot exhaust
   * memory. Once reached, recording stops but the race still runs to the end.
   */
  maxRecordedFrames?: number;
};

export const DEFAULT_PLAYBACK_OPTIONS = {
  frameHz: 10,
  recordHz: 5,
  maxRecordedFrames: 20_000,
} as const satisfies Required<PlaybackOptions>;

// --- main thread -> worker --------------------------------------------------

export type InitRequest = {
  type: 'init';
  requestId: number;
  track: Track;
  config: RaceConfig;
  toggles?: Partial<DebugToggles>;
  options?: PlaybackOptions;
};

export type PlayRequest = { type: 'play'; requestId: number; speed: Exclude<PlaybackSpeed, 0> };
export type PauseRequest = { type: 'pause'; requestId: number };
/** Run every remaining tick as fast as possible. This is "skip to end". */
export type SkipToEndRequest = { type: 'skip-to-end'; requestId: number };
/** Jump to a recorded frame. Only valid once the race has finished. */
export type SeekRequest = { type: 'seek'; requestId: number; tick: number };
export type DisposeRequest = { type: 'dispose'; requestId: number };

export type WorkerRequest =
  | InitRequest
  | PlayRequest
  | PauseRequest
  | SkipToEndRequest
  | SeekRequest
  | DisposeRequest;

/**
 * A request without its `requestId`, which the client assigns.
 *
 * `Omit` does not distribute over a union — `Omit<WorkerRequest, 'requestId'>`
 * collapses to the members' common keys and loses `speed`, `tick` and the rest.
 * The conditional type here forces the distribution.
 */
export type WorkerRequestBody = WorkerRequest extends infer R
  ? R extends WorkerRequest
    ? Omit<R, 'requestId'>
    : never
  : never;

// --- worker -> main thread --------------------------------------------------

/** Static per-racer information, sent once so frames can stay compact. */
export type RacerIdentity = {
  racerId: string;
  name: string;
  color: string;
  /** Archetype id, or 'custom' for an inline personality. */
  personalityId: string;
  skill: number;
  /** Grid slot, 0-based, front to back. */
  gridSlot: number;
};

export type ReadyMessage = {
  type: 'ready';
  requestId: number;
  racers: RacerIdentity[];
  raceDistanceM: number;
  lapLengthM: number;
  totalLaps: number;
  vehicleClassId: string;
  /** Ticks per simulated second, so the UI can convert without importing sim. */
  simHz: number;
};

export type FrameMessage = {
  type: 'frame';
  snapshot: RaceSnapshot;
  /** Events since the previous frame, in order. Never re-sent. */
  events: RaceEvent[];
  /** 0-1, by ticks elapsed against the expected total. Best-effort. */
  progress: number;
  finished: boolean;
};

export type FinishedMessage = {
  type: 'finished';
  result: RaceResult;
  /** Ticks of the recorded frames, ascending, for the scrubber. */
  recordedTicks: number[];
};

export type ErrorMessage = {
  type: 'error';
  requestId: number;
  error: SimError | { kind: 'worker-failure'; message: string };
};

export type WorkerResponse = ReadyMessage | FrameMessage | FinishedMessage | ErrorMessage;
