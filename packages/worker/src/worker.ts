/// <reference lib="webworker" />

import type { WorkerRequest, WorkerResponse } from './protocol';
import { RaceSession } from './session';

/**
 * The worker entry point.
 *
 * Deliberately thin: everything that could be wrong lives in `RaceSession`,
 * which is tested in Node against a fake clock. This file only binds that to
 * the real `self`, and its failure modes are limited to "the message never
 * arrived".
 *
 * This is the only file in the repo that touches `self` or `postMessage`.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;

const session = new RaceSession(
  (message: WorkerResponse) => {
    scope.postMessage(message);
  },
  {
    // `performance.now()` is monotonic and unaffected by the system clock
    // changing under us mid-race. It decides only how many ticks to run; no
    // time value ever reaches the simulation.
    now: () => performance.now(),
    setTimer: (callback, delayMs) => scope.setTimeout(callback, delayMs) as unknown as number,
    clearTimer: (handle) => {
      scope.clearTimeout(handle);
    },
  },
);

scope.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  try {
    session.handle(event.data);
  } catch (error: unknown) {
    // A throw in here would otherwise surface as a silent dead worker.
    scope.postMessage({
      type: 'error',
      requestId: event.data?.requestId ?? -1,
      error: {
        kind: 'worker-failure',
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies WorkerResponse);
  }
};
