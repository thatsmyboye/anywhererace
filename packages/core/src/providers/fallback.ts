import type { Result } from '../result';
import type { LatLng } from '../types/track';
import type { ElevationError, ElevationProvider } from './elevation';
import type { RouteLeg, RouteLegRequest, RoutingError, RoutingProvider } from './routing';

/**
 * Degrade to a backup provider when the primary one is unreachable.
 *
 * The distinction that matters: "no route exists between these two points" is a
 * *legitimate answer* and must be shown to the user — falling back to a mock
 * router there would invent a road that does not exist, which is far worse than
 * an error message. Only an outage, a timeout, or a rate limit falls through.
 *
 * The fallback also latches. Once the primary has failed, a builder session
 * that re-routes on every waypoint drag should not spend twelve seconds timing
 * out each time; it retries only after a cool-off.
 */

export type FallbackOptions = {
  /** How long to stay on the fallback after an outage. */
  retryAfterMs?: number;
  /** Called whenever the active provider changes, for a UI banner. */
  onDegraded?: (degraded: boolean, reason: string) => void;
  /**
   * Clock, in milliseconds. Injected so the cool-off is testable without
   * waiting a real minute, and so the one piece of wall-clock dependence in
   * this package is explicit rather than buried.
   */
  now?: () => number;
};

const DEFAULT_RETRY_AFTER_MS = 60_000;

/**
 * Wall clock for the cool-off timer.
 *
 * This is the one place in `packages/core` that reads a clock. It is safe:
 * provider adapters are I/O, they run at track-build time, and nothing in the
 * simulation's tick path ever calls them. The lint rule that bans `Date.now`
 * in this package is scoped around this directory for exactly that reason.
 */
const defaultClock = (): number => Date.now();

/** Errors that mean the service is down, not that the answer is "no". */
const isOutage = (error: { kind: string }): boolean =>
  error.kind === 'provider-unavailable' || error.kind === 'rate-limited';

export const withRoutingFallback = (
  primary: RoutingProvider,
  fallback: RoutingProvider,
  options: FallbackOptions = {},
): RoutingProvider => {
  const retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  const clock = options.now ?? defaultClock;
  let degradedUntilMs = 0;

  const degrade = (reason: string, nowMs: number): void => {
    const wasHealthy = nowMs >= degradedUntilMs;
    degradedUntilMs = nowMs + retryAfterMs;
    if (wasHealthy) options.onDegraded?.(true, reason);
  };

  return {
    id: `${primary.id}+fallback`,

    async routeLeg(request: RouteLegRequest): Promise<Result<RouteLeg, RoutingError>> {
      const now = clock();
      if (now < degradedUntilMs) return fallback.routeLeg(request);

      let result: Result<RouteLeg, RoutingError>;
      try {
        result = await primary.routeLeg(request);
      } catch (error: unknown) {
        // A provider that throws rather than returning an error result is
        // misbehaving, but that is no reason to break the builder.
        degrade(error instanceof Error ? error.message : String(error), now);
        return fallback.routeLeg(request);
      }

      if (result.ok) {
        if (degradedUntilMs !== 0) options.onDegraded?.(false, 'Routing service is back.');
        degradedUntilMs = 0;
        return result;
      }

      // "No route" is the router doing its job. Pass it straight through.
      if (!isOutage(result.error)) return result;

      degrade(result.error.message, now);
      return fallback.routeLeg(request);
    },
  };
};

export const withElevationFallback = (
  primary: ElevationProvider,
  fallback: ElevationProvider,
  options: FallbackOptions = {},
): ElevationProvider => {
  const retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  const clock = options.now ?? defaultClock;
  let degradedUntilMs = 0;

  return {
    // Chunking is the caller's job, so advertise whichever limit is stricter.
    id: `${primary.id}+fallback`,
    maxBatchSize: Math.min(primary.maxBatchSize, fallback.maxBatchSize),

    async lookup(points: readonly LatLng[]): Promise<Result<number[], ElevationError>> {
      const now = clock();
      if (now < degradedUntilMs) return fallback.lookup(points);

      let result: Result<number[], ElevationError>;
      try {
        result = await primary.lookup(points);
      } catch (error: unknown) {
        degradedUntilMs = now + retryAfterMs;
        options.onDegraded?.(true, error instanceof Error ? error.message : String(error));
        return fallback.lookup(points);
      }

      if (result.ok) {
        degradedUntilMs = 0;
        return result;
      }

      // `out-of-coverage` is a real answer about a real place; synthetic
      // terrain would be a worse one.
      if (!isOutage(result.error)) return result;

      degradedUntilMs = now + retryAfterMs;
      options.onDegraded?.(true, result.error.message);
      return fallback.lookup(points);
    },
  };
};
