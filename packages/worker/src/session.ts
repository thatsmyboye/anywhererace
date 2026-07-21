import type { RaceEvent, RaceRunner, RaceSnapshot } from '@anywhererace/sim';
import { SIM_HZ, createRace, getArchetype } from '@anywhererace/sim';
import type { RacerIdentity, WorkerRequest, WorkerResponse } from './protocol';
import { DEFAULT_PLAYBACK_OPTIONS } from './protocol';

/**
 * The playback engine, with no dependency on `self`, `postMessage` or any real
 * timer.
 *
 * Keeping it separate from `worker.ts` means the whole thing — play, pause,
 * speed changes, fast-forward chunking, seeking — is unit-testable in Node
 * against a fake clock. `worker.ts` is then a twenty-line adapter that cannot
 * really be wrong.
 *
 * On determinism: this class reads a wall clock, but only ever to decide *how
 * many* ticks to run. No time value is passed into the simulation, which
 * advances purely in fixed 50ms steps. Watching a race at 1x, at 8x, and
 * skipping straight to the end all produce byte-identical results.
 */

export type SessionClock = {
  /** Monotonic milliseconds. */
  now: () => number;
  /** Schedule a callback; returns a handle that `clearTimer` accepts. */
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (handle: number) => void;
};

type Mode =
  | { kind: 'idle' }
  | { kind: 'playing'; speed: number }
  | { kind: 'skipping' }
  | { kind: 'finished' };

/**
 * Ticks run per chunk while fast-forwarding before yielding to the event loop.
 *
 * The worker never blocks the main thread, but it can block *itself*, and a
 * blocked worker cannot see a pause or dispose message. Yielding every few
 * thousand ticks keeps controls responsive during a skip-to-end while costing
 * almost nothing: at roughly a microsecond per tick-racer this is a few
 * milliseconds of work per chunk.
 */
const SKIP_CHUNK_TICKS = 500;

/**
 * Chunks per yield. This is a *tick* budget, deliberately independent of the
 * clock: browsers coarsen `performance.now()` when the page is not
 * cross-origin-isolated, and a clock that appears not to advance would
 * otherwise let the loop below run to the end of the race without ever
 * yielding — exactly the freeze this design exists to prevent. The time budget
 * is the secondary guard, not the only one.
 */
const SKIP_MAX_CHUNKS_PER_YIELD = 4;

/** How often to post a progress frame while fast-forwarding, in ms. */
const SKIP_PROGRESS_INTERVAL_MS = 100;

/** Pump interval while playing. Fast enough that 8x stays smooth. */
const PLAY_PUMP_INTERVAL_MS = 25;

export class RaceSession {
  private runner: RaceRunner | undefined;
  private mode: Mode = { kind: 'idle' };
  private timer: number | undefined;

  private frameEveryMs = 1000 / DEFAULT_PLAYBACK_OPTIONS.frameHz;
  private recordEveryTicks = SIM_HZ / DEFAULT_PLAYBACK_OPTIONS.recordHz;
  private maxRecordedFrames: number = DEFAULT_PLAYBACK_OPTIONS.maxRecordedFrames;

  private lastPumpAtMs = 0;
  private lastFrameAtMs = 0;
  /** Fractional ticks carried between pumps, so playback does not drift slow. */
  private tickDebt = 0;
  /** Index of the next event in the runner's log that has not been posted. */
  private sentEvents = 0;

  private readonly recorded: RaceSnapshot[] = [];
  private expectedTicks = 1;
  private disposed = false;

  constructor(
    private readonly post: (message: WorkerResponse) => void,
    private readonly clock: SessionClock,
  ) {}

