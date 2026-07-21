import { bearingDegrees, destinationPoint, haversineMeters, polylineLengthMeters } from '../../geo';
import { createRng } from '../../rng';
import { ok, err } from '../../result';
import type { Result } from '../../result';
import type { LatLng, SurfaceType } from '../../types/track';
import type {
  RouteAnnotation,
  RouteJunction,
  RouteLeg,
  RouteLegRequest,
  RoutingError,
  RoutingProvider,
} from '../routing';

/**
 * A synthetic router. It is not a road network — it invents a plausible-looking
 * wandering path between two points — but it produces exactly the shape of data
 * Valhalla will: uneven vertex spacing, mixed surfaces, junctions with turn
 * angles, and narrow untagged trail widths. That is enough for the baker, the
 * sim, and every test to be built and verified before a real router exists.
 *
 * It is deterministic: the same request against the same provider seed always
 * returns the same geometry.
 */

export type MockRoutingOptions = {
  seed?: string;
  /**
   * How far the path is allowed to wander off the straight line, as a fraction
   * of leg length. Real streets rarely deviate more than this between two
   * points a user would place as adjacent waypoints.
   */
  wanderFraction?: number;
  /** Mean gap between emitted vertices, before jitter. Valhalla is comparably coarse. */
  meanVertexSpacingM?: number;
  /** Surfaces this mock network is made of, sampled per span. */
  surfaces?: readonly SurfaceType[];
  /** Points the router should refuse to route to, for exercising failure UI. */
  unroutable?: readonly LatLng[];
};

const DEFAULTS = {
  seed: 'mock-router',
  wanderFraction: 0.12,
  meanVertexSpacingM: 22,
  surfaces: ['asphalt'] as readonly SurfaceType[],
} as const;

/** Anything closer than this to an `unroutable` point counts as that point. */
const UNROUTABLE_RADIUS_M = 25;

/** Mock spans are this long; short enough to get several per leg. */
const ANNOTATION_SPAN_M = 150;

export const createMockRoutingProvider = (
  options: MockRoutingOptions = {},
): RoutingProvider => {
  const seed = options.seed ?? DEFAULTS.seed;
  const wanderFraction = options.wanderFraction ?? DEFAULTS.wanderFraction;
  const meanSpacing = options.meanVertexSpacingM ?? DEFAULTS.meanVertexSpacingM;
  const surfaces = options.surfaces ?? DEFAULTS.surfaces;
  const unroutable = options.unroutable ?? [];

  return {
    id: 'mock-routing',
    async routeLeg(request: RouteLegRequest): Promise<Result<RouteLeg, RoutingError>> {
      for (const bad of unroutable) {
        if (haversineMeters(request.to, bad) < UNROUTABLE_RADIUS_M) {
          return err({
            kind: 'no-route',
            message:
              'No routable way near this point. Trail and path data has gaps — try moving the waypoint onto a mapped path.',
            at: request.to,
          });
        }
      }

      const straightM = haversineMeters(request.from, request.to);
      if (straightM < 1) {
        return err({
          kind: 'point-not-snappable',
          message: 'Waypoints are too close together to form a leg.',
          at: request.to,
        });
      }

      // The leg's own seed includes its endpoints, so a given leg routes the
      // same way regardless of what order the user placed the waypoints in.
      const legRng = createRng(
        `${seed} leg ${request.profile} ${fixed(request.from)} ${fixed(request.to)}`,
      );

      const polyline = wanderingPath(request.from, request.to, straightM, {
        rng: legRng.fork('shape'),
        wanderFraction,
        meanSpacing,
      });

      return ok({
        polyline,
        lengthMeters: polylineLengthMeters(polyline),
        annotations: mockAnnotations(polyline, legRng.fork('surfaces'), surfaces, request),
        junctions: mockJunctions(polyline),
      });
    },
  };
};

/** Stable string form of a coordinate, so leg seeds don't jitter on float noise. */
const fixed = (p: LatLng): string => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/**
 * Straight line from A to B with a smooth perpendicular offset applied. The
 * offset is a sum of three sine terms with random phase, which gives gentle
 * sweeping curves rather than the white-noise zigzag that per-vertex jitter
 * would produce — and zigzag would make the curvature test meaningless.
 */
