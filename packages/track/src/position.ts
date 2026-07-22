import type { LatLng, Track, TrackNode } from '@anywhererace/core';
import {
  bearingDeltaDeg,
  cumulativeDistances,
  destinationPoint,
  interpolateLatLng,
  normalizeBearingDeg,
} from '@anywhererace/core';

/**
 * Turning a racer's 1D position back into a point on the map.
 *
 * The sim moves racers along the route as a single distance plus a lateral
 * offset; the renderer needs a coordinate and a heading. This is the only place
 * that conversion happens, and it belongs here rather than in the UI because it
 * is geometry, not presentation.
 */

export type TrackPosition = {
  lat: number;
  lng: number;
  /** Degrees clockwise from true north — used to rotate the vehicle icon. */
  bearing: number;
  /** Gradient at this point, signed. Handy for a climb indicator. */
  gradient: number;
};

/**
 * The point half way along a polyline, measured by distance.
 *
 * By distance rather than by vertex count, because OSM vertex density is wildly
 * uneven: the middle *vertex* of a routed leg is routinely a few meters from
 * one of its ends, which would put the builder's insert handle somewhere the
 * user would never look for it.
 */
export const midpointOfPolyline = (points: readonly LatLng[]): LatLng | undefined => {
  if (points.length === 0) return undefined;
  const first = points[0] as LatLng;
  if (points.length === 1) return first;

  const cumulative = cumulativeDistances(points);
  const total = cumulative[cumulative.length - 1] as number;
  if (total <= 0) return first;

  const half = total / 2;
  for (let i = 1; i < points.length; i++) {
    const before = cumulative[i - 1] as number;
    const after = cumulative[i] as number;
    if (after < half) continue;
    const span = after - before;
    const t = span <= 0 ? 0 : (half - before) / span;
    return interpolateLatLng(points[i - 1] as LatLng, points[i] as LatLng, t);
  }
  return points[points.length - 1] as LatLng;
};

/**
 * Position at `raceDistanceM`, measured from the start line and cumulative
 * across laps.
 *
 * Circuits wrap; point-to-point routes clamp at both ends so a racer sitting on
 * the grid at a negative distance, or one that has crossed the line, still
 * renders somewhere sensible rather than disappearing.
 */
export const positionOnTrack = (
  track: Track,
  raceDistanceM: number,
  lateralOffsetM = 0,
): TrackPosition => {
  const nodes = track.nodes;
  const count = nodes.length;
  if (count === 0) {
    const fallback = track.polyline[0] ?? { lat: 0, lng: 0 };
    return { lat: fallback.lat, lng: fallback.lng, bearing: 0, gradient: 0 };
  }

  const isCircuit = track.mode === 'circuit';
  const lapLength = track.lengthMeters;

  let alongRoute = track.startLine + raceDistanceM;
  if (isCircuit) {
    alongRoute = ((alongRoute % lapLength) + lapLength) % lapLength;
  } else {
    alongRoute = Math.min(Math.max(alongRoute, 0), lapLength);
  }

  const spacing = count > 1 ? (nodes[1] as TrackNode).distance - (nodes[0] as TrackNode).distance : lapLength;
  const exact = spacing > 0 ? alongRoute / spacing : 0;
  const index = Math.floor(exact);
  const fraction = exact - index;

  const from = nodes[Math.min(Math.max(index, 0), count - 1)] as TrackNode;
  const nextIndex = index + 1;
  const to = (isCircuit ? nodes[nextIndex % count] : nodes[Math.min(nextIndex, count - 1)]) as TrackNode;

  // Interpolating between 5m nodes rather than snapping to them: at 250kph a
  // racer covers a node every 70ms, and snapping would visibly stair-step.
  const point = interpolateLatLng(from, to, fraction);
  // Bearings are interpolated the short way around, or a racer crossing north
  // would spin through a full circle.
  const bearing = normalizeBearingDeg(
    from.bearing + bearingDeltaDeg(from.bearing, to.bearing) * fraction,
  );
  const gradient = from.gradient + (to.gradient - from.gradient) * fraction;

  if (lateralOffsetM === 0) {
    return { lat: point.lat, lng: point.lng, bearing, gradient };
  }

  // Positive offset is to the right of the direction of travel.
  const offsetPoint = destinationPoint(point, bearing + 90, lateralOffsetM);
  return { lat: offsetPoint.lat, lng: offsetPoint.lng, bearing, gradient };
};

/** The route as a GeoJSON LineString, for drawing the track on the map. */
export const trackToGeoJSON = (track: Track): {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  properties: { id: string; name: string; lengthMeters: number };
} => {
  const source = track.nodes.length > 0 ? track.nodes : track.polyline;
  const coordinates: [number, number][] = source.map((point) => [point.lng, point.lat]);
  // Close the loop visually; a circuit's node array omits the duplicate final
  // node, which would otherwise leave a 5m gap at the start line.
  if (track.mode === 'circuit' && coordinates.length > 0) {
    coordinates.push(coordinates[0] as [number, number]);
  }
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates },
    properties: { id: track.id, name: track.name, lengthMeters: track.lengthMeters },
  };
};

/** Bounding box as MapLibre wants it: `[[west, south], [east, north]]`. */
export const trackBounds = (track: Track): [[number, number], [number, number]] => {
  const points: LatLng[] = track.nodes.length > 0 ? track.nodes : track.polyline;
  const first = points[0];
  if (first === undefined) {
    return [
      [0, 0],
      [0, 0],
    ];
  }
  let west = first.lng;
  let east = first.lng;
  let south = first.lat;
  let north = first.lat;
  for (const point of points) {
    if (point.lng < west) west = point.lng;
    if (point.lng > east) east = point.lng;
    if (point.lat < south) south = point.lat;
    if (point.lat > north) north = point.lat;
  }
  return [
    [west, south],
    [east, north],
  ];
};

/**
 * Where the start/finish line sits, and which way it faces, so the map can draw
 * a marker across the track rather than a dot beside it.
 */
export const startLinePosition = (track: Track): TrackPosition =>
  positionOnTrack(track, 0);
