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
 * Why a stretch of road is a candidate for breaking the field apart.
 *
 * Named after what is on the ground rather than after what it does, because the
 * same feature selects differently for different classes — a 6% climb shatters
 * a bunch of cyclists and barely registers to a GT car.
 */
export type SeparationKind =
  /** A sustained gradient. The classic selection point in road racing. */
  | 'climb'
  /** The road narrows to where a bunch cannot stay abreast and has to string out. */
  | 'narrows'
  /** Corners, junctions or both in quick succession; the concertina effect. */
  | 'technical'
  /** A change onto a surface that punishes road tires — cobble, gravel, dirt. */
  | 'surface'
  /** A long stretch on a constant bearing: echelon country, *if* it blows. */
  | 'exposed';

/**
 * A stretch of route where the field could plausibly come apart.
 *
 * Produced by a cheap sweep over the baked nodes at course-creation time. This
 * is an *observation about the road*, not a prediction about a race: nothing in
 * the sim reads it, no racer behaves differently because of it, and two races
 * over the same course will not necessarily split in the same places or at all.
 * It exists so a race director can look at a course and see where it is likely
 * to be decided.
 */
export type SeparationPoint = {
  /** Meters along the route where the feature begins. */
  startM: number;
  /**
   * Meters along the route where it ends. Always greater than `startM` — a
   * feature that straddles a circuit's start line reports an `endM` past the
   * lap length rather than one that reads as being behind its own start.
   */
  endM: number;
  kind: SeparationKind;
  /**
   * 0-1, how strongly this feature should break a bunch up, for ranking one
   * candidate against another on the same course. Not comparable between
   * courses and not a probability.
   */
  severity: number;
  /** One line of UI copy naming what the sweep actually found here. */
  detail: string;
};

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
  /**
   * BAKED, alongside `nodes`. Where the course could break the field apart.
   *
   * Optional because tracks saved before the sweep existed do not carry it, and
   * absent has to stay distinguishable from empty: `undefined` means "never
   * analyzed", `[]` means "analyzed, and this course is flat and wide".
   */
  separationPoints?: SeparationPoint[];
  lengthMeters: number;
  /** Distance along the route where the lap starts. */
  startLine: number;
  finishLine: number;
  /** Distances splitting the lap into sectors; length 2 for the usual three. */
  sectors: number[];
};
