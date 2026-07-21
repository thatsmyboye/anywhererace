import type { Result } from '../result';
import type { LatLng } from '../types/track';

/**
 * DEM lookup (Open-Topo-Data / SRTM in production).
 *
 * Gradient must come from a real DEM, never from route geometry — OSM ways
 * carry no height, and inferring it from the polyline produces flat trails and
 * imaginary cliffs. Results are cached per track and never re-fetched, so this
 * is called once per bake.
 */
export interface ElevationProvider {
  readonly id: string;
  /** Meters above sea level, one per input point, same order. */
  lookup(points: readonly LatLng[]): Promise<Result<number[], ElevationError>>;
  /** Max points per call; the baker chunks to this. */
  readonly maxBatchSize: number;
}

export type ElevationErrorKind = 'provider-unavailable' | 'out-of-coverage' | 'rate-limited';

export type ElevationError = {
  kind: ElevationErrorKind;
  message: string;
};
