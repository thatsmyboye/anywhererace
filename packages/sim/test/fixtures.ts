import type { LatLng, SurfaceType, Track, TrackMode, TrackNode } from '@anywhererace/core';
import { DRY_STILL_CONDITIONS, destinationPoint } from '@anywhererace/core';
import type { WeatherConditions, WeatherSpec } from '@anywhererace/core';
import { ARCHETYPES } from '../src/traits';
import type { RaceConfig, RacerSpec } from '../src/types';

/**
 * Synthetic tracks, built node-by-node rather than through the baker.
 *
 * Sanity tests need a track with *exactly* known properties — dead flat, dead
 * straight, one surface — so that when a road cyclist finishes a 40km course in
 * the wrong time there is only one place the fault can be. Going through the
 * router and baker would leave curvature and gradient as confounds.
 */

const NODE_SPACING_M = 5;
const ORIGIN: LatLng = { lat: 51.5, lng: -0.12 };

export type SyntheticTrackOptions = {
  lengthM: number;
  mode?: TrackMode;
  /** Constant corner radius in meters, or `Infinity` for a straight. */
  curvatureRadius?: number;
  /** Constant gradient, or a function of distance for rolling terrain. */
  gradient?: number | ((distanceM: number) => number);
  surface?: SurfaceType;
  widthMeters?: number;
  junctionPenalty?: number;
  /** Compass heading of the (straight) route. Only matters for wind tests. */
  bearing?: number;
};

export const makeSyntheticTrack = (options: SyntheticTrackOptions): Track => {
  const {
    lengthM,
    mode = 'point-to-point',
    curvatureRadius = Infinity,
    gradient = 0,
    surface = 'asphalt',
    widthMeters = 8,
    junctionPenalty = 1,
    bearing = 90,
  } = options;

  const segments = Math.max(4, Math.round(lengthM / NODE_SPACING_M));
  const spacing = lengthM / segments;
  const nodeCount = mode === 'circuit' ? segments : segments + 1;

  const gradientAt = typeof gradient === 'function' ? gradient : () => gradient;

  const nodes: TrackNode[] = [];
  let elevation = 100;
  for (let i = 0; i < nodeCount; i++) {
    const distance = i * spacing;
    const grade = gradientAt(distance);
    const point = destinationPoint(ORIGIN, bearing, distance);
    nodes.push({
      distance,
      lat: point.lat,
      lng: point.lng,
      bearing,
      curvatureRadius,
      gradient: grade,
      surface,
      surfaceConfidence: 'tagged',
      widthMeters,
      junctionPenalty,
      elevation,
    });
    elevation += grade * spacing;
  }

  return {
    id: 'synthetic',
    name: `Synthetic ${(lengthM / 1000).toFixed(1)}km`,
    mode,
    routingProfile: 'motor',
    waypoints: [ORIGIN, destinationPoint(ORIGIN, bearing, lengthM)],
    polyline: nodes.map((n) => ({ lat: n.lat, lng: n.lng })),
    nodes,
    lengthMeters: lengthM,
    startLine: 0,
    finishLine: lengthM,
    sectors: [lengthM / 3, (lengthM * 2) / 3],
  };
};

/**
 * Hand the event loop back for one turn.
 *
 * The sim is synchronous and CPU-bound, so a test that runs a dozen races in a
 * loop holds the vitest worker's event loop for the whole run. The worker's RPC
 * heartbeat to the main process cannot get through while it does, and past a
 * few seconds vitest fails the run with `Timeout calling "onTaskUpdate"` — every
 * test passing, one unhandled error, load-dependent enough to look flaky. Await
 * this between races and the heartbeat gets its turn.
 */
export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

export const manualWeather = (overrides: Partial<WeatherConditions> = {}): WeatherSpec => ({
  kind: 'manual',
  conditions: { ...DRY_STILL_CONDITIONS, ...overrides },
});

export type FieldOptions = {
  size: number;
  /** Same personality for everyone, for isolating a single variable. */
  personality?: string;
  /** Same skill for everyone; otherwise skills are spread evenly across 0-1. */
  skill?: number;
};

export const makeField = (options: FieldOptions): RacerSpec[] => {
  const { size, personality, skill } = options;
  const racers: RacerSpec[] = [];
  for (let i = 0; i < size; i++) {
    const archetype = ARCHETYPES[i % ARCHETYPES.length];
    racers.push({
      id: `r${String(i + 1).padStart(2, '0')}`,
      name: `Racer ${i + 1}`,
      color: '#888888',
      personality: personality ?? (archetype?.id ?? 'metronome'),
      // Evenly spread rather than random, so a failing sanity test points at
      // the physics and not at an unlucky draw.
      skill: skill ?? (size === 1 ? 0.8 : 0.55 + (0.4 * i) / (size - 1)),
    });
  }
  return racers;
};

export const makeConfig = (overrides: Partial<RaceConfig> = {}): RaceConfig => {
  const racers = overrides.racers ?? makeField({ size: 8 });
  return {
    trackId: 'synthetic',
    laps: 1,
    vehicleClassId: 'road-cyclist',
    weather: manualWeather(),
    fieldSize: racers.length,
    racers,
    seed: 'test-seed',
    gridOrder: 'by-skill',
    ...overrides,
    // Kept last so a caller overriding `racers` never has to remember to
    // update `fieldSize` in lockstep.
    ...(overrides.racers ? { fieldSize: overrides.racers.length } : {}),
  };
};
