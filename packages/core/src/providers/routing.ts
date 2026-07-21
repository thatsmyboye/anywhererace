import type { Result } from '../result';
import type {
  LatLng,
  RoutingProfile,
  SurfaceConfidence,
  SurfaceType,
} from '../types/track';
import type { VehicleCategory } from '../types/vehicle';

/**
 * Snap-to-route. The concrete implementation is Valhalla (self-hosted or the
 * FOSSGIS public instance); this interface exists so the sim, the baker, and
 * every test can run against a mock instead.
 *
 * The provider routes *one leg at a time*, deliberately. The track builder needs
 * to show the user which specific leg failed the moment they place a waypoint —
 * a one-way street that makes a city-block circuit impossible should be flagged
 * at the offending corner, not as a mysterious failure at save time.
 */
export interface RoutingProvider {
  readonly id: string;
  routeLeg(request: RouteLegRequest): Promise<Result<RouteLeg, RoutingError>>;
}

export type RouteLegRequest = {
  from: LatLng;
  to: LatLng;
  profile: RoutingProfile;
  /**
   * How much the caller needs to know about the road, not just its shape.
   *
   * `geometry` (the default) is what the track builder asks for while the user
   * is dragging a waypoint: fast, and enough to draw the route. `full` also
   * resolves per-edge surface and width, which a real router may have to make
   * a second request for — so it is only asked for when a track is baked.
   */
  detail?: 'geometry' | 'full';
};

export type RouteLeg = {
  /** Snapped geometry, `from`-to-`to` inclusive. Vertex spacing is uneven. */
  polyline: LatLng[];
  lengthMeters: number;
  /** Road/path attributes, as spans over `polyline` indices. */
  annotations: RouteAnnotation[];
  /** Junctions along the leg, at polyline indices, for the baker to penalize. */
  junctions: RouteJunction[];
};

/** Attributes of a contiguous span of the leg, `[startIndex, endIndex]`. */
export type RouteAnnotation = {
  startIndex: number;
  endIndex: number;
  surface: SurfaceType;
  surfaceConfidence: SurfaceConfidence;
  /**
   * Usable width. Trails are almost never tagged; providers should default
   * narrow rather than guessing generously — difficult passing on single-track
   * is intended behavior.
   */
  widthMeters: number;
  /** Raw OSM `highway=` value, kept for surface inference and UI copy. */
  highway: string;
};

export type JunctionKind = 'signals' | 'stop' | 'give-way' | 'sharp-turn' | 'crossing';

export type RouteJunction = {
  atIndex: number;
  kind: JunctionKind;
  /** Turn angle in degrees, 0 = straight through. Signed: negative is left. */
  turnAngleDeg: number;
};

export type RoutingErrorKind =
  | 'no-route' // the router could not connect the two points at all
  | 'illegal-direction' // a legal path exists but not in the requested direction
  | 'unsupported-profile'
  | 'point-not-snappable' // waypoint is too far from any routable way
  | 'provider-unavailable';

export type RoutingError = {
  kind: RoutingErrorKind;
  message: string;
  /** Which end of the leg is at fault, when the router can tell us. */
  at?: LatLng;
};

/**
 * Whether a route built for `profile` may be raced by a vehicle of `category`.
 *
 * A motor route is the strict subset everyone can physically traverse, so it is
 * open to all classes. A bicycle route may run contraflow down a one-way street
 * and across unpaved surfaces, neither of which a car can legally or usefully
 * do. A pedestrian route may include steps and footways narrow enough that only
 * a runner belongs on them.
 *
 * FOR REVIEW: CLAUDE.md does not state this mapping outright, so this is an
 * interpretation. The debatable case is bicycle routes: a `road-cyclist` here
 * is `micromobility`, not `road`, so "no cars on a bike route" is expressed by
 * excluding the `road` category entirely.
 */
export const PROFILE_ALLOWED_CATEGORIES: Record<RoutingProfile, readonly VehicleCategory[]> = {
  motor: ['foot', 'micromobility', 'road', 'performance', 'motorsport'],
  bicycle: ['foot', 'micromobility'],
  pedestrian: ['foot'],
};
