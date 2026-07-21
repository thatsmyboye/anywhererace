import type { Track } from '@anywhererace/core';
import type { RaceConfig, RacerSpec } from '@anywhererace/sim';
import { ARCHETYPES } from '@anywhererace/sim';

/**
 * Default race settings for a saved track.
 *
 * PLACEHOLDER: this stands in for the race setup screen. Everything here — the
 * vehicle class, the lap count, the weather, the field — is a fixed default
 * that the user has no way to change yet.
 */

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
