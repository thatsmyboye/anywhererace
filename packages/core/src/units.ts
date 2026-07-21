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
