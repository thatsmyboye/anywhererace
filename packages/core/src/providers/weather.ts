import type { Result } from '../result';
import type { ISOTimestamp, LatLng } from '../types/track';
import type { WeatherSample } from '../types/weather';

/**
 * Forecast lookup (Open-Meteo in production).
 *
 * Called exactly once, at race creation, and the result is baked into the race
 * config. Nothing in the replay path may call this.
 */
export interface WeatherProvider {
  readonly id: string;
  forecast(request: ForecastRequest): Promise<Result<WeatherSample[], WeatherError>>;
}

export type ForecastRequest = {
  at: LatLng;
  /**
   * When the race is scheduled to start. Defaults to "now" at the call site;
   * a user may schedule a future start, in which case we bake the forecast for
   * that instant instead.
   */
  startsAt: ISOTimestamp;
  /** How far ahead to sample, so long races can interpolate a changing sky. */
  durationS: number;
};

export type WeatherErrorKind =
  | 'provider-unavailable'
  | 'rate-limited'
  | 'beyond-forecast-horizon'; // scheduled start is further out than the model runs

export type WeatherError = {
  kind: WeatherErrorKind;
  message: string;
};
