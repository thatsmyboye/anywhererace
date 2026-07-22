/**
 * SI internally, always. These converters exist for the UI boundary and for
 * writing legible vehicle data — nothing inside the tick should call them.
 */

/** Standard gravity. Drives the cornering limit `sqrt(mu * g * radius)`. */
export const GRAVITY_MS2 = 9.80665;

export const kphToMs = (kph: number): number => kph / 3.6;
export const msToKph = (ms: number): number => ms * 3.6;

export const kmToM = (km: number): number => km * 1000;
export const mToKm = (m: number): number => m / 1000;

export const degToRad = (deg: number): number => (deg * Math.PI) / 180;
export const radToDeg = (rad: number): number => (rad * 180) / Math.PI;

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/** Clamp to [0, 1]. Used constantly for trait- and multiplier-shaped numbers. */
export const clamp01 = (value: number): number => clamp(value, 0, 1);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Inverse lerp, clamped, safe when a === b. */
export const inverseLerp = (a: number, b: number, value: number): number =>
  a === b ? 0 : clamp01((value - a) / (b - a));

/** Smallest signed difference between two bearings, in degrees, in [-180, 180]. */
export const bearingDeltaDeg = (fromDeg: number, toDeg: number): number => {
  const raw = ((toDeg - fromDeg + 540) % 360) - 180;
  // (-180, 180]; normalize the -180 edge so callers get a stable sign.
  return raw === -180 ? 180 : raw;
};

/** Normalize any bearing into [0, 360). */
export const normalizeBearingDeg = (deg: number): number => ((deg % 360) + 360) % 360;

// --- UI boundary formatting ------------------------------------------------

/**
 * Which system the *reader* wants. Nothing internal ever branches on this — the
 * sim, the baker and the store are SI throughout, and this reaches only the
 * formatters below and the components that call them.
 */
export type UnitSystem = 'metric' | 'imperial';

// Exact by definition, both of them, which is why these are written out rather
// than approximated: an international mile is 1609.344m and a foot is 0.3048m.
const METERS_PER_MILE = 1609.344;
const METERS_PER_FOOT = 0.3048;
const MM_PER_INCH = 25.4;

export const mToMi = (meters: number): number => meters / METERS_PER_MILE;
export const miToM = (miles: number): number => miles * METERS_PER_MILE;
export const mToFt = (meters: number): number => meters / METERS_PER_FOOT;
export const ftToM = (feet: number): number => feet * METERS_PER_FOOT;
export const msToMph = (ms: number): number => (ms * 3600) / METERS_PER_MILE;
export const celsiusToFahrenheit = (celsius: number): number => celsius * 1.8 + 32;

/**
 * Long distances: course length, race distance, a position along the route.
 * Always the large unit, because these are always large.
 */
export const formatDistanceM = (
  meters: number,
  system: UnitSystem,
  decimals = 2,
): string =>
  system === 'imperial'
    ? `${mToMi(meters).toFixed(decimals)} mi`
    : `${(meters / 1000).toFixed(decimals)} km`;

/**
 * Short distances: corner radius, road width, total climbing, a gap on the
 * grid. Always the small unit — a 40m gap is not 0.04km in either system.
 */
export const formatShortDistanceM = (
  meters: number,
  system: UnitSystem,
  decimals = 0,
): string =>
  system === 'imperial'
    ? `${mToFt(meters).toFixed(decimals)} ft`
    : `${meters.toFixed(decimals)} m`;

/**
 * A distance that could be either, so it picks. Used where the same field spans
 * both scales — a separation point may be a 60m pinch or a 4km drag, and
 * "0.06 km" and "4000 m" are each wrong in their own way.
 *
 * The threshold is the large unit itself rather than a round number of meters,
 * so the switch happens at 1 km and at 1 mi, not at 1 km in both.
 */
export const formatSpanM = (meters: number, system: UnitSystem): string => {
  if (system === 'imperial') {
    return meters >= METERS_PER_MILE
      ? `${mToMi(meters).toFixed(1)} mi`
      : `${Math.round(mToFt(meters))} ft`;
  }
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
};

/** Speeds a racer travels at. Metric gets km/h here, not m/s — see the wind. */
export const formatSpeedMs = (speedMs: number, system: UnitSystem, decimals = 1): string =>
  system === 'imperial'
    ? `${msToMph(speedMs).toFixed(decimals)} mph`
    : `${msToKph(speedMs).toFixed(decimals)} km/h`;

/**
 * Wind, which is m/s in metric rather than km/h. Forecasts and the sim both
 * speak m/s, "a 12 m/s crosswind" is how the effect is discussed, and mixing it
 * with racer speeds on the same screen has not been a problem because they
 * never appear together.
 */
export const formatWindSpeedMs = (speedMs: number, system: UnitSystem): string =>
  system === 'imperial' ? `${msToMph(speedMs).toFixed(1)} mph` : `${speedMs.toFixed(1)} m/s`;

export const formatTemperatureC = (
  celsius: number,
  system: UnitSystem,
  decimals = 0,
): string =>
  system === 'imperial'
    ? `${celsiusToFahrenheit(celsius).toFixed(decimals)}°F`
    : `${celsius.toFixed(decimals)}°C`;

/**
 * Rainfall rate. Two decimals in inches because the interesting range —
 * drizzle at 0.5mm/h to a downpour at 10mm/h — is 0.02 to 0.39 in/h, and one
 * decimal would round most of it to the same number.
 */
export const formatRainMmPerHour = (mmPerHour: number, system: UnitSystem): string =>
  system === 'imperial'
    ? `${(mmPerHour / MM_PER_INCH).toFixed(2)} in/h`
    : `${mmPerHour.toFixed(1)} mm/h`;

/** `1:23.456` / `12.345` — the timing-tower format. */
export const formatDurationS = (seconds: number, decimals = 3): string => {
  const sign = seconds < 0 ? '-' : '';
  const abs = Math.abs(seconds);
  const minutes = Math.floor(abs / 60);
  const rem = abs - minutes * 60;
  if (minutes === 0) return `${sign}${rem.toFixed(decimals)}`;
  const hours = Math.floor(minutes / 60);
  const mm = minutes - hours * 60;
  const secs = rem.toFixed(decimals).padStart(decimals > 0 ? decimals + 3 : 2, '0');
  if (hours === 0) return `${sign}${mm}:${secs}`;
  return `${sign}${hours}:${String(mm).padStart(2, '0')}:${secs}`;
};

/** `+1.234` / `+1 lap` — gaps in the timing tower. */
export const formatGapS = (seconds: number, decimals = 3): string =>
  `+${seconds.toFixed(decimals)}`;
