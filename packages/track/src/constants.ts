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
 * The separation sweep.
 *
 * Thresholds for the pass that runs once per course, at bake time, looking for
 * stretches of road where a bunch could come apart. Calibrated for road cycling
 * — that is the format the question is asked about, and it is also the strictest
 * case, because a bunch of cyclists holds together through things that would
 * already have strung out a field of cars.
 *
 * Every one of these is a *road* threshold, never a race one. Nothing here
 * knows about racers, weather, or which classes are entered.
 */
export const SEPARATION = {
  /**
   * Gradient at which a climb starts selecting. 3% is the conventional dividing
   * line between a drag a bunch rides over intact and a climb where the weaker
   * riders start going out the back.
   */
  minClimbGradient: 0.03,

  /**
   * How long that gradient has to hold. Below about 150m even a steep ramp is
   * taken with momentum and nobody loses the wheel in front.
   */
  minClimbLengthM: 150,

  /**
   * Vertical meters the climb must actually gain. Length and gradient can both
   * pass while the climb is trivially small; this is the backstop.
   */
  minClimbGainM: 8,

  /** Gradient at which `severity` for a climb saturates. 12% is a wall. */
  fullClimbGradient: 0.12,

  /** Climb length at which `severity` saturates, in meters. */
  fullClimbLengthM: 2000,

  /**
   * How much of a climb's severity comes from its gradient rather than its
   * length. Weighted toward gradient because a short wall selects harder than a
   * long drag: riders come off the back on the steep bit, not on the kilometer.
   */
  climbGradientWeight: 0.6,

  /**
   * Width below which a road cannot hold a bunch abreast and it has to string
   * out. Two riders need about 2m; 4m is where a group of forty stops being
   * able to move up on either side and the front of the race stops being
   * reachable.
   */
  narrowWidthM: 4,

  /** How much of that narrow road it takes to matter. */
  minNarrowLengthM: 100,

  /** Width at which `severity` for a narrows saturates: genuine single track. */
  fullNarrowWidthM: 1.5,

  /** Narrows length at which `severity` saturates. */
  fullNarrowLengthM: 1000,

  /**
   * How much of a narrows' severity comes from the width rather than the
   * length. Width-weighted for the same reason as the climb: it is the pinch
   * that does the damage, and a long pinch is not much worse than a short one.
   */
  narrowWidthWeight: 0.65,

  /**
   * Corner radius below which a node counts as technical. Tighter than this and
   * the bunch has to brake, which is what produces the concertina.
   */
  technicalRadiusM: 60,

  /** Junction penalty below which a node counts as technical regardless of radius. */
  technicalJunctionPenalty: 0.6,

  /**
   * Technical nodes needed within `technicalWindowM` before the stretch counts.
   * A single corner is not a selection point; six in four hundred meters is.
   */
  minTechnicalDensity: 0.25,
  technicalWindowM: 400,

  /**
   * Surfaces that break a road bunch up, and how hard. Cobbles are worst: they
   * are ridden fast and they punish position, so the bunch fights for the front
   * and then shatters. Trail and sand are absent on purpose — a route made of
   * those is not a road race that occasionally hits gravel, it is an off-road
   * course, and flagging every node of it would say nothing.
   */
  roughSurfaceSeverity: { cobble: 1, gravel: 0.85, dirt: 0.7 },

  /** How much rough surface it takes to matter. Cobbles select fast. */
  minRoughLengthM: 80,

  /** Rough-surface length at which `severity` saturates. */
  fullRoughLengthM: 1500,

  /** How much of a rough sector's severity comes from which surface it is. */
  roughSurfaceWeight: 0.7,

  /**
   * A stretch counts as exposed while its bearing stays within this many
   * degrees of where it started. Echelons form on sustained crosswinds, and a
   * road that keeps turning gives the bunch shelter on every change of
   * direction.
   */
  exposedBearingToleranceDeg: 25,

  /**
   * How long that has to hold. Long: this is the one kind that is conditional
   * on weather the sweep cannot see, so it should only fire on stretches where
   * a crosswind would genuinely be decisive.
   */
  minExposedLengthM: 1200,

  /** Exposed length at which `severity` saturates. */
  fullExposedLengthM: 5000,

  /**
   * Severity ceiling for an exposed stretch. Capped below the others because it
   * only separates *if* there is a crosswind, and the sweep runs before any
   * weather is baked — see the copy this produces, which says so.
   */
  maxExposedSeverity: 0.5,

  /**
   * Most points to keep, best first. A long mountain course can produce dozens
   * of qualifying stretches, and a list of dozens is not a read on a course.
   */
  maxPoints: 12,
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
