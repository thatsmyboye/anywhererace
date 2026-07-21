import type {
  ElevationProvider,
  LatLng,
  Result,
  RouteAnnotation,
  RouteJunction,
  RoutingError,
  RoutingProfile,
  RoutingProvider,
  Track,
  TrackMode,
} from '@anywhererace/core';
import { err, haversineMeters, ok } from '@anywhererace/core';
import { bakeNodes, resampleForBake } from './bake';
import { BAKE } from './constants';

/**
 * Building a track: route each leg, pull elevation for the baked node
 * positions, bake, place the lines and sectors.
 *
 * Routing happens leg by leg on purpose. A one-way network makes closed
 * circuits genuinely hard — a user who drops the four corners of a city block
 * will often find three of those streets run the wrong way — and the builder
 * has to be able to say *which leg* failed the moment it fails, not throw up a
 * mystery error at save time.
 */

export type TrackErrorKind =
  | 'too-few-waypoints'
  | 'leg-failed'
  | 'circuit-not-closed'
  | 'elevation-failed';

export type TrackError = {
  kind: TrackErrorKind;
  message: string;
  /** Which leg failed, 0-based. The closing leg of a circuit is the last one. */
  legIndex?: number;
  /** The waypoint the router could not reach. */
  at?: LatLng;
  cause?: RoutingError;
};

export type BuildTrackInput = {
  id: string;
  name: string;
  mode: TrackMode;
  routingProfile: RoutingProfile;
  waypoints: readonly LatLng[];
  routing: RoutingProvider;
  elevation: ElevationProvider;
};

export const buildTrack = async (
  input: BuildTrackInput,
): Promise<Result<Track, TrackError>> => {
  const { waypoints, mode } = input;

  if (waypoints.length < 2) {
    return err({
      kind: 'too-few-waypoints',
      message: 'A track needs at least two waypoints.',
    });
  }

  const routed = await routeAllLegs(input);
  if (!routed.ok) return routed;
  const { polyline, annotations, junctions } = routed.value;

  if (mode === 'circuit') {
    const first = polyline[0] as LatLng;
    const last = polyline[polyline.length - 1] as LatLng;
    const gapM = haversineMeters(first, last);
    if (gapM > BAKE.circuitClosureToleranceM) {
      return err({
        kind: 'circuit-not-closed',
        message: `The closing leg ends ${gapM.toFixed(0)}m from the start. On a one-way network a loop has to be drivable in a single direction — try moving a waypoint, or switch to point-to-point.`,
        at: last,
      });
    }
  }

  const elevations = await lookupElevations(input, polyline, mode);
  if (!elevations.ok) return elevations;

  const baked = bakeNodes({
    polyline,
    mode,
    annotations,
    junctions,
    elevations: elevations.value,
  });

  return ok({
    id: input.id,
    name: input.name,
    mode,
    routingProfile: input.routingProfile,
    waypoints: waypoints.slice(),
    // Pinned, not re-derived. If OSM changes under us, an old shared link must
    // still replay the road layout the race was created on.
    polyline,
    nodes: baked.nodes,
    lengthMeters: baked.lengthMeters,
    startLine: 0,
    finishLine: baked.lengthMeters,
    sectors: defaultSectors(baked.lengthMeters),
  });
};

type RoutedRoute = {
  polyline: LatLng[];
  annotations: RouteAnnotation[];
  junctions: RouteJunction[];
};

const routeAllLegs = async (
  input: BuildTrackInput,
): Promise<Result<RoutedRoute, TrackError>> => {
  const { waypoints, mode, routing, routingProfile } = input;

  const pairs: [LatLng, LatLng][] = [];
  for (let i = 1; i < waypoints.length; i++) {
    pairs.push([waypoints[i - 1] as LatLng, waypoints[i] as LatLng]);
  }
  if (mode === 'circuit') {
    pairs.push([waypoints[waypoints.length - 1] as LatLng, waypoints[0] as LatLng]);
  }

  const polyline: LatLng[] = [];
  const annotations: RouteAnnotation[] = [];
  const junctions: RouteJunction[] = [];

  for (let legIndex = 0; legIndex < pairs.length; legIndex++) {
    const [from, to] = pairs[legIndex] as [LatLng, LatLng];
    const leg = await routing.routeLeg({ from, to, profile: routingProfile });

    if (!leg.ok) {
      return err({
        kind: 'leg-failed',
        message: legFailureMessage(leg.error, routingProfile, legIndex, pairs.length, mode),
        legIndex,
        at: leg.error.at ?? to,
        cause: leg.error,
      });
    }

    // The first point of every leg after the first duplicates the last point of
    // the previous one, so it is dropped and every index shifts accordingly.
    const dropFirst = polyline.length > 0;
    const offset = polyline.length - (dropFirst ? 1 : 0);
    const points = dropFirst ? leg.value.polyline.slice(1) : leg.value.polyline;

    for (const annotation of leg.value.annotations) {
      annotations.push({
        ...annotation,
        startIndex: annotation.startIndex + offset,
        endIndex: annotation.endIndex + offset,
      });
    }
    for (const junction of leg.value.junctions) {
      junctions.push({ ...junction, atIndex: junction.atIndex + offset });
    }
    polyline.push(...points);
  }

  return ok({ polyline, annotations, junctions });
};

/**
 * Route failures on trails are normal, not bugs — OSM path data has real gaps
 * and dead ends — so the message says so rather than implying something broke.
 */
const legFailureMessage = (
  error: RoutingError,
  profile: RoutingProfile,
  legIndex: number,
  legCount: number,
  mode: TrackMode,
): string => {
  const isClosingLeg = mode === 'circuit' && legIndex === legCount - 1;
  const where = isClosingLeg ? 'The closing leg' : `Leg ${legIndex + 1}`;

  switch (error.kind) {
    case 'illegal-direction':
      return `${where} can't be driven in that direction. One-way streets mean a circuit has to work as a loop in a single direction — try reversing the loop or moving this corner.`;
    case 'no-route':
      return profile === 'motor'
        ? `${where} has no legal route. ${error.message}`
        : `${where} has no route. Trail and path data has gaps and dead ends — this is normal. Try moving the waypoint onto a mapped path.`;
    case 'point-not-snappable':
      return `${where} starts or ends too far from any routable way. Move the waypoint closer to a road or path.`;
    case 'unsupported-profile':
      return `The router does not support the ${profile} profile.`;
    case 'provider-unavailable':
      return `The routing service is unavailable. ${error.message}`;
  }
};

const lookupElevations = async (
  input: BuildTrackInput,
  polyline: readonly LatLng[],
  mode: TrackMode,
): Promise<Result<number[], TrackError>> => {
  // Sample the DEM at exactly the baked node positions, so gradient never has
  // to be interpolated from somewhere else.
  const { points } = resampleForBake(polyline, mode);
  const batchSize = Math.max(1, input.elevation.maxBatchSize);
  const elevations: number[] = [];

  for (let start = 0; start < points.length; start += batchSize) {
    const batch = points.slice(start, start + batchSize);
    const result = await input.elevation.lookup(batch);
    if (!result.ok) {
      return err({
        kind: 'elevation-failed',
        message: `Could not load elevation data for this track. ${result.error.message}`,
      });
    }
    elevations.push(...result.value);
  }

  return ok(elevations);
};

/** Three equal sectors, as distances along the route. */
const defaultSectors = (lengthMeters: number): number[] => {
  const sectors: number[] = [];
  for (let i = 1; i < BAKE.sectorCount; i++) {
    sectors.push((lengthMeters * i) / BAKE.sectorCount);
  }
  return sectors;
};