  handle(request: WorkerRequest): void {
    if (this.disposed && request.type !== 'dispose') return;

    switch (request.type) {
      case 'init':
        this.init(request);
        return;
      case 'play':
        if (this.runner === undefined || this.mode.kind === 'finished') return;
        this.stopTimer();
        this.mode = { kind: 'playing', speed: request.speed };
        this.lastPumpAtMs = this.clock.now();
        this.tickDebt = 0;
        this.scheduleTimer(() => this.pump(), PLAY_PUMP_INTERVAL_MS);
        return;
      case 'pause':
        if (this.mode.kind === 'finished') return;
        this.stopTimer();
        this.mode = { kind: 'idle' };
        // Post immediately so the UI settles on the exact paused frame rather
        // than wherever the last throttled frame happened to land.
        this.postFrame();
        return;
      case 'skip-to-end':
        if (this.runner === undefined || this.mode.kind === 'finished') return;
        this.stopTimer();
        this.mode = { kind: 'skipping' };
        this.scheduleTimer(() => this.skipChunk(), 0);
        return;
      case 'seek':
        this.seek(request.tick);
        return;
      case 'dispose':
        this.dispose();
        return;
    }
  }

  dispose(): void {
    this.stopTimer();
    this.disposed = true;
    this.runner = undefined;
    this.recorded.length = 0;
  }

  private init(request: Extract<WorkerRequest, { type: 'init' }>): void {
    const options = { ...DEFAULT_PLAYBACK_OPTIONS, ...request.options };
    this.frameEveryMs = 1000 / Math.max(1, options.frameHz);
    this.recordEveryTicks = Math.max(1, Math.round(SIM_HZ / Math.max(1, options.recordHz)));
    this.maxRecordedFrames = Math.max(1, options.maxRecordedFrames);

    const created = createRace({
      track: request.track,
      config: request.config,
      ...(request.toggles ? { toggles: request.toggles } : {}),
    });

    if (!created.ok) {
      this.post({ type: 'error', requestId: request.requestId, error: created.error });
      return;
    }

    this.runner = created.value;
    this.mode = { kind: 'idle' };
    this.sentEvents = 0;
    this.recorded.length = 0;
    this.recorded.push(this.runner.snapshot());

    const setup = this.runner.setup;
    // Only ever used for the progress bar, so a rough figure is fine.
    this.expectedTicks = Math.max(1, Math.round(setup.expectedDurationS * SIM_HZ));

    this.post({
      type: 'ready',
      requestId: request.requestId,
      racers: setup.racers.map(identityOf),
      raceDistanceM: setup.raceDistanceM,
      lapLengthM: setup.lapLengthM,
      totalLaps: setup.totalLaps,
      vehicleClassId: setup.vehicle.id,
      simHz: SIM_HZ,
    });
    this.postFrame();
  }

  /** One real-time playback step. */
  private pump(): void {
    const runner = this.runner;
    if (runner === undefined || this.mode.kind !== 'playing') return;

    const now = this.clock.now();
    const elapsedMs = Math.max(0, now - this.lastPumpAtMs);
    this.lastPumpAtMs = now;

    // A tab that was backgrounded can hand us an enormous elapsed time. Cap it
    // so returning to the tab resumes rather than teleporting the race forward.
    const cappedMs = Math.min(elapsedMs, 500);

    const exactTicks = (cappedMs / 1000) * SIM_HZ * this.mode.speed + this.tickDebt;
    const ticks = Math.floor(exactTicks);
    // Carrying the remainder is what keeps 1x actually 1x: at a 25ms pump only
    // half a tick is due each time, and truncating would run at half speed.
    this.tickDebt = exactTicks - ticks;

    if (ticks > 0) this.advance(ticks);

    if (this.mode.kind === 'playing') {
      this.scheduleTimer(() => this.pump(), PLAY_PUMP_INTERVAL_MS);
    }
  }

  /** One chunk of fast-forward, then yield so control messages can land. */
  private skipChunk(): void {
    const runner = this.runner;
    if (runner === undefined || this.mode.kind !== 'skipping') return;

    const startedAtMs = this.clock.now();
    let chunks = 0;
    while (
      !runner.finished &&
      chunks < SKIP_MAX_CHUNKS_PER_YIELD &&
      this.clock.now() - startedAtMs < SKIP_PROGRESS_INTERVAL_MS
    ) {
      this.advance(SKIP_CHUNK_TICKS);
      chunks += 1;
      if (this.mode.kind !== 'skipping') return;
    }

    if (runner.finished) return;
    this.postFrame();
    this.scheduleTimer(() => this.skipChunk(), 0);
  }

