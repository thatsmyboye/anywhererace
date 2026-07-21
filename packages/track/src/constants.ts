/**
 * Track baking constants. As with the sim's tuning file, nothing here is
 * allowed to appear inline at a call site.
 */
export const BAKE = {
  /**
   * Uniform node spacing. Raw OSM geometry has wildly uneven vertex density —
   * a straight motorway can run a kilometer between vertices while a roundabout
   * has one every meter — and computing curvature on that directly produces
   * garbage corner radii. Everything downstream assumes this spacing.
   */
  nodeSpacingM: 5,

  /**
   * Half-width of the curvature window. The circumscribed circle is fitted
   * through the points at -15m, here, and +15m. Narrower and GPS-scale noise
   * dominates; wider and real corners get averaged into straights.
   */
  curvatureWindowM: 15,

  /**
   * Rolling median width for curvature smoothing, in nodes. A median rather
   * than a mean because the failure mode being suppressed is single-node
   * spikes from near-collinear points, and a mean would smear them across the
   * whole window instead of rejecting them.
   */
  curvatureMedianWindow: 5,

  /** Radii above this are reported as `Infinity` — the node is a straight. */
  straightRadiusM: 2000,

  /** Radii below this are clamped; anything tighter is bad geometry, not a corner. */
  minRadiusM: 4,

  /**
   * Rolling mean applied to elevation before differentiating it. SRTM is
   * 30m-posted and noisy at the meter scale, and differentiating raw samples
   * 5m apart produces 20% gradients on flat ground.
   */
  elevationMeanWindow: 7,

  /** Gradients are clamped to this; steeper is a data error, not a hill. */
  maxAbsGradient: 0.35,

  /** Default width when nothing upstream tagged one. */
  defaultWidthM: 6,

  /**
   * Trails are almost never width-tagged. Defaulting narrow is deliberate:
   * single-track passing should be genuinely difficult.
   */
  defaultTrailWidthM: 1.5,

  /** Distance either side of a junction over which its speed cap ramps in. */
  junctionInfluenceM: 12,

  /** Number of sectors a lap is split into. */
  sectorCount: 3,

  /** A circuit's closing leg must land within this of the first waypoint. */
  circuitClosureToleranceM: 30,
} as const;

/**
 * Speed cap multipliers for junctions the router flagged. A route that is
 * legal but full of signals and right-angle turns should *feel* like one.
 */
export const JUNCTION_PENALTIES = {
  signals: 0.25,
  stop: 0.15,
  'give-way': 0.5,
  crossing: 0.6,
} as const;

/**
 * Sharp turns are penalized by how sharp they are. Curvature alone does not
 * catch these: a right-angle turn between two long straights can have a
 * perfectly reasonable fitted radius while still requiring you to nearly stop.
 */
export const SHARP_TURN_PENALTY = {
  /** Turns gentler than this are not penalized at all. */
  minAngleDeg: 40,
  /** Penalty at `minAngleDeg`. */
  atMin: 0.8,
  /** Penalty at a full 180-degree hairpin. */
  atStraightBack: 0.2,
} as const;
