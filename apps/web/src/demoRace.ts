import type { LatLng, Track } from '@anywhererace/core';
import {
  createMockElevationProvider,
  createMockRoutingProvider,
  destinationPoint,
} from '@anywhererace/core';
import type { RaceConfig, RacerSpec } from '@anywhererace/sim';
import { ARCHETYPES } from '@anywhererace/sim';
import { buildTrack } from '@anywhererace/track';

/**
 * A demo race, built from the mock providers.
 *
 * There is no track builder yet, so this stands in for one. It is deliberately
 * built through the *real* pipeline — router, elevation lookup, baker — rather
 * than hand-assembled, so that the race view is exercising the same code path a
 * user-drawn track will.
 *
 * Everything here is a placeholder pending the track builder and race setup
 * screens.
 */

/** Central London, purely so the demo lands somewhere recognisable. */
const ORIGIN: LatLng = { lat: 51.5072, lng: -0.1276 };
const BLOCK_SIZE_M = 900;

export const buildDemoTrack = async (): Promise<Track> => {
  const east = destinationPoint(ORIGIN, 90, BLOCK_SIZE_M);
  const waypoints: LatLng[] = [
    ORIGIN,
    east,
    destinationPoint(east, 0, BLOCK_SIZE_M),
    destinationPoint(ORIGIN, 0, BLOCK_SIZE_M),
  ];

  const built = await buildTrack({
    id: 'demo-circuit',
    name: 'Demo circuit',
    mode: 'circuit',
    routingProfile: 'motor',
    waypoints,
    routing: createMockRoutingProvider({ seed: 'demo-track' }),
    elevation: createMockElevationProvider({ seed: 'demo-track', reliefM: 45 }),
  });

  if (!built.ok) {
    // The app boundary is the one place an exception is appropriate.
    throw new Error(`Could not build the demo track: ${built.error.message}`);
  }
  return built.value;
};

export const buildDemoConfig = (track: Track): RaceConfig => {
  const racers = demoField(12);
  return {
    trackId: track.id,
    laps: 5,
    vehicleClassId: 'gt-racer',
    weather: {
      kind: 'manual',
      conditions: {
        temperatureC: 16,
        precipitationMmPerHour: 0,
        windSpeedMs: 4,
        windFromDegrees: 240,
        cloudCoverFraction: 0.4,
        humidityFraction: 0.6,
      },
    },
    fieldSize: racers.length,
    racers,
    seed: 'demo-001',
    gridOrder: 'reverse-skill',
  };
};

/**
 * One racer per archetype, so every personality is visible in a single race,
 * with skill spread evenly. Reverse-skill grid order, so the field has to
 * actually sort itself out and there is something to watch.
 */
const demoField = (size: number): RacerSpec[] =>
  Array.from({ length: size }, (_, i) => {
    const archetype = ARCHETYPES[i % ARCHETYPES.length];
    // A field larger than the archetype list wraps around, so the second time
    // through gets a suffix — two racers called "Charger" in the same timing
    // tower is unreadable.
    const repeat = Math.floor(i / ARCHETYPES.length);
    const base = archetype?.label.replace('The ', '') ?? `Racer ${i + 1}`;
    return {
      id: `r${String(i + 1).padStart(2, '0')}`,
      // PLACEHOLDER: archetype labels standing in for racer names until the
      // roster editor exists.
      name: repeat === 0 ? base : `${base} ${repeat + 1}`,
      // Colour is assigned from the OkLCH palette at render time; this value is
      // ignored by the UI and exists only to satisfy the config shape.
      color: '#888888',
      personality: archetype?.id ?? 'metronome',
      skill: size === 1 ? 0.8 : 0.55 + (0.4 * i) / (size - 1),
    };
  });
