import { describe, expect, it } from 'vitest';
import { runRace } from '@anywhererace/sim';
import type { RaceResult } from '@anywhererace/sim';
import { RaceSession } from '../src/session';
import type { SessionClock } from '../src/session';
import type { WorkerRequest, WorkerRequestBody, WorkerResponse } from '../src/protocol';
import { makeConfig, makeField, makeSyntheticTrack } from '../../sim/test/fixtures';

/**
 * The playback engine, driven by a fake clock.
 *
 * The property that matters most is at the bottom: watching a race at 1x, at
 * 8x, and skipping straight to the end must all produce the same race. That is
 * the whole reason the sim is deterministic, and the worker is where it could
 * most easily be broken — by letting a wall-clock value leak into the sim, or
 * by dropping a partial tick between pumps.
 */

/** A controllable clock and timer queue. Nothing here touches real time. */
class FakeClock implements SessionClock {
  private currentMs = 0;
  private nextHandle = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now = (): number => this.currentMs;

  setTimer = (callback: () => void, delayMs: number): number => {
    const handle = this.nextHandle++;
    this.timers.set(handle, { at: this.currentMs + delayMs, callback });
    return handle;
  };

  clearTimer = (handle: number): void => {
    this.timers.delete(handle);
  };

  /** Advance time, firing timers in order, up to `maxSteps` callbacks. */
  advance(byMs: number, maxSteps = 100_000): void {
    const target = this.currentMs + byMs;
    for (let step = 0; step < maxSteps; step++) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      const [handle, timer] = due;
      this.timers.delete(handle);
      this.currentMs = Math.max(this.currentMs, timer.at);
      timer.callback();
    }
    this.currentMs = Math.max(this.currentMs, target);
  }

  get pendingTimers(): number {
    return this.timers.size;
  }
}

const TRACK = makeSyntheticTrack({ lengthM: 1600, mode: 'circuit', curvatureRadius: 70 });

const raceInput = () => ({
  track: TRACK,
  config: makeConfig({
    trackId: TRACK.id,
    laps: 3,
    vehicleClassId: 'hot-hatch',
    racers: makeField({ size: 6 }),
    seed: 'worker-test',
  }),
});

type Harness = {
  session: RaceSession;
  clock: FakeClock;
  messages: WorkerResponse[];
  send: (request: WorkerRequestBody) => void;
  of: <T extends WorkerResponse['type']>(type: T) => Extract<WorkerResponse, { type: T }>[];
};

const harness = (options?: Parameters<RaceSession['handle']>[0] extends never ? never : object): Harness => {
  const clock = new FakeClock();
  const messages: WorkerResponse[] = [];
  const session = new RaceSession((message) => messages.push(message), clock);

  const send = (request: WorkerRequestBody): void => {
    session.handle({ ...request, requestId: 1 } as WorkerRequest);
  };

  send({ type: 'init', ...raceInput(), ...options });

  return {
    session,
    clock,
    messages,
    send,
    of: (type) =>
      messages.filter(
        (message): message is Extract<WorkerResponse, { type: typeof type }> =>
          message.type === type,
      ),
  };
};

