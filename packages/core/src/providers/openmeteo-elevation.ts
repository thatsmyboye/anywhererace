import { err, ok } from '../result';
import type { Result } from '../result';
import type { LatLng } from '../types/track';
import type { ElevationError, ElevationProvider } from './elevation';

/**
 * Open-Meteo's DEM, for real terrain in a browser.
 *
 * This exists because `opentopodata.ts` cannot be called from one. The public
 * Open-Topo-Data instance sends no `Access-Control-Allow-Origin` header, so
 * every request from a page is blocked before it leaves — not rate-limited, not
 * slow, blocked — and the fetch rejects with a bare "Failed to fetch". The
 * elevation fallback correctly read that as an outage and served synthetic
 * hills, which meant every track ever saved from the deployed app had invented
 * terrain and a banner admitting it. The same request from curl succeeds, which
 * is exactly why it survived so long.
 *
 * Open-Meteo sends CORS headers, needs no key, and is already a dependency for
 * the forecast. It samples Copernicus DEM GLO-90 rather than SRTM 30m, so it is
 * coarser horizontally; for gradient over a 5m-node track that difference is far
 * smaller than the difference between real terrain and no terrain at all.
 *
 * Like every elevation lookup, this is called once per track at bake time and
 * the result is stored with the track. It is never called again — not on
 * replay, not on reload.
 */

export type OpenMeteoElevationOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULTS = {
  baseUrl: 'https://api.open-meteo.com',
  timeoutMs: 15_000,
  /**
   * Open-Meteo's documented ceiling for this endpoint. Also comfortably inside
   * any sane URL length limit: 100 coordinate pairs is under 2kB of query
   * string, which is why this can stay a GET.
   */
  maxBatchSize: 100,
} as const;

export const createOpenMeteoElevationProvider = (
  options: OpenMeteoElevationOptions = {},
): ElevationProvider => {
  const baseUrl = options.baseUrl ?? DEFAULTS.baseUrl;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  return {
    id: 'open-meteo-elevation',
    maxBatchSize: DEFAULTS.maxBatchSize,

    async lookup(points: readonly LatLng[]): Promise<Result<number[], ElevationError>> {
      if (points.length === 0) return ok([]);
      if (points.length > DEFAULTS.maxBatchSize) {
        return err({
          kind: 'rate-limited',
          message: `Asked for ${points.length} elevations in one call; the limit is ${DEFAULTS.maxBatchSize}. Chunk the request.`,
        });
      }

      const latitudes = points.map((p) => p.lat).join(',');
      const longitudes = points.map((p) => p.lng).join(',');
      const url = `${baseUrl}/v1/elevation?latitude=${latitudes}&longitude=${longitudes}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(url, { signal: controller.signal });

        if (response.status === 429) {
          return err({
            kind: 'rate-limited',
            message: 'The elevation service is rate-limiting us. Try again shortly.',
          });
        }
        if (!response.ok) {
          return err({
            kind: 'provider-unavailable',
            message: `Elevation service returned ${response.status}.`,
          });
        }

        const payload = (await response.json()) as OpenMeteoElevationResponse;
        const elevations = payload.elevation;
        if (elevations === undefined || elevations.length !== points.length) {
          return err({
            kind: 'provider-unavailable',
            message: 'The elevation service returned an unexpected number of samples.',
          });
        }

        // A null reading means the point is outside the dataset — over open
        // water, or past its latitude range. Sea level is the honest answer for
        // the first and a better guess than failing for the second.
        return ok(elevations.map((value) => value ?? 0));
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

type OpenMeteoElevationResponse = {
  elevation?: (number | null)[];
};
