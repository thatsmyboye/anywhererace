import { bearingDegrees, polylineLengthMeters } from '../geo';
import { err, ok } from '../result';
import type { Result } from '../result';
import type { LatLng, RoutingProfile, SurfaceType } from '../types/track';
import { VALHALLA_POLYLINE_PRECISION, decodePolyline, encodePolyline } from './polyline';
import type {
  JunctionKind,
  RouteAnnotation,
  RouteJunction,
  RouteLeg,
  RouteLegRequest,
  RoutingError,
  RoutingProvider,
} from './routing';

/**
 * Valhalla, via the FOSSGIS public instance by default.
 *
 * Chosen over OSRM because a single engine has to give us multiple travel
 * profiles *and* turn restrictions. The router refusing to emit illegal
 * geometry is what keeps legality out of the simulation entirely.
 *
 * Two endpoints are used, for different jobs:
 *
 * - `/route` gives geometry and maneuvers. It is cheap and is what runs while
 *   the user is dragging a waypoint around.
 * - `/trace_attributes` gives per-edge `surface`, `road_class` and lane counts.
 *   It is what makes off-road tracks real rather than uniformly asphalt, but it
 *   is a second request per leg, so it only runs when a track is being baked.
 *
 * Be a good citizen of the public instance: it is free, and the fastest way to
 * lose it is to hammer it on every mouse move. The builder debounces, routes
 * only the legs that actually changed, and asks for surface detail once.
 */

