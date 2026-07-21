import type { LatLng } from './types/track';
import { degToRad, normalizeBearingDeg, radToDeg } from './units';

/**
 * Geodesy, kept deliberately small.
 *
 * Note on determinism: these use `Math.sin`/`Math.cos`/`Math.atan2`, which
 * ECMAScript defines as implementation-approximated. That is acceptable *here*
 * and nowhere else, because geo math runs only during track baking, and a baked
 * track is stored (or re-baked from a pinned polyline) rather than recomputed
 * mid-race. The result hash quantizes its inputs precisely so that a last-ulp
 * difference in a corner radius cannot flip a published race hash. Do not call
 * anything in this file from inside the tick.
 */

/** IUGG mean Earth radius. */
export const EARTH_RADIUS_M = 6371008.8;

/**
 * Great-circle distance. Haversine rather than the law of cosines because the
 * segments we measure are short (5-50m after resampling) and the law of cosines
 * loses precision badly at that scale.
 */
export const haversineMeters = (a: LatLng, b: LatLng): number => {
  const lat1 = degToRad(a.lat);
  const lat2 = degToRad(b.lat);
  const dLat = lat2 - lat1;
  const dLng = degToRad(b.lng - a.lng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, h)));
};

/** Initial bearing from `a` to `b`, degrees clockwise from true north, [0, 360). */
export const bearingDegrees = (a: LatLng, b: LatLng): number => {
  const lat1 = degToRad(a.lat);
  const lat2 = degToRad(b.lat);
  const dLng = degToRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return normalizeBearingDeg(radToDeg(Math.atan2(y, x)));
};

/** Point `distanceM` along `bearingDeg` from `origin`. */
export const destinationPoint = (
  origin: LatLng,
  bearingDeg: number,
  distanceM: number,
): LatLng => {
  const angular = distanceM / EARTH_RADIUS_M;
  const bearing = degToRad(bearingDeg);
  const lat1 = degToRad(origin.lat);
  const lng1 = degToRad(origin.lng);
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAngular = Math.sin(angular);
  const cosAngular = Math.cos(angular);

  const lat2 = Math.asin(sinLat1 * cosAngular + cosLat1 * sinAngular * Math.cos(bearing));
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * sinAngular * cosLat1,
      cosAngular - sinLat1 * Math.sin(lat2),
    );

  return { lat: radToDeg(lat2), lng: radToDeg(((lng2 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) };
};

/**
 * Linear interpolation in lat/lng space. Legitimate only over short spans —
 * we use it between consecutive polyline vertices during resampling, where the
 * error against a true great-circle interpolation is far below a millimeter.
 */
export const interpolateLatLng = (a: LatLng, b: LatLng, t: number): LatLng => ({
  lat: a.lat + (b.lat - a.lat) * t,
  lng: a.lng + (b.lng - a.lng) * t,
});

/**
 * Local planar projection in meters, centered on `origin`. Curvature fitting
 * wants a flat plane; over the ±15m window we fit circles in, this is exact
 * enough that the error is invisible next to the underlying OSM geometry noise.
 */
export const toLocalMeters = (origin: LatLng, point: LatLng): { x: number; y: number } => {
  const latRad = degToRad(origin.lat);
  const metersPerDegLat = (Math.PI * EARTH_RADIUS_M) / 180;
  const metersPerDegLng = metersPerDegLat * Math.cos(latRad);
  return {
    x: (point.lng - origin.lng) * metersPerDegLng,
    y: (point.lat - origin.lat) * metersPerDegLat,
  };
};

export const polylineLengthMeters = (points: readonly LatLng[]): number => {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineMeters(points[i - 1] as LatLng, points[i] as LatLng);
  }
  return total;
};

/** Cumulative distance at each vertex; `[0]` is always 0. */
export const cumulativeDistances = (points: readonly LatLng[]): number[] => {
  const out: number[] = new Array(points.length);
  out[0] = 0;
  for (let i = 1; i < points.length; i++) {
    out[i] = (out[i - 1] as number) + haversineMeters(points[i - 1] as LatLng, points[i] as LatLng);
  }
  return out;
};

export type LatLngBounds = { north: number; south: number; east: number; west: number };

export const boundsOf = (points: readonly LatLng[]): LatLngBounds => {
  if (points.length === 0) throw new Error('boundsOf() on an empty polyline');
  const first = points[0] as LatLng;
  let north = first.lat;
  let south = first.lat;
  let east = first.lng;
  let west = first.lng;
  for (const p of points) {
    if (p.lat > north) north = p.lat;
    if (p.lat < south) south = p.lat;
    if (p.lng > east) east = p.lng;
    if (p.lng < west) west = p.lng;
  }
  return { north, south, east, west };
};

/**
 * Bounds center. This is what we hand the weather provider — a race-long
 * forecast for one point is plenty for tracks of the scale we support, and it
 * keeps the baked weather timeline to a single series.
 */
export const centroidOf = (points: readonly LatLng[]): LatLng => {
  const b = boundsOf(points);
  return { lat: (b.north + b.south) / 2, lng: (b.east + b.west) / 2 };
};
