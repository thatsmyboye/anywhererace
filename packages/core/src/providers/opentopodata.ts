import { err, ok } from '../result';
import type { Result } from '../result';
import type { LatLng } from '../types/track';
import type { ElevationError, ElevationProvider } from './elevation';

/**
 * Open-Topo-Data, for real terrain.
 *
 * Gradient has to come from a DEM. OSM ways carry no height, and deriving it
 * from route geometry produces dead-flat trails and imaginary cliffs — which
 * matters most for exactly the classes where elevation is the whole story.
 *
 * The public instance allows 100 locations per call and 1000 calls a day, so
 * this is called once per track at bake time and the result is stored with the
 * track. It is never called again — not on replay, not on reload.
 */

export type OpenTopoDataOptions = {
  baseUrl?: string;
  /**
   * Which DEM to sample. SRTM 30m is the widest coverage; `mapzen` blends
   * several sources and covers the oceans, which matters less here.
   */
  dataset?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULTS = {
  baseUrl: 'https://api.opentopodata.org',
  dataset: 'srtm30m',
  timeoutMs: 15_000,
  /** The public instance's documented ceiling. */
  maxBatchSize: 100,
} as const;

export const createOpenTopoDataProvider = (
  options: OpenTopoDataOptions = {},
): ElevationProvider => {
  const baseUrl = options.baseUrl ?? DEFAULTS.baseUrl;
  const dataset = options.dataset ?? DEFAULTS.dataset;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  return {
    id: 'open-topo-data',
    maxBatchSize: DEFAULTS.maxBatchSize,

    async lookup(points: readonly LatLng[]): Promise<Result<number[], ElevationError>> {
      if (points.length === 0) return ok([]);
      if (points.length > DEFAULTS.maxBatchSize) {
        return err({
          kind: 'rate-limited',
          message: `Asked for ${points.length} elevations in one call; the limit is ${DEFAULTS.maxBatchSize}. Chunk the request.`,
        });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // POST rather than GET: a few hundred coordinates in a query string
        // runs into URL length limits on some proxies.
        const response = await doFetch(`${baseUrl}/v1/${encodeURIComponent(dataset)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            locations: points.map((p) => `${p.lat},${p.lng}`).join('|'),
          }),
          signal: controller.signal,
        });

        if (response.status === 429) {
          return err({
            kind: 'rate-limited',
            message: 'The public elevation service is rate-limiting us. Try again shortly.',
          });
        }
        if (!response.ok) {
          return err({
            kind: 'provider-unavailable',
            message: `Elevation service returned ${response.status}.`,
          });
        }

        const payload = (await response.json()) as OpenTopoDataResponse;
        const results = payload.results;
        if (results === undefined || results.length !== points.length) {
          return err({
            kind: 'provider-unavailable',
            message: 'The elevation service returned an unexpected number of samples.',
          });
        }

        // A null elevation means the point is outside the dataset's coverage —
        // over water, or beyond SRTM's latitude range. Sea level is the honest
        // reading for the first and a better guess than failing for the second.
        return ok(results.map((entry) => entry.elevation ?? 0));
      } catch (error: unknown) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        return err({
          kind: 'provider-unavailable',
          message: aborted
            ? 'The elevation service did not respond in time.'
            : `Could not reach the elevation service: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
};

type OpenTopoDataResponse = {
  results?: { elevation: number | null }[];
};