export type ValhallaOptions = {
  /** Base URL, no trailing slash. */
  baseUrl?: string;
  /** Abort a request after this long. */
  timeoutMs?: number;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

const DEFAULTS = {
  // FOSSGIS run this for public use. Self-host before doing anything at volume.
  baseUrl: 'https://valhalla1.openstreetmap.de',
  timeoutMs: 12_000,
} as const;

/** Valhalla calls travel modes "costing". */
const COSTING: Record<RoutingProfile, string> = {
  motor: 'auto',
  bicycle: 'bicycle',
  pedestrian: 'pedestrian',
};

/**
 * Maneuver types that mean a junction the racer has to slow for. Valhalla's
 * full list is long; these are the ones that cost time.
 * See https://valhalla.github.io/valhalla/api/turn-by-turn/api-reference/
 */
const JUNCTION_MANEUVERS: Record<number, JunctionKind> = {
  9: 'sharp-turn', // sharp right
  13: 'sharp-turn', // sharp left
  15: 'sharp-turn', // u-turn right
  16: 'sharp-turn', // u-turn left
  26: 'crossing', // roundabout enter
  27: 'crossing', // roundabout exit
};

/** Valhalla `surface` values mapped onto our vocabulary. */
const SURFACE_MAP: Record<string, SurfaceType> = {
  paved_smooth: 'asphalt',
  paved: 'asphalt',
  paved_rough: 'cobble',
  compacted: 'gravel',
  dirt: 'dirt',
  gravel: 'gravel',
  path: 'trail',
  impassable: 'sand',
};

export const createValhallaProvider = (options: ValhallaOptions = {}): RoutingProvider => {
  const baseUrl = options.baseUrl ?? DEFAULTS.baseUrl;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  return {
    id: 'valhalla',

    async routeLeg(request: RouteLegRequest): Promise<Result<RouteLeg, RoutingError>> {
      const routed = await callRoute(request);
      if (!routed.ok) return routed;

      // Surface detail is a second request, so it is only fetched when the
      // caller says it needs it — at bake time, not on every drag.
      if (request.detail !== 'full') return routed;

      const enriched = await enrich(routed.value, request);
      // A failed enrichment is not a failed route. Falling back to inferred
      // attributes is far better than refusing to build the track.
      return ok(enriched);
    },
  };

  async function callRoute(request: RouteLegRequest): Promise<Result<RouteLeg, RoutingError>> {
    const body = {
      locations: [
        { lat: request.from.lat, lon: request.from.lng },
        { lat: request.to.lat, lon: request.to.lng },
      ],
      costing: COSTING[request.profile],
      directions_options: { units: 'kilometers' },
      // We only want geometry and maneuvers; narrative text is wasted bytes.
      directions_type: 'maneuvers',
    };

    const response = await post<ValhallaRouteResponse>(`${baseUrl}/route`, body);
    if (!response.ok) return response;

    const leg = response.value.trip?.legs?.[0];
    if (leg === undefined || typeof leg.shape !== 'string') {
      return err({
        kind: 'no-route',
        message: describeNoRoute(request.profile),
        at: request.to,
      });
    }

    const polyline = decodePolyline(leg.shape, VALHALLA_POLYLINE_PRECISION);
    if (polyline.length < 2) {
      return err({
        kind: 'point-not-snappable',
        message: 'The router could not snap these points to a way.',
        at: request.to,
      });
    }

    return ok({
      polyline,
      lengthMeters: polylineLengthMeters(polyline),
      annotations: defaultAnnotations(polyline, request.profile),
      junctions: junctionsFrom(leg.maneuvers ?? [], polyline),
    });
  }

  /** Second pass: per-edge surface and width from `/trace_attributes`. */
  async function enrich(leg: RouteLeg, request: RouteLegRequest): Promise<RouteLeg> {
    const body = {
      encoded_polyline: encodeForTrace(leg.polyline),
      costing: COSTING[request.profile],
      // `edge_walk` tells Valhalla the shape is already snapped to its own
      // graph, which is true — it produced it — and is far cheaper than
      // map-matching a GPS trace.
      shape_match: 'edge_walk',
      filters: {
        attributes: ['edge.surface', 'edge.road_class', 'edge.begin_shape_index', 'edge.end_shape_index'],
        action: 'include',
      },
    };

    const response = await post<ValhallaTraceResponse>(`${baseUrl}/trace_attributes`, body);
    if (!response.ok || response.value.edges === undefined) return leg;

    const annotations: RouteAnnotation[] = [];
    for (const edge of response.value.edges) {
      const start = edge.begin_shape_index;
      const end = edge.end_shape_index;
      if (typeof start !== 'number' || typeof end !== 'number' || end <= start) continue;

      const surface = edge.surface === undefined ? undefined : SURFACE_MAP[edge.surface];
      annotations.push({
        startIndex: start,
        endIndex: end,
        surface: surface ?? defaultSurfaceFor(request.profile),
        // Valhalla reports the surface tag when there is one; it does not tell
        // us whether it was tagged or inferred, so this is marked inferred
        // unless it came back with a specific value.
        surfaceConfidence: surface === undefined ? 'inferred' : 'tagged',
        widthMeters: widthFor(surface ?? defaultSurfaceFor(request.profile), edge.road_class),
        highway: edge.road_class ?? 'unclassified',
      });
    }

    return annotations.length === 0 ? leg : { ...leg, annotations };
  }

  async function post<T>(url: string, body: unknown): Promise<Result<T, RoutingError>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.status === 429) {
        return err({
          kind: 'provider-unavailable',
          message: 'The public routing service is rate-limiting us. Try again shortly.',
        });
      }
      if (!response.ok) {
        // Valhalla answers an unroutable request with 400 and an error code,
        // which is a legitimate answer rather than an outage.
        const detail = await safeJson<ValhallaErrorResponse>(response);
        if (response.status === 400) {
          return err({
            kind: detail?.error_code === 171 ? 'illegal-direction' : 'no-route',
            message: detail?.error ?? 'No route between these points.',
          });
        }
        return err({
          kind: 'provider-unavailable',
          message: `Routing service returned ${response.status}.`,
        });
      }

      return ok((await response.json()) as T);
    } catch (error: unknown) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return err({
        kind: 'provider-unavailable',
        message: aborted
          ? 'The routing service did not respond in time.'
          : `Could not reach the routing service: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }
};

const safeJson = async <T>(response: Response): Promise<T | undefined> => {
  try {
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
};

/**
 * Junctions the baker can penalise.
 *
 * Two sources, merged. Valhalla's maneuvers name the junction *kind* — a
 * roundabout, a u-turn — but there are hard turns in real geometry that it does
 * not raise a maneuver for at all, and those still cost a racer time. So the
 * shape is also scanned for corners sharp enough to have to brake for.
 *
 * The turn angle is always measured from the geometry, never taken from
 * Valhalla, which reports a coarse turn *type* rather than degrees.
 */
const junctionsFrom = (
  maneuvers: readonly ValhallaManeuver[],
  polyline: readonly LatLng[],
): RouteJunction[] => {
  const kindByIndex = new Map<number, JunctionKind>();
  for (const maneuver of maneuvers) {
    const index = maneuver.begin_shape_index;
    if (typeof index !== 'number') continue;
    const kind = maneuver.type === undefined ? undefined : JUNCTION_MANEUVERS[maneuver.type];
    if (kind !== undefined) kindByIndex.set(index, kind);
  }

  const junctions: RouteJunction[] = [];
  let lastEmittedIndex = -MIN_JUNCTION_SEPARATION;

  for (let index = 1; index < polyline.length - 1; index++) {
    const before = bearingDegrees(polyline[index - 1] as LatLng, polyline[index] as LatLng);
    const after = bearingDegrees(polyline[index] as LatLng, polyline[index + 1] as LatLng);
    const turn = ((after - before + 540) % 360) - 180;

    const kind = kindByIndex.get(index);
    if (kind === undefined && Math.abs(turn) < SHARP_TURN_DEG) continue;
    // A single bend spread over several dense shape points would otherwise be
    // reported as a run of separate junctions.
    if (index - lastEmittedIndex < MIN_JUNCTION_SEPARATION) continue;

    junctions.push({ atIndex: index, kind: kind ?? 'sharp-turn', turnAngleDeg: turn });
    lastEmittedIndex = index;
  }
  return junctions;
};

/** Turns sharper than this cost time even where the router raised no maneuver. */
const SHARP_TURN_DEG = 50;

/** Shape points between junctions, so one bend is not reported many times. */
const MIN_JUNCTION_SEPARATION = 3;

/**
 * Attributes used until (or unless) `/trace_attributes` fills them in. The
 * baker treats a single span covering the whole leg as "we do not know", which
 * is exactly right — and every node it produces is marked `inferred`.
 */
const defaultAnnotations = (
  polyline: readonly LatLng[],
  profile: RoutingProfile,
): RouteAnnotation[] => {
  const surface = defaultSurfaceFor(profile);
  return [
    {
      startIndex: 0,
      endIndex: polyline.length - 1,
      surface,
      surfaceConfidence: 'inferred',
      widthMeters: widthFor(surface, undefined),
      highway: profile === 'motor' ? 'unclassified' : 'path',
    },
  ];
};

const defaultSurfaceFor = (profile: RoutingProfile): SurfaceType =>
  profile === 'motor' ? 'asphalt' : 'trail';

/**
 * Width, since Valhalla does not report it and OSM rarely tags it. Trails
 * default narrow on purpose: that is what makes single-track passing hard.
 */
const widthFor = (surface: SurfaceType, roadClass: string | undefined): number => {
  if (surface === 'trail' || surface === 'sand') return 1.5;
  switch (roadClass) {
    case 'motorway':
    case 'trunk':
      return 11;
    case 'primary':
      return 9;
    case 'secondary':
      return 8;
    case 'tertiary':
      return 7;
    case 'residential':
    case 'unclassified':
      return 6;
    case 'service':
    case 'living_street':
      return 4.5;
    default:
      return 6;
  }
};

/** `/trace_attributes` wants the shape back in the same encoding. */
const encodeForTrace = (polyline: readonly LatLng[]): string =>
  encodePolyline(polyline, VALHALLA_POLYLINE_PRECISION);

const describeNoRoute = (profile: RoutingProfile): string =>
  profile === 'motor'
    ? 'No legal route between these points. One-way streets and turn restrictions may make this leg impossible in this direction.'
    : 'No route between these points. Trail and path data has gaps and dead ends — this is normal. Try moving the waypoint onto a mapped path.';

// --- Response shapes, narrowed to what is actually read ---------------------

type ValhallaManeuver = {
  type?: number;
  begin_shape_index?: number;
};

type ValhallaRouteResponse = {
  trip?: {
    legs?: { shape?: string; maneuvers?: ValhallaManeuver[] }[];
  };
};

type ValhallaTraceResponse = {
  edges?: {
    surface?: string;
    road_class?: string;
    begin_shape_index?: number;
    end_shape_index?: number;
  }[];
};

type ValhallaErrorResponse = {
  error?: string;
  error_code?: number;
};