const wanderingPath = (
  from: LatLng,
  to: LatLng,
  straightM: number,
  opts: { rng: ReturnType<typeof createRng>; wanderFraction: number; meanSpacing: number },
): LatLng[] => {
  const { rng, wanderFraction, meanSpacing } = opts;
  const heading = bearingDegrees(from, to);
  const maxOffsetM = straightM * wanderFraction;

  const harmonics = [1, 2, 3].map((n) => ({
    frequency: n * Math.PI,
    phase: rng.range(0, 2 * Math.PI),
    // Higher harmonics get smaller amplitude, or the path stops looking like a road.
    amplitude: (maxOffsetM / n) * rng.range(0.3, 1),
  }));

  const offsetAt = (t: number): number => {
    // The envelope pins the offset to zero at both endpoints so the leg still
    // starts and ends exactly where the user put the waypoint.
    const envelope = Math.sin(Math.PI * t);
    let sum = 0;
    for (const h of harmonics) sum += h.amplitude * Math.sin(h.frequency * t + h.phase);
    return envelope * sum;
  };

  const points: LatLng[] = [from];
  let travelled = 0;
  for (;;) {
    // Uneven spacing on purpose: real OSM geometry has wildly variable vertex
    // density, and the resampler exists precisely to absorb that.
    travelled += meanSpacing * rng.range(0.4, 1.8);
    if (travelled >= straightM) break;
    const t = travelled / straightM;
    const alongPoint = destinationPoint(from, heading, travelled);
    const offset = offsetAt(t);
    points.push(
      offset === 0 ? alongPoint : destinationPoint(alongPoint, heading + 90, offset),
    );
  }
  points.push(to);
  return points;
};

const mockAnnotations = (
  polyline: readonly LatLng[],
  rng: ReturnType<typeof createRng>,
  surfaces: readonly SurfaceType[],
  request: RouteLegRequest,
): RouteAnnotation[] => {
  // Roughly one span per ANNOTATION_SPAN_M, at the mock's mean vertex spacing.
  const verticesPerSpan = Math.max(2, Math.round(ANNOTATION_SPAN_M / DEFAULTS.meanVertexSpacingM));
  const annotations: RouteAnnotation[] = [];

  for (let start = 0; start < polyline.length - 1; start += verticesPerSpan) {
    const end = Math.min(start + verticesPerSpan, polyline.length - 1);
    const surface = rng.pick(surfaces);
    // Trails and paths are almost never width-tagged; default narrow so that
    // single-track overtaking stays genuinely hard.
    const isPath = request.profile !== 'motor' && surface !== 'asphalt' && surface !== 'concrete';
    annotations.push({
      startIndex: start,
      endIndex: end,
      surface,
      // Mixed on purpose so the UI's "assumed" badge has something to show.
      surfaceConfidence: rng.bool(0.7) ? 'tagged' : 'inferred',
      widthMeters: isPath ? 1.5 : rng.range(5.5, 9),
      highway: isPath ? 'path' : 'residential',
    });
  }
  return annotations;
};

/**
 * Junctions wherever the path bends hard enough that a real network would have
 * one. Keeps the mock honest about the "legal but full of right-angle turns
 * should feel like it" requirement.
 */
const mockJunctions = (polyline: readonly LatLng[]): RouteJunction[] => {
  const SHARP_TURN_DEG = 45;
  const junctions: RouteJunction[] = [];
  for (let i = 1; i < polyline.length - 1; i++) {
    const before = bearingDegrees(polyline[i - 1] as LatLng, polyline[i] as LatLng);
    const after = bearingDegrees(polyline[i] as LatLng, polyline[i + 1] as LatLng);
    const turn = ((after - before + 540) % 360) - 180;
    if (Math.abs(turn) >= SHARP_TURN_DEG) {
      junctions.push({ atIndex: i, kind: 'sharp-turn', turnAngleDeg: turn });
    }
  }
  return junctions;
};
