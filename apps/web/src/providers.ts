import {
  createMapTilerProvider,
  createMockElevationProvider,
  createMockRoutingProvider,
  createOpenTopoDataProvider,
  createValhallaProvider,
  withElevationFallback,
  withRoutingFallback,
} from '@anywhererace/core';
import type { ElevationProvider, RoutingProvider, TileProvider } from '@anywhererace/core';

/**
 * Wiring the real services, with the mocks behind them.
 *
 * The fallback is not a nicety. Both public services are free, shared, and
 * rate-limited; the app has to stay usable when one of them says no. What the
 * fallback deliberately does *not* do is paper over a genuine "no route here" —
 * inventing a road that does not exist is far worse than saying so.
 */

export type DegradedState = {
  /** Which services are currently falling back. */
  routing: boolean;
  elevation: boolean;
};

export type AppProviders = {
  routing: RoutingProvider;
  elevation: ElevationProvider;
  tiles: TileProvider;
  /** Snapshot of what has fallen back so far. */
  degraded: () => DegradedState;
};

export type CreateProvidersOptions = {
  maptilerKey: string | undefined;
  /**
   * Fired whenever a service starts or stops falling back.
   *
   * A callback rather than a getter because the UI has to *re-render* when this
   * changes — a value read during render will never update on its own, and the
   * user would keep being told everything was fine while the app quietly served
   * them synthetic terrain.
   */
  onDegradedChange?: (state: DegradedState) => void;
};

export const createProviders = (options: CreateProvidersOptions): AppProviders => {
  const state: DegradedState = { routing: false, elevation: false };

  const track = (service: keyof DegradedState) => (degraded: boolean): void => {
    if (state[service] === degraded) return;
    state[service] = degraded;
    options.onDegradedChange?.({ ...state });
  };
  const onRoutingDegraded = track('routing');
  const onElevationDegraded = track('elevation');

  const routing = withRoutingFallback(
    createValhallaProvider(),
    // Seeded per session so a synthetic route at least stays put while editing.
    createMockRoutingProvider({ seed: 'fallback-router' }),
    { onDegraded: onRoutingDegraded },
  );

  const elevation = withElevationFallback(
    createOpenTopoDataProvider(),
    createMockElevationProvider({ seed: 'fallback-dem' }),
    { onDegraded: onElevationDegraded },
  );

  return {
    routing,
    elevation,
    tiles: createMapTilerProvider({ apiKey: options.maptilerKey }),
    degraded: () => ({ ...state }),
  };
};

/** What to tell the user, given what has fallen back. */
export const describeDegraded = (
  state: DegradedState,
  hasBasemap: boolean,
): string | undefined => {
  const notices: string[] = [];
  if (state.routing) {
    notices.push(
      'The routing service is unavailable, so legs are being drawn from synthetic geometry rather than real streets.',
    );
  }
  if (state.elevation) {
    notices.push(
      'The elevation service is unavailable, so gradients are synthetic. The track will still race, but its hills are invented.',
    );
  }
  if (!hasBasemap) {
    notices.push(
      'No basemap key set, so the map has no streets on it. Add VITE_MAPTILER_KEY to apps/web/.env.local to see where you are drawing.',
    );
  }
  return notices.length === 0 ? undefined : notices.join(' ');
};
