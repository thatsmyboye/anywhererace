import { ok } from '../../result';
import type { Result } from '../../result';
import type { WeatherConditions, WeatherSample } from '../../types/weather';
import { DRY_STILL_CONDITIONS } from '../../types/weather';
import type { ForecastRequest, WeatherError, WeatherProvider } from '../weather';

/**
 * A forecast that does exactly what you tell it to. Two modes:
 * constant conditions, or a linear drift from one set to another across the
 * race — enough to exercise the interpolation path and to write a test where
 * rain arrives at half distance.
 */

export type MockWeatherOptions = {
  conditions?: Partial<WeatherConditions>;
  /** If set, conditions drift linearly from `conditions` to this by race end. */
  driftTo?: Partial<WeatherConditions>;
  /** Number of samples emitted across the requested duration. */
  sampleCount?: number;
};

const DEFAULT_SAMPLE_COUNT = 5;

export const createMockWeatherProvider = (
  options: MockWeatherOptions = {},
): WeatherProvider => {
  const start: WeatherConditions = { ...DRY_STILL_CONDITIONS, ...options.conditions };
  const end: WeatherConditions | undefined = options.driftTo
    ? { ...start, ...options.driftTo }
    : undefined;
  const sampleCount = Math.max(1, options.sampleCount ?? DEFAULT_SAMPLE_COUNT);

  return {
    id: 'mock-weather',
    async forecast(request: ForecastRequest): Promise<Result<WeatherSample[], WeatherError>> {
      if (end === undefined) {
        return ok([{ atOffsetS: 0, conditions: start }]);
      }
      const samples: WeatherSample[] = [];
      for (let i = 0; i < sampleCount; i++) {
        const t = sampleCount === 1 ? 0 : i / (sampleCount - 1);
        samples.push({
          atOffsetS: request.durationS * t,
          conditions: blend(start, end, t),
        });
      }
      return ok(samples);
    },
  };
};

const blend = (a: WeatherConditions, b: WeatherConditions, t: number): WeatherConditions => ({
  temperatureC: a.temperatureC + (b.temperatureC - a.temperatureC) * t,
  precipitationMmPerHour:
    a.precipitationMmPerHour + (b.precipitationMmPerHour - a.precipitationMmPerHour) * t,
  windSpeedMs: a.windSpeedMs + (b.windSpeedMs - a.windSpeedMs) * t,
  windFromDegrees: a.windFromDegrees + (b.windFromDegrees - a.windFromDegrees) * t,
  cloudCoverFraction: a.cloudCoverFraction + (b.cloudCoverFraction - a.cloudCoverFraction) * t,
  humidityFraction: a.humidityFraction + (b.humidityFraction - a.humidityFraction) * t,
});