  private advance(ticks: number): void {
    const runner = this.runner;
    if (runner === undefined) return;

    // Step one tick at a time when recording is dense enough to need it;
    // otherwise step in blocks and record on the boundaries.
    let remaining = ticks;
    while (remaining > 0 && !runner.finished) {
      const untilRecord = this.recordEveryTicks - (runner.tick % this.recordEveryTicks);
      const step = Math.min(remaining, untilRecord);
      runner.step(step);
      remaining -= step;
      if (runner.tick % this.recordEveryTicks === 0) this.record();
    }

    if (runner.finished) {
      this.finish();
      return;
    }

    const now = this.clock.now();
    if (now - this.lastFrameAtMs >= this.frameEveryMs) this.postFrame();
  }

  private record(): void {
    const runner = this.runner;
    if (runner === undefined || this.recorded.length >= this.maxRecordedFrames) return;
    this.recorded.push(runner.snapshot());
  }

  private postFrame(): void {
    const runner = this.runner;
    if (runner === undefined) return;

    this.lastFrameAtMs = this.clock.now();
    const events = runner.events.slice(this.sentEvents);
    this.sentEvents = runner.events.length;

    this.post({
      type: 'frame',
      snapshot: runner.snapshot(),
      events,
      progress: Math.min(1, runner.tick / this.expectedTicks),
      finished: runner.finished,
    });
  }

  private finish(): void {
    const runner = this.runner;
    if (runner === undefined) return;

    this.stopTimer();
    this.mode = { kind: 'finished' };
    this.record();
    // Flush the final frame first, so the UI has the finishing positions before
    // it has the result to render.
    this.postFrame();

    const result = runner.result();
    if (!result.ok) {
      this.post({ type: 'error', requestId: -1, error: result.error });
      return;
    }
    this.post({
      type: 'finished',
      result: result.value,
      recordedTicks: this.recorded.map((frame) => frame.tick),
    });
  }

  /**
   * Scrubbing. Replays a recorded frame rather than re-simulating: the race is
   * already over, and re-running from the start to reach an arbitrary tick
   * would make dragging the scrubber quadratic.
   */
  private seek(tick: number): void {
    if (this.recorded.length === 0) return;
    const frame = nearestFrame(this.recorded, tick);
    if (frame === undefined) return;
    this.post({ type: 'frame', snapshot: frame, events: [], progress: 1, finished: true });
  }

  private scheduleTimer(callback: () => void, delayMs: number): void {
    this.timer = this.clock.setTimer(callback, delayMs);
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimer(this.timer);
      this.timer = undefined;
    }
  }
}

const identityOf = (racer: RaceRunner['setup']['racers'][number]): RacerIdentity => {
  const spec = racer.spec;
  const personalityId =
    typeof spec.personality === 'string'
      ? (getArchetype(spec.personality)?.id ?? spec.personality)
      : 'custom';
  return {
    racerId: spec.id,
    name: spec.name,
    color: spec.color,
    personalityId,
    skill: spec.skill,
    gridSlot: racer.position - 1,
  };
};

/** Binary search for the recorded frame closest to `tick`. */
const nearestFrame = (frames: readonly RaceSnapshot[], tick: number): RaceSnapshot | undefined => {
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((frames[mid] as RaceSnapshot).tick < tick) low = mid + 1;
    else high = mid;
  }
  const at = frames[low];
  const before = frames[low - 1];
  if (at === undefined) return before;
  if (before === undefined) return at;
  return Math.abs(at.tick - tick) <= Math.abs(before.tick - tick) ? at : before;
};

export type { RaceEvent };
