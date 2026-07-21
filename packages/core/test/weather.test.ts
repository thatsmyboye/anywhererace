import { describe, expect, it } from 'vitest';
import { DRY_STILL_CONDITIONS, conditionsAt } from '../src/types/weather';
import type { WeatherSpec } from '../src/types/weather';
import { createMockWeatherProvider } from '../src/providers/mock/weather';

const live = (timeline: { atOffsetS: number; precipitationMmPerHour: number }[]): WeatherSpec => ({
  kind: 'live',
  fetchedAt: '2026-07-20T09:00:00Z',
  startsAt: '2026-07-20T09:00:00Z',
  latitude: 51.5,
  longitude: -0.12,
  timeline: timeline.map((sample) => ({
    atOffsetS: sample.atOffsetS,
    conditions: {
      ...DRY_STILL_CONDITIONS,
      precipitationMmPerHour: sample.precipitationMmPerHour,
    },
  })),
});

describe('conditionsAt', () => {
  it('returns the fixed conditions for a manual spec', () => {
    const spec: WeatherSpec = {
      kind: 'manual',
      conditions: { ...DRY_STILL_CONDITIONS, temperatureC: 30 },
    };
    expect(conditionsAt(spec, 0).temperatureC).toBe(30);
    expect(conditionsAt(spec, 99_999).temperatureC).toBe(30);
  });

  it('interpolates between samples', () => {
    const spec = live([
      { atOffsetS: 0, precipitationMmPerHour: 0 },
      { atOffsetS: 100, precipitationMmPerHour: 10 },
    ]);
    expect(conditionsAt(spec, 50).precipitationMmPerHour).toBeCloseTo(5, 6);
    expect(conditionsAt(spec, 25).precipitationMmPerHour).toBeCloseTo(2.5, 6);
  });

  it('clamps at both ends rather than extrapolating', () => {
    const spec = live([
      { atOffsetS: 60, precipitationMmPerHour: 2 },
      { atOffsetS: 120, precipitationMmPerHour: 8 },
    ]);
    expect(conditionsAt(spec, 0).precipitationMmPerHour).toBe(2);
    expect(conditionsAt(spec, 10_000).precipitationMmPerHour).toBe(8);
  });

  it('blends wind direction the short way around the compass', () => {
    const spec: WeatherSpec = {
      kind: 'live',
      fetchedAt: '2026-07-20T09:00:00Z',
      startsAt: '2026-07-20T09:00:00Z',
      latitude: 0,
      longitude: 0,
      timeline: [
        { atOffsetS: 0, conditions: { ...DRY_STILL_CONDITIONS, windFromDegrees: 350 } },
        { atOffsetS: 100, conditions: { ...DRY_STILL_CONDITIONS, windFromDegrees: 10 } },
      ],
    };
    // Through north, not the long way back through south.
    expect(conditionsAt(spec, 50).windFromDegrees).toBeCloseTo(0, 6);
  });
});

describe('mock weather provider', () => {
  it('returns a single sample for constant conditions', async () => {
    const provider = createMockWeatherProvider({ conditions: { temperatureC: 25 } });
    const result = await provider.forecast({
      at: { lat: 51.5, lng: -0.12 },
      startsAt: '2026-07-20T09:00:00Z',
      durationS: 3600,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.conditions.temperatureC).toBe(25);
  });

  it('drifts across the requested duration when asked to', async () => {
    const provider = createMockWeatherProvider({
      conditions: { precipitationMmPerHour: 0 },
      driftTo: { precipitationMmPerHour: 8 },
      sampleCount: 5,
    });
    const result = await provider.forecast({
      at: { lat: 51.5, lng: -0.12 },
      startsAt: '2026-07-20T09:00:00Z',
      durationS: 4000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(5);
    expect(result.value[0]?.conditions.precipitationMmPerHour).toBe(0);
    expect(result.value[4]?.conditions.precipitationMmPerHour).toBe(8);
    expect(result.value[4]?.atOffsetS).toBe(4000);
  });
});
