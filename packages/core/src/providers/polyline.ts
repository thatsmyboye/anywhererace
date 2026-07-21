import type { LatLng } from '../types/track';

/**
 * Google's encoded-polyline format.
 *
 * Valhalla returns route geometry this way, at precision 6 rather than the
 * more common precision 5 — getting that wrong does not fail loudly, it simply
 * puts the track a few hundred kilometres away, so the precision is always an
 * explicit argument here rather than a default.
 */

/** Valhalla encodes at 1e-6 degrees. Most other services use 1e-5. */
export const VALHALLA_POLYLINE_PRECISION = 6;

export const decodePolyline = (encoded: string, precision: number): LatLng[] => {
  const factor = Math.pow(10, precision);
  const points: LatLng[] = [];

  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    lat += decodeSigned();
    lng += decodeSigned();
    points.push({ lat: lat / factor, lng: lng / factor });
  }

  return points;

  /**
   * One varint: five bits per byte, little-endian, with the low bit of the
   * assembled value carrying the sign.
   */
  function decodeSigned(): number {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  }
};

/** Round-trip counterpart, used only by tests and fixtures. */
export const encodePolyline = (points: readonly LatLng[], precision: number): string => {
  const factor = Math.pow(10, precision);
  let previousLat = 0;
  let previousLng = 0;
  let output = '';

  for (const point of points) {
    const lat = Math.round(point.lat * factor);
    const lng = Math.round(point.lng * factor);
    output += encodeSigned(lat - previousLat) + encodeSigned(lng - previousLng);
    previousLat = lat;
    previousLng = lng;
  }
  return output;
};

const encodeSigned = (value: number): string => {
  let shifted = value < 0 ? ~(value << 1) : value << 1;
  let output = '';
  while (shifted >= 0x20) {
    output += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
    shifted >>= 5;
  }
  output += String.fromCharCode(shifted + 63);
  return output;
};
