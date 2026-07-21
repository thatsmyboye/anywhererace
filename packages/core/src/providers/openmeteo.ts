import { err, ok } from '../result';
import type { Result } from '../result';
import type { WeatherConditions, WeatherSample } from '../types/weather';
import type { ForecastRequest, WeatherError, WeatherProvider } from './weather';

/**
 * Open-Meteo. Free, no API key, hourly resolution.
 *
 * Called exactly once, when a race is created, and the result is baked into the
 * race config. Nothing on the replay path may call this — a race saved today
 * has to play back identically a year from now, and it can only do that if the
 * weather it ran in was written down rather than looked up again.
 *
 * The scheduled-start case is the reason this takes a `startsAt` at all: a user
 * may want to race a wet Tuesday evening, so the forecast is sampled around
 * that instant rather than around now.
 */

export type OpenMeteoOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Clock, injected so the horizon check is testable. */
  now?: () => number;
};

const DEFAULTS = {
  baseUrl: 'https://api.open-meteo.com',
  timeoutMs: 12_000,
} as const;

/** Open-Meteo publishes 16 days ahead; past that there is nothing to bake. */
const FORECAST_HORIZON_DAYS = 16;

const HOURLY_FIELDS = [
  'temperature_2m',
  'precipitation',
  'wind_speed_10m',
  'wind_direction_10m',
  'cloud_cover',
  'relative_humidity_2m',
] as const;

const MS_PER_DAY = 86_400_000;

export const createOpenMeteoProvider = (options: OpenMeteoOptions = {}): WeatherProvider => {
  const baseUrl = options.baseUrl ?? DEFAULTS.baseUrl;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const clock = options.now ?? (() => Date.now());

  return {
    id: 'open-meteo',

    async forecast(request: ForecastRequest): Promise<Result<WeatherSample[], WeatherError>> {
      const startMs = Date.parse(request.startsAt);
      if (Number.isNaN(startMs)) {
        return err({
          kind: 'provider-unavailable',
          message: `"${request.startsAt}" is not a valid start time.`,
        });
      }

      const nowMs = clock();
      const daysAhead = (startMs - nowMs) / MS_PER_DAY;
      if (daysAhead > FORECAST_HORIZON_DAYS) {
        return err({
          kind: 'beyond-forecast-horizon',
          message: `The forecast only reaches ${FORECAST_HORIZON_DAYS} days ahead. Pick a start time sooner than that, or set the weather manually.`,
        });
      }

      const endMs = startMs + Math.max(0, request.durationS) * 1000;
      // Cover from today through the day the race ends. Open-Meteo counts days
      // from today, so a race two days out needs three days of forecast.
      const forecastDays = Math.min(
        FORECAST_HORIZON_DAYS,
        Math.max(1, Math.ceil((endMs - nowMs) / MS_PER_DAY) + 1),
      );

      const url =
        `${baseUrl}/v1/forecast?latitude=${request.at.lat.toFixed(4)}` +
        `&longitude=${request.at.lng.toFixed(4)}` +
        `&hourly=${HOURLY_FIELDS.join(',')}` +
        // Metres per second and unix timestamps, so nothing has to be parsed or
        // converted on the way in.
        `&wind_speed_unit=ms&timeformat=unixtime&timezone=UTC` +
        `&forecast_days=${forecastDays}` +
        // A start time in the recent past is legitimate — "race the weather an
        // hour ago" — and needs the observed hours as well as the forecast.
        (startMs < nowMs ? '&past_days=2' : '');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(url, { signal: controller.signal });

        if (response.status === 429) {
          return err({
            kind: 'rate-limited',
            message: 'The weather service is rate-limiting us. Try again shortly.',
          });
        }
        if (!response.ok) {
          return err({
            kind: 'provider-unavailable',
            message: `Weather service returned ${response.status}.`,
          });
        }

        const payload = (await response.json()) as OpenMeteoResponse;
        const samples = toSamples(payload, startMs, endMs);
        if (samples.length === 0) {
          return err({
            kind: 'provider-unavailable',
            message: 'The weather service returned no usable hours for that time.',
          });
        }
        return ok(samples);
      } catch (error: unknown) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        return err({
          kind: 'provider-unavailable',
          message: aborted
            ? 'The weather service did not respond in time.'
            : `Could not reach the weather service: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
};

/**
 * Hourly rows to race-relative samples.
 *
 * The hours bracketing the race are kept as well as the ones inside it, so that
 * `conditionsAt` always has a sample either side to interpolate between and
 * never has to extrapolate — a race starting at 14:30 needs the 14:00 reading
 * as much as the 15:00 one.
 */
const toSamples = (payload: OpenMeteoResponse, startMs: number, endMs: number): WeatherSample[] => {
  const hourly = payload.hourly;
  const times = hourly?.time;
  if (hourly === undefined || times === undefined || times.length === 0) return [];

  const at = (field: (typeof HOURLY_FIELDS)[number], index: number): number => {
    const series = hourly[field];
    const value = series?.[index];
    return typeof value === 'number' ? value : 0;
  };

  const samples: WeatherSample[] = [];
  for (let i = 0; i < times.length; i++) {
    const timeMs = (times[i] as number) * 1000;
    const nextMs = i + 1 < times.length ? (times[i + 1] as number) * 1000 : Infinity;
    const previousMs = i > 0 ? (times[i - 1] as number) * 1000 : -Infinity;

    // Keep this hour if the race overlaps it, or if it is the last hour before
    // the start or the first hour after the end.
    const overlaps = timeMs <= endMs && nextMs > startMs;
    const bracketsStart = nextMs > startMs && timeMs <= startMs;
    const bracketsEnd = previousMs < endMs && timeMs >= endMs;
    if (!overlaps && !bracketsStart && !bracketsEnd) continue;

    samples.push({
      atOffsetS: (timeMs - startMs) / 1000,
      conditions: {
        temperatureC: at('temperature_2m', i),
        // Open-Meteo reports millimetres accumulated over the hour, which at
        // hourly resolution is the same number as mm/h.
        precipitationMmPerHour: at('precipitation', i),
        windSpeedMs: at('wind_speed_10m', i),
        // Already the meteorological convention: the direction it blows FROM.
        windFromDegrees: at('wind_direction_10m', i),
        cloudCoverFraction: clampFraction(at('cloud_cover', i) / 100),
        humidityFraction: clampFraction(at('relative_humidity_2m', i) / 100),
      } satisfies WeatherConditions,
    });
  }

  return samples.sort((a, b) => a.atOffsetS - b.atOffsetS);
};

const clampFraction = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

type OpenMeteoResponse = {
  hourly?: {
    time?: number[];
  } & Partial<Record<(typeof HOURLY_FIELDS)[number], number[]>>;
};
