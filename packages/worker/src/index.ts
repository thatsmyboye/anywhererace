// Hosts the deterministic simulation in a Web Worker so the main thread never
// blocks. Depends on sim and core; the React layer depends on this.
//
// The worker entry itself is at `@anywhererace/worker/worker` — it is not
// re-exported here, because importing it would pull `self` into the main
// thread's bundle.

export * from './protocol';
export * from './client';
export { RaceSession } from './session';
export type { SessionClock } from './session';
