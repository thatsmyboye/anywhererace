import { createRng } from '../../rng';
import { ok } from '../../result';
import type { Result } from '../../result';
import type { LatLng } from '../../types/track';
import type { ElevationError, ElevationProvider } from '../elevation';

/**
 * A synthetic DEM: a sum of low-frequency sinusoids over lat/lng, which gives
 * smooth rolling terrain with no discontinuities. Real SRTM data is 30m-posted
 * and noisier, but for building and testing the gradient path what matters is
 * that the surface is continuous, deterministic, and has real climbs in it.
 */

export type MockElevationOptions = {
  seed?: string;
  /** Meters above sea level the terrain oscillates around. */
  baseElevationM?: number;
  /**
   * Peak-to-trough relief. The default gives climbs in the 4-8% range over a
   * few hundred meters — steep enough that gradient visibly matters to a
   * cyclist or a runner without being unrideable.
   */
  reliefM?: number;
  /** Set to make perfectly flat terrain, for the flat-course sanity tests. */
  flat?: boolean;
};

const DEFAULTS = {
  seed: 'mock-dem',
  baseElevationM: 120,
  reliefM: 40,
} as const;

/**
 * Wavelengths in degrees for the three terrain harmonics. 0.02 degrees is
 * roughly 2km at mid latitudes — hill-sized. The two shorter terms add local
 * undulation on top.
 */
const WAVELENGTHS_DEG = [0.02, 0.008, 0.003] as const;

export const createMockElevationProvider = (
  options: MockElevationOptions = {},
): ElevationProvider => {
  const seed = options.seed ?? DEFAULTS.seed;
  const base = options.baseElevationM ?? DEFAULTS.baseElevationM;
  const relief = options.reliefM ?? DEFAULTS.reliefM;
  const flat = options.flat ?? false;

  const rng = createRng(seed);
  const harmonics = WAVELENGTHS_DEG.map((wavelength, i) => ({
    wavelength,
    latPhase: rng.range(0, 2 * Math.PI),
    lngPhase: rng.range(0, 2 * Math.PI),
    // Amplitude halves with each harmonic; the total sums to `relief`.
    amplitude: relief / Math.pow(2, i + 1),
  }));

  const sample = (p: LatLng): number => {
    if (flat) return base;
    let height = base;
    for (const h of harmonics) {
      const k = (2 * Math.PI) / h.wavelength;
      height +=
        h.amplitude *
        Math.sin(k * p.lat + h.latPhase) *
        Math.cos(k * p.lng + h.lngPhase);
    }
    return height;
  };

  return {
    id: 'mock-elevation',
    // Matches Open-Topo-Data's public limit, so the baker's chunking logic is
    // exercised against a realistic ceiling.
    maxBatchSize: 100,
    async lookup(points: readonly LatLng[]): Promise<Result<number[], ElevationError>> {
      return ok(points.map(sample));
    },
  };
};