describe('RaceSession setup', () => {
  it('reports the field and an opening frame before anything runs', () => {
    const h = harness();

    const ready = h.of('ready')[0];
    expect(ready).toBeDefined();
    expect(ready?.racers).toHaveLength(6);
    expect(ready?.totalLaps).toBe(3);
    expect(ready?.simHz).toBe(20);

    const frame = h.of('frame')[0];
    expect(frame?.snapshot.tick).toBe(0);
    expect(frame?.snapshot.racers).toHaveLength(6);
    expect(frame?.finished).toBe(false);
  });

  it('reports a bad config as an error instead of starting', () => {
    const clock = new FakeClock();
    const messages: WorkerResponse[] = [];
    const session = new RaceSession((message) => messages.push(message), clock);

    session.handle({
      type: 'init',
      requestId: 1,
      track: TRACK,
      config: makeConfig({ vehicleClassId: 'hovercraft', racers: makeField({ size: 4 }) }),
    });

    const error = messages.find((message) => message.type === 'error');
    expect(error).toBeDefined();
    expect(messages.some((message) => message.type === 'ready')).toBe(false);
  });

  it('gives the grid order in the racer identities', () => {
    const slots = harness().of('ready')[0]?.racers.map((racer) => racer.gridSlot);
    expect(slots).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('RaceSession playback', () => {
  it('advances at roughly real time at 1x', () => {
    const h = harness();
    h.send({ type: 'play', speed: 1 });
    h.clock.advance(1000);

    const tick = h.of('frame').at(-1)?.snapshot.tick ?? 0;
    // One simulated second is 20 ticks. Allow a tick either side for the
    // boundaries of the pump interval.
    expect(tick).toBeGreaterThanOrEqual(19);
    expect(tick).toBeLessThanOrEqual(21);
  });

  it('does not lose fractional ticks between pumps', () => {
    // At a 25ms pump, 1x is due half a tick each time. Truncating instead of
    // carrying the remainder would run the race at half speed.
    const h = harness();
    h.send({ type: 'play', speed: 1 });
    h.clock.advance(10_000);

    const tick = h.of('frame').at(-1)?.snapshot.tick ?? 0;
    expect(tick).toBeGreaterThan(190);
  });

  it('advances eight times as far at 8x', () => {
    const h = harness();
    h.send({ type: 'play', speed: 8 });
    h.clock.advance(1000);

    const tick = h.of('frame').at(-1)?.snapshot.tick ?? 0;
    expect(tick).toBeGreaterThanOrEqual(150);
    expect(tick).toBeLessThanOrEqual(170);
  });

  it('stops advancing when paused and resumes where it left off', () => {
    const h = harness();
    h.send({ type: 'play', speed: 2 });
    h.clock.advance(500);
    h.send({ type: 'pause' });

    const atPause = h.of('frame').at(-1)?.snapshot.tick ?? 0;
    h.clock.advance(5000);
    expect(h.of('frame').at(-1)?.snapshot.tick).toBe(atPause);

    h.send({ type: 'play', speed: 2 });
    h.clock.advance(500);
    expect(h.of('frame').at(-1)?.snapshot.tick ?? 0).toBeGreaterThan(atPause);
  });

  it('posts a frame immediately on pause so the UI settles on the exact tick', () => {
    const h = harness();
    h.send({ type: 'play', speed: 1 });
    h.clock.advance(300);
    const before = h.of('frame').length;
    h.send({ type: 'pause' });
    expect(h.of('frame').length).toBe(before + 1);
  });

  it('does not teleport the race forward after the tab was backgrounded', () => {
    const h = harness();
    h.send({ type: 'play', speed: 1 });
    // A backgrounded tab can report an enormous elapsed time on return.
    h.clock.advance(120_000, 3);

    const tick = h.of('frame').at(-1)?.snapshot.tick ?? 0;
    // Capped at half a second of catch-up per pump, so a few pumps cannot
    // consume two minutes of race.
    expect(tick).toBeLessThan(60);
  });

  it('emits each event exactly once across frames', () => {
    const h = harness();
    h.send({ type: 'skip-to-end' });
    h.clock.advance(60_000);

    const all = h.of('frame').flatMap((frame) => frame.events);
    const starts = all.filter((event) => event.type === 'race-start');
    const ends = all.filter((event) => event.type === 'race-end');
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
  });
});

describe('RaceSession fast-forward', () => {
  it('runs to the end and reports a result', () => {
    const h = harness();
    h.send({ type: 'skip-to-end' });
    h.clock.advance(60_000);

    const finished = h.of('finished')[0];
    expect(finished).toBeDefined();
    expect(finished?.result.finishers).toHaveLength(6);
    expect(finished?.recordedTicks.length).toBeGreaterThan(1);
  });

  it('yields between chunks so a pause can still land mid-skip', () => {
    // The worker never blocks the main thread, but it can block itself, and a
    // blocked worker cannot see a control message.
    const h = harness();
    h.send({ type: 'skip-to-end' });
    // Fire exactly one scheduled callback. The clock does not advance while a
    // callback runs, so this also proves the yield is bounded by a tick budget
    // rather than only by elapsed time.
    h.clock.advance(1, 1);

    expect(h.of('finished')).toHaveLength(0);
    h.send({ type: 'pause' });

    const atPause = h.of('frame').at(-1)?.snapshot.tick ?? 0;
    h.clock.advance(60_000);
    expect(h.of('frame').at(-1)?.snapshot.tick).toBe(atPause);
    expect(h.of('finished')).toHaveLength(0);
  });

  it('stops scheduling work once the race is over', () => {
    const h = harness();
    h.send({ type: 'skip-to-end' });
    h.clock.advance(60_000);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it('ignores play and skip requests after the flag', () => {
    const h = harness();
    h.send({ type: 'skip-to-end' });
    h.clock.advance(60_000);

    const finalTick = h.of('frame').at(-1)?.snapshot.tick ?? 0;
    h.send({ type: 'play', speed: 8 });
    h.clock.advance(10_000);
    expect(h.of('frame').at(-1)?.snapshot.tick).toBe(finalTick);
  });
});

describe('RaceSession seeking', () => {
  it('returns a recorded frame near the requested tick', () => {
    const h = harness();
    h.send({ type: 'skip-to-end' });
    h.clock.advance(60_000);

    const ticks = h.of('finished')[0]?.recordedTicks ?? [];
    const target = ticks[Math.floor(ticks.length / 2)] ?? 0;

    const before = h.of('frame').length;
    h.send({ type: 'seek', tick: target });
    const seeked = h.of('frame').at(-1);

    expect(h.of('frame').length).toBe(before + 1);
    expect(seeked?.snapshot.tick).toBe(target);
    expect(seeked?.finished).toBe(true);
  });

  it('clamps a seek past the end to the last recorded frame', () => {
    const h = harness();
    h.send({ type: 'skip-to-end' });
    h.clock.advance(60_000);

    const ticks = h.of('finished')[0]?.recordedTicks ?? [];
    h.send({ type: 'seek', tick: 99_999_999 });
    expect(h.of('frame').at(-1)?.snapshot.tick).toBe(ticks.at(-1));
  });

  it('does not re-send events when scrubbing', () => {
    // Replaying the log on every scrubber drag would double-count incidents in
    // whatever the UI is accumulating.
    const h = harness();
    h.send({ type: 'skip-to-end' });
    h.clock.advance(60_000);
    h.send({ type: 'seek', tick: 100 });
    expect(h.of('frame').at(-1)?.events).toHaveLength(0);
  });
});

describe('playback speed cannot change the race', () => {
  const resultVia = (drive: (h: Harness) => void): RaceResult => {
    const h = harness();
    drive(h);
    const finished = h.of('finished')[0];
    expect(finished).toBeDefined();
    if (finished === undefined) throw new Error('race did not finish');
    return finished.result;
  };

  it('produces the same race at 1x, at 8x, and skipped to the end', () => {
    // The point of the whole architecture. If this fails, a wall-clock value
    // has leaked into the simulation.
    const skipped = resultVia((h) => {
      h.send({ type: 'skip-to-end' });
      h.clock.advance(120_000);
    });

    const at8x = resultVia((h) => {
      h.send({ type: 'play', speed: 8 });
      h.clock.advance(600_000);
    });

    const at1x = resultVia((h) => {
      h.send({ type: 'play', speed: 1 });
      h.clock.advance(2_400_000);
    });

    expect(at8x.resultHash).toBe(skipped.resultHash);
    expect(at1x.resultHash).toBe(skipped.resultHash);
    expect(at1x.totalTicks).toBe(skipped.totalTicks);
  });

  it('produces the same race as running the sim directly, with no worker at all', () => {
    const direct = runRace(raceInput());
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;

    const viaWorker = resultVia((h) => {
      h.send({ type: 'skip-to-end' });
      h.clock.advance(120_000);
    });
    expect(viaWorker.resultHash).toBe(direct.value.resultHash);
  });

  it('survives being paused and resumed repeatedly mid-race', () => {
    const reference = resultVia((h) => {
      h.send({ type: 'skip-to-end' });
      h.clock.advance(120_000);
    });

    const stuttered = resultVia((h) => {
      for (let i = 0; i < 40; i++) {
        h.send({ type: 'play', speed: 8 });
        h.clock.advance(700);
        h.send({ type: 'pause' });
        h.clock.advance(300);
      }
      h.send({ type: 'skip-to-end' });
      h.clock.advance(120_000);
    });

    expect(stuttered.resultHash).toBe(reference.resultHash);
  });
});
