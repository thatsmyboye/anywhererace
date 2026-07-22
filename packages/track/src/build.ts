import type {
  ElevationProvider,
  LatLng,
  Result,
  RouteAnnotation,
  RouteJunction,
  RouteLeg,
  RoutingError,
  RoutingProfile,
  RoutingProvider,
  Track,
  TrackMode,
} from '@anywhererace/core';
import { err, haversineMeters, ok } from '@anywhererace/core';
import { bakeNodes, resampleForBake } from './bake';
import { BAKE } from './constants';
import { sweepForSeparation } from './separation';

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
  /** Where the lap starts, in meters along the route. See `BakeRoutedInput`. */
  startLineM?: number | undefined;
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

  return bakeRoutedTrack({
    id: input.id,
    name: input.name,
    mode,
    routingProfile: input.routingProfile,
    waypoints,
    routed: routed.value,
    elevation: input.elevation,
    startLineM: input.startLineM,
  });
};

export type RoutedRoute = {
  polyline: LatLng[];
  annotations: RouteAnnotation[];
  junctions: RouteJunction[];
};

/**
 * Join consecutive legs into one route.
 *
 * The first point of every leg after the first duplicates the last point of the
 * previous one, so it is dropped and every annotation and junction index shifts
 * to match. Exported because the track builder routes legs incrementally as the
 * user edits and needs to assemble them without routing again.
 */
export const concatenateLegs = (legs: readonly RouteLeg[]): RoutedRoute => {
  const polyline: LatLng[] = [];
  const annotations: RouteAnnotation[] = [];
  const junctions: RouteJunction[] = [];

  for (const leg of legs) {
    const dropFirst = polyline.length > 0;
    const offset = polyline.length - (dropFirst ? 1 : 0);
    const points = dropFirst ? leg.polyline.slice(1) : leg.polyline;

    for (const annotation of leg.annotations) {
      annotations.push({
        ...annotation,
        startIndex: annotation.startIndex + offset,
        endIndex: annotation.endIndex + offset,
      });
    }
    for (const junction of leg.junctions) {
      junctions.push({ ...junction, atIndex: junction.atIndex + offset });
    }
    polyline.push(...points);
  }

  return { polyline, annotations, junctions };
};

export type BakeRoutedInput = {
  id: string;
  name: string;
  mode: TrackMode;
  routingProfile: RoutingProfile;
  waypoints: readonly LatLng[];
  routed: RoutedRoute;
  elevation: ElevationProvider;
  /**
   * Where the lap starts, in meters along the route. Circuits only — on a
   * point-to-point the start and finish *are* the ends of the route, and
   * moving them would be trimming it, which dragging the end waypoints
   * already does. Defaults to the first waypoint, which is where it was
   * permanently pinned before.
   */
  startLineM?: number | undefined;
};

/**
 * Everything after routing: closure check, elevation lookup, bake.
 *
 * Split out from `buildTrack` so the builder — which has already routed each
 * leg as the user placed it — can finish a track without asking the router to
 * do all that work a second time.
 */
export const bakeRoutedTrack = async (
  input: BakeRoutedInput,
): Promise<Result<Track, TrackError>> => {
  const { routed, mode } = input;

  if (routed.polyline.length < 2) {
    return err({ kind: 'too-few-waypoints', message: 'This route has no geometry to bake.' });
  }

  if (mode === 'circuit') {
    const first = routed.polyline[0] as LatLng;
    const last = routed.polyline[routed.polyline.length - 1] as LatLng;
    const gapM = haversineMeters(first, last);
    if (gapM > BAKE.circuitClosureToleranceM) {
      return err({
        kind: 'circuit-not-closed',
        message: `The closing leg ends ${gapM.toFixed(0)}m from the start. On a one-way network a loop has to be drivable in a single direction — try moving a waypoint, or switch to point-to-point.`,
        at: last,
      });
    }
  }

  const elevations = await lookupElevations(input.elevation, routed.polyline, mode);
  if (!elevations.ok) return elevations;

  const baked = bakeNodes({
    polyline: routed.polyline,
    mode,
    annotations: routed.annotations,
    junctions: routed.junctions,
    elevations: elevations.value,
  });

  return ok({
    id: input.id,
    name: input.name,
    mode,
    routingProfile: input.routingProfile,
    waypoints: input.waypoints.slice(),
    polyline: routed.polyline,
    nodes: baked.nodes,
    // Swept here rather than on demand because this is the one place every
    // course passes through, and because the answer depends only on the baked
    // nodes: sweeping later would either re-derive the same thing or risk
    // answering for a route the track no longer has.
    separationPoints: sweepForSeparation({
      nodes: baked.nodes,
      mode,
      spacingM: baked.spacingM,
      totalLengthM: baked.lengthMeters,
    }),
    lengthMeters: baked.lengthMeters,
    ...placeLines(mode, baked.lengthMeters, input.startLineM),
  });
};

/**
 * Start line, finish line and sector boundaries.
 *
 * `finishLine` stays one lap ahead of `startLine` rather than being pinned to
 * the end of the route, because the sim reads the gap between them as the race
 * distance for a point-to-point — leaving it at the route length while the
 * start moved would silently shorten the race.
 *
 * Sectors are placed *relative to the line*, so sector 1 always begins at it.
 * They are stored as absolute distances along the route, which is why they
 * wrap: `setup.ts` rotates them back by `startLine` when it builds a race.
 */
const placeLines = (
  mode: TrackMode,
  lengthMeters: number,
  requestedStartM: number | undefined,
): Pick<Track, 'startLine' | 'finishLine' | 'sectors'> => {
  const startLine =
    mode === 'circuit' && requestedStartM !== undefined && lengthMeters > 0
      ? ((requestedStartM % lengthMeters) + lengthMeters) % lengthMeters
      : 0;

  return {
    startLine,
    finishLine: startLine + lengthMeters,
    sectors: defaultSectors(lengthMeters).map((offset) =>
      lengthMeters > 0 ? (startLine + offset) % lengthMeters : offset,
    ),
  };
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

  const legs: RouteLeg[] = [];

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

    legs.push(leg.value);
  }

  return ok(concatenateLegs(legs));
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
  elevation: ElevationProvider,
  polyline: readonly LatLng[],
  mode: TrackMode,
): Promise<Result<number[], TrackError>> => {
  // Sample the DEM at exactly the baked node positions, so gradient never has
  // to be interpolated from somewhere else.
  const { points } = resampleForBake(polyline, mode);
  const batchSize = Math.max(1, elevation.maxBatchSize);
  const elevations: number[] = [];

  for (let start = 0; start < points.length; start += batchSize) {
    const batch = points.slice(start, start + batchSize);
    const result = await elevation.lookup(batch);
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
