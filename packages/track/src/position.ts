import type { LatLng, Track, TrackNode } from '@anywhererace/core';
import {
  bearingDeltaDeg,
  clamp01,
  cumulativeDistances,
  destinationPoint,
  haversineMeters,
  interpolateLatLng,
  normalizeBearingDeg,
  polylineLengthMeters,
  toLocalMeters,
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
 * The point a given distance along a polyline.
 *
 * Distance rather than vertex index, because OSM vertex density is wildly
 * uneven: "the middle vertex" of a routed leg is routinely a few meters from
 * one of its ends. Clamps at both ends rather than wrapping — the caller knows
 * whether its route is a loop, this does not.
 */
export const pointAlongPolyline = (
  points: readonly LatLng[],
  distanceM: number,
): LatLng | undefined => {
  if (points.length === 0) return undefined;
  const first = points[0] as LatLng;
  if (points.length === 1) return first;

  const cumulative = cumulativeDistances(points);
  const total = cumulative[cumulative.length - 1] as number;
  if (total <= 0) return first;

  const wanted = Math.min(Math.max(distanceM, 0), total);
  for (let i = 1; i < points.length; i++) {
    const before = cumulative[i - 1] as number;
    const after = cumulative[i] as number;
    if (after < wanted) continue;
    const span = after - before;
    const t = span <= 0 ? 0 : (wanted - before) / span;
    return interpolateLatLng(points[i - 1] as LatLng, points[i] as LatLng, t);
  }
  return points[points.length - 1] as LatLng;
};

/** The point half way along a polyline, by distance. */
export const midpointOfPolyline = (points: readonly LatLng[]): LatLng | undefined =>
  pointAlongPolyline(points, polylineLengthMeters(points) / 2);

export type PolylineProjection = {
  /** Meters along the polyline, from its start. */
  distanceM: number;
  /** The point on the line itself. */
  point: LatLng;
  /** How far the target was from the line. */
  offsetM: number;
};

/**
 * The closest point on a polyline to somewhere off it.
 *
 * This is what makes a marker *snap*: the builder's start line is a distance
 * along the route, so a marker dragged anywhere near the road has to be turned
 * back into one. Projection is done in a local planar frame centered on the
 * target, which over the length of one 5-50m segment is exact enough that the
 * error is far below the noise already in the OSM geometry.
 */
export const nearestPointOnPolyline = (
  points: readonly LatLng[],
  target: LatLng,
): PolylineProjection | undefined => {
  if (points.length === 0) return undefined;
  const first = points[0] as LatLng;
  if (points.length === 1) {
    return { distanceM: 0, point: first, offsetM: haversineMeters(first, target) };
  }

  const cumulative = cumulativeDistances(points);
  let best: PolylineProjection | undefined;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as LatLng;
    const b = points[i] as LatLng;
    // Centered on the target, so the target sits at the origin and the whole
    // projection is "how close does this segment pass to (0, 0)".
    const localA = toLocalMeters(target, a);
    const localB = toLocalMeters(target, b);
    const vx = localB.x - localA.x;
    const vy = localB.y - localA.y;
    const lengthSq = vx * vx + vy * vy;
    const t =
      lengthSq <= 0 ? 0 : clamp01((-localA.x * vx + -localA.y * vy) / lengthSq);

    const offsetM = Math.hypot(localA.x + t * vx, localA.y + t * vy);
    if (best !== undefined && offsetM >= best.offsetM) continue;

    const before = cumulative[i - 1] as number;
    const span = (cumulative[i] as number) - before;
    best = {
      distanceM: before + t * span,
      point: interpolateLatLng(a, b, t),
      offsetM,
    };
  }

  return best;
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
