import type { ISOTimestamp } from './track';

/**
 * A single set of conditions. All SI; wind follows the meteorological
 * convention of naming the direction the wind comes *from*, because that is
 * what every weather API reports and silently flipping it is a classic bug.
 */
export type WeatherConditions = {
  temperatureC: number;
  /** mm/hour. 0 is dry. */
  precipitationMmPerHour: number;
  windSpeedMs: number;
  /** Degrees clockwise from true north, the direction the wind blows FROM. */
  windFromDegrees: number;
  /** 0-1. Feeds the visibility term along with precipitation. */
  cloudCoverFraction: number;
  /** 0-1. Affects endurance drain more than grip. */
  humidityFraction: number;
};

/** One point on a race-long weather timeline, offset from the race start. */
export type WeatherSample = {
  atOffsetS: number;
  conditions: WeatherConditions;
};

/**
 * Weather is always baked. `live` stores the timeline that was fetched at race
 * creation, never a promise to re-fetch: a race saved today must replay
 * identically a year from now.
 *
 * `startsAt` is the instant the conditions describe. Per the resolved open
 * decision, it defaults to the moment of race creation but may be a scheduled
 * future start, which is why it is stored separately from `fetchedAt`.
 */
export type WeatherSpec =
  | { kind: 'manual'; conditions: WeatherConditions }
  | {
      kind: 'live';
      fetchedAt: ISOTimestamp;
      startsAt: ISOTimestamp;
      /** Sorted ascending by `atOffsetS`; always non-empty. */
      timeline: WeatherSample[];
      /** Where the forecast was taken — the track centroid at creation time. */
      latitude: number;
      longitude: number;
    };

export const DRY_STILL_CONDITIONS: WeatherConditions = {
  temperatureC: 18,
  precipitationMmPerHour: 0,
  windSpeedMs: 0,
  windFromDegrees: 0,
  cloudCoverFraction: 0,
  humidityFraction: 0.5,
};

/**
 * Conditions at `elapsedS` into the race, linearly interpolated between the
 * bracketing samples and clamped at both ends of the timeline.
 */
export const conditionsAt = (spec: WeatherSpec, elapsedS: number): WeatherConditions => {
  if (spec.kind === 'manual') return spec.conditions;

  const timeline = spec.timeline;
  const first = timeline[0];
  if (first === undefined) return DRY_STILL_CONDITIONS;
  if (elapsedS <= first.atOffsetS) return first.conditions;

  const last = timeline[timeline.length - 1] as WeatherSample;
  if (elapsedS >= last.atOffsetS) return last.conditions;

  for (let i = 1; i < timeline.length; i++) {
    const b = timeline[i] as WeatherSample;
    if (b.atOffsetS < elapsedS) continue;
    const a = timeline[i - 1] as WeatherSample;
    const span = b.atOffsetS - a.atOffsetS;
    const t = span === 0 ? 0 : (elapsedS - a.atOffsetS) / span;
    return blendConditions(a.conditions, b.conditions, t);
  }
  return last.conditions;
};

const blendConditions = (
  a: WeatherConditions,
  b: WeatherConditions,
  t: number,
): WeatherConditions => ({
  temperatureC: a.temperatureC + (b.temperatureC - a.temperatureC) * t,
  precipitationMmPerHour:
    a.precipitationMmPerHour + (b.precipitationMmPerHour - a.precipitationMmPerHour) * t,
  windSpeedMs: a.windSpeedMs + (b.windSpeedMs - a.windSpeedMs) * t,
  // Blend the wind direction the short way around the compass so a swing from
  // 350 to 010 passes through north rather than sweeping all the way back.
  windFromDegrees: blendBearing(a.windFromDegrees, b.windFromDegrees, t),
  cloudCoverFraction: a.cloudCoverFraction + (b.cloudCoverFraction - a.cloudCoverFraction) * t,
  humidityFraction: a.humidityFraction + (b.humidityFraction - a.humidityFraction) * t,
});

const blendBearing = (fromDeg: number, toDeg: number, t: number): number => {
  const delta = ((toDeg - fromDeg + 540) % 360) - 180;
  return ((fromDeg + delta * t) % 360 + 360) % 360;
};
