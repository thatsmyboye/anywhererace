export type LatLng = { lat: number; lng: number };

/** ISO-8601 instant, always with an explicit offset or `Z`. */
export type ISOTimestamp = string;

export type TrackId = string;
export type RacerId = string;
export type VehicleClassId = string;

/**
 * What a route is legal for. Chosen at track-build time; the router refuses to
 * emit geometry that violates it, so the sim never reasons about legality.
 */
export type RoutingProfile =
  | 'motor' // one-way + turn restrictions enforced; cars, race cars
  | 'bicycle' // contraflow bike lanes allowed; unpaved permitted
  | 'pedestrian'; // trails, footpaths, steps included; restrictions mostly ignored

export type SurfaceType =
  | 'asphalt'
  | 'concrete'
  | 'gravel'
  | 'dirt'
  | 'cobble'
  | 'trail'
  | 'sand'
  | 'grass';

export const SURFACE_TYPES: readonly SurfaceType[] = [
  'asphalt',
  'concrete',
  'gravel',
  'dirt',
  'cobble',
  'trail',
  'sand',
  'grass',
];

/**
 * Whether `surface` came from an OSM tag or was guessed from the highway type.
 * Surfaced in the UI as "assumed" so a user can see why a gravel sector
 * appeared on what they thought was a road.
 */
export type SurfaceConfidence = 'tagged' | 'inferred';

export type TrackMode = 'circuit' | 'point-to-point';

/**
 * A baked sample of the route at uniform 5m spacing. Everything the tick needs
 * to know about the world lives here — the sim never touches raw geometry.
 */
export type TrackNode = {
  /** Meters from the route start. */
  distance: number;
  lat: number;
  lng: number;
  /** Degrees clockwise from true north. Wind interacts with this. */
  bearing: number;
  /** Meters. `Infinity` on straights. */
  curvatureRadius: number;
  /** Rise over run, signed; positive is uphill in the direction of travel. */
  gradient: number;
  surface: SurfaceType;
  surfaceConfidence: SurfaceConfidence;
  /** Drives how many racers can run side by side at this point. */
  widthMeters: number;
  /** 0-1 speed cap from turn restrictions, signals, and stops. 1 = no penalty. */
  junctionPenalty: number;
  /** Meters above sea level, from a DEM — never derived from route geometry. */
  elevation: number;
};

export type Track = {
  id: TrackId;
  name: string;
  mode: TrackMode;
  routingProfile: RoutingProfile;
  /** User-editable source of truth. */
  waypoints: LatLng[];
  /**
   * Snapped route from the RoutingProvider. Pinned rather than re-derived: a
   * shared race must replay the road layout it was created on, even after OSM
   * changes underneath it.
   */
  polyline: LatLng[];
  /** BAKED. Regenerate whenever `polyline` changes. */
  nodes: TrackNode[];
  lengthMeters: number;
  /** Distance along the route where the lap starts. */
  startLine: number;
  finishLine: number;
  /** Distances splitting the lap into sectors; length 2 for the usual three. */
  sectors: number[];
};
