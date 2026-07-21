import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ElevationProvider,
  LatLng,
  RouteLeg,
  RoutingError,
  RoutingProfile,
  RoutingProvider,
  Track,
  TrackMode,
} from '@anywhererace/core';
import type { TrackPreview } from '@anywhererace/track';
import { bakeRoutedTrack, buildPreview, concatenateLegs } from '@anywhererace/track';
import type { TrackError } from '@anywhererace/track';

/**
 * Track builder state.
 *
 * Two things drive the design:
 *
 * 1. **Routing is the expensive part**, and it runs against a free public
 *    service. Legs are cached by their endpoints and profile, so dragging the
 *    third of five waypoints re-routes exactly two legs and everything else is
 *    a cache hit — which also makes undo and redo instant rather than a fresh
 *    round of network calls.
 *
 * 2. **A failed leg is normal**, especially off-road, and it has to be
 *    attributable. Each leg keeps its own status, so the builder can point at
 *    the offending corner the moment it fails rather than reporting a mystery
 *    at save time.
 */

export type LegStatus =
  | { state: 'routing' }
  | { state: 'ok'; leg: RouteLeg }
  | { state: 'failed'; error: RoutingError };

export type BuilderLeg = {
  /** Index of the waypoint this leg starts at. */
  fromIndex: number;
  /** Index of the waypoint it ends at. Wraps to 0 for a circuit's closing leg. */
  toIndex: number;
  from: LatLng;
  to: LatLng;
  status: LegStatus;
};

export type BuilderSnapshot = {
  name: string;
  mode: TrackMode;
  routingProfile: RoutingProfile;
  waypoints: LatLng[];
};

export type UseTrackBuilderOptions = {
  routing: RoutingProvider;
  elevation: ElevationProvider;
  initial?: Partial<BuilderSnapshot>;
  /** Debounce before the preview is recomputed after the route settles. */
  previewDebounceMs?: number;
};

const DEFAULT_PREVIEW_DEBOUNCE_MS = 700;
/** Deep enough to undo a whole editing session, shallow enough to stay cheap. */
const MAX_HISTORY = 100;

const EMPTY: BuilderSnapshot = {
  name: 'New track',
  mode: 'circuit',
  routingProfile: 'motor',
  waypoints: [],
};

/**
 * Undo history, kept as one value.
 *
 * All three lists move together, so they are one piece of state rather than
 * three refs. That matters for more than tidiness: mutating refs inside a
 * `setState` updater is not safe — React may invoke an updater more than once,
 * and under StrictMode in development it deliberately does, which would push
 * duplicate entries onto the history.
 */
type History = {
  present: BuilderSnapshot;
  past: BuilderSnapshot[];
  future: BuilderSnapshot[];
};

export const useTrackBuilder = (options: UseTrackBuilderOptions) => {
  const { routing, elevation, previewDebounceMs = DEFAULT_PREVIEW_DEBOUNCE_MS } = options;

  const [history, setHistory] = useState<History>(() => ({
    present: { ...EMPTY, ...options.initial },
    past: [],
    future: [],
  }));
  const snapshot = history.present;

  const [legs, setLegs] = useState<BuilderLeg[]>([]);
  const [preview, setPreview] = useState<TrackPreview | undefined>(undefined);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<TrackError | undefined>(undefined);

  /**
   * Routed legs, keyed by endpoints and profile. A waypoint dragged and then
   * dragged back costs nothing, and undo is free.
   */
  const legCache = useRef(new Map<string, RouteLeg | RoutingError>());
  /** Guards against a slow response for an edit the user has already undone. */
  const routingGeneration = useRef(0);

  /**
   * Every edit goes through here, as a function of the *current* state rather
   * than of whatever was current when the component last rendered.
   *
   * This is not a style preference. Four map clicks in quick succession all
   * happen before React re-renders, so a closure-captured snapshot would give
   * each of them the same starting point and three of the four waypoints would
   * silently vanish.
   */
  const commit = useCallback((update: (current: BuilderSnapshot) => BuilderSnapshot) => {
    setHistory((current) => {
      const next = update(current.present);
      if (next === current.present) return current;
      return {
        present: next,
        past: [...current.past, current.present].slice(-MAX_HISTORY),
        // Editing after an undo abandons the redo branch, as everywhere else.
        future: [],
      };
    });
  }, []);

  // --- editing -------------------------------------------------------------

  const addWaypoint = useCallback(
    (point: LatLng) => commit((current) => ({ ...current, waypoints: [...current.waypoints, point] })),
    [commit],
  );

  const moveWaypoint = useCallback(
    (index: number, point: LatLng) =>
      commit((current) => {
        if (index < 0 || index >= current.waypoints.length) return current;
        const waypoints = current.waypoints.slice();
        waypoints[index] = point;
        return { ...current, waypoints };
      }),
    [commit],
  );

  const removeWaypoint = useCallback(
    (index: number) =>
      commit((current) =>
        index < 0 || index >= current.waypoints.length
          ? current
          : { ...current, waypoints: current.waypoints.filter((_, i) => i !== index) },
      ),
    [commit],
  );

  const setMode = useCallback(
    (mode: TrackMode) => commit((current) => (current.mode === mode ? current : { ...current, mode })),
    [commit],
  );

  const setRoutingProfile = useCallback(
    (routingProfile: RoutingProfile) =>
      commit((current) =>
        current.routingProfile === routingProfile ? current : { ...current, routingProfile },
      ),
    [commit],
  );

  // The name does not change the route, so it does not earn an undo entry —
  // typing a title should not fill the history with keystrokes.
  const setName = useCallback((name: string) => {
    setHistory((current) => ({ ...current, present: { ...current.present, name } }));
  }, []);

  const clear = useCallback(
    () => commit((current) => (current.waypoints.length === 0 ? current : { ...current, waypoints: [] })),
    [commit],
  );

  const undo = useCallback(() => {
    setHistory((current) => {
      const previous = current.past[current.past.length - 1];
      if (previous === undefined) return current;
      return {
        present: previous,
        past: current.past.slice(0, -1),
        future: [current.present, ...current.future].slice(0, MAX_HISTORY),
      };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((current) => {
      const next = current.future[0];
      if (next === undefined) return current;
      return {
        present: next,
        past: [...current.past, current.present].slice(-MAX_HISTORY),
        future: current.future.slice(1),
      };
    });
  }, []);

  // --- routing -------------------------------------------------------------

  const legPairs = useMemo(
    () => buildLegPairs(snapshot.waypoints, snapshot.mode),
    [snapshot.waypoints, snapshot.mode],
  );

  useEffect(() => {
    const generation = ++routingGeneration.current;
    if (legPairs.length === 0) {
      setLegs([]);
      setPreview(undefined);
      return;
    }

    // Show cached legs immediately and only mark the genuinely unknown ones as
    // routing, so dragging one waypoint does not flash the whole route.
    const initial = legPairs.map((pair): BuilderLeg => {
      const cached = legCache.current.get(cacheKey(pair.from, pair.to, snapshot.routingProfile));
      return { ...pair, status: toStatus(cached) };
    });
    setLegs(initial);

    const pending = legPairs.filter(
      (pair) => !legCache.current.has(cacheKey(pair.from, pair.to, snapshot.routingProfile)),
    );
    if (pending.length === 0) return;

    let cancelled = false;
    void (async () => {
      // Sequential, not parallel. Firing eight simultaneous requests at a free
      // public router is how a shared instance starts refusing them.
      for (const pair of pending) {
        if (cancelled || routingGeneration.current !== generation) return;
        const key = cacheKey(pair.from, pair.to, snapshot.routingProfile);
        const result = await routing.routeLeg({
          from: pair.from,
          to: pair.to,
          profile: snapshot.routingProfile,
        });
        legCache.current.set(key, result.ok ? result.value : result.error);

        if (cancelled || routingGeneration.current !== generation) return;
        setLegs((current) =>
          current.map((leg) =>
            leg.fromIndex === pair.fromIndex && leg.toIndex === pair.toIndex
              ? { ...leg, status: toStatus(result.ok ? result.value : result.error) }
              : leg,
          ),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [legPairs, snapshot.routingProfile, routing]);

  // --- preview -------------------------------------------------------------

  const routedLegs = useMemo(
    () => legs.filter((leg) => leg.status.state === 'ok').map((leg) => (leg.status as { leg: RouteLeg }).leg),
    [legs],
  );
  const complete = legs.length > 0 && routedLegs.length === legs.length;

  const routed = useMemo(
    () => (complete ? concatenateLegs(routedLegs) : undefined),
    [complete, routedLegs],
  );

  useEffect(() => {
    if (routed === undefined) {
      setPreview(undefined);
      return;
    }

    // Debounced: the preview costs an elevation request, and recomputing it on
    // every intermediate drag position would burn the daily budget in minutes.
    let cancelled = false;
    setPreviewing(true);
    const timer = setTimeout(() => {
      void (async () => {
        const result = await buildPreview(routed.polyline, snapshot.mode, elevation);
        if (cancelled) return;
        setPreview(result.ok ? result.value : undefined);
        setPreviewing(false);
      })();
    }, previewDebounceMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      setPreviewing(false);
    };
  }, [routed, snapshot.mode, elevation, previewDebounceMs]);

  // --- saving --------------------------------------------------------------

  /**
   * Bake the track for real: re-route every leg asking for full surface detail,
   * then sample the DEM at every node.
   *
   * This is the only place the expensive path runs. Editing uses geometry-only
   * routes and a coarse elevation profile; a saved track gets the real thing.
   */
  const bake = useCallback(
    async (id: string): Promise<{ track?: Track; error?: TrackError }> => {
      if (snapshot.waypoints.length < 2) {
        return {
          error: { kind: 'too-few-waypoints', message: 'A track needs at least two waypoints.' },
        };
      }

      setSaving(true);
      setSaveError(undefined);
      try {
        const detailed: RouteLeg[] = [];
        for (const pair of legPairs) {
          const result = await routing.routeLeg({
            from: pair.from,
            to: pair.to,
            profile: snapshot.routingProfile,
            detail: 'full',
          });
          if (!result.ok) {
            const error: TrackError = {
              kind: 'leg-failed',
              message: result.error.message,
              legIndex: pair.fromIndex,
              ...(result.error.at ? { at: result.error.at } : {}),
              cause: result.error,
            };
            setSaveError(error);
            return { error };
          }
          detailed.push(result.value);
        }

        const baked = await bakeRoutedTrack({
          id,
          name: snapshot.name.trim() === '' ? 'Untitled track' : snapshot.name.trim(),
          mode: snapshot.mode,
          routingProfile: snapshot.routingProfile,
          waypoints: snapshot.waypoints,
          routed: concatenateLegs(detailed),
          elevation,
        });

        if (!baked.ok) {
          setSaveError(baked.error);
          return { error: baked.error };
        }
        // Whether a provider was degraded is the caller's to record: it knows
        // which services it wired up and which of them fell back.
        return { track: baked.value };
      } finally {
        setSaving(false);
      }
    },
    [legPairs, snapshot, routing, elevation],
  );

  const failedLegs = useMemo(
    () => legs.filter((leg) => leg.status.state === 'failed'),
    [legs],
  );

  return {
    ...snapshot,
    legs,
    failedLegs,
    /** Concatenated geometry for drawing, or undefined while legs are pending. */
    routed,
    preview,
    previewing,
    complete,
    saving,
    saveError,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    actions: {
      addWaypoint,
      moveWaypoint,
      removeWaypoint,
      setMode,
      setRoutingProfile,
      setName,
      clear,
      undo,
      redo,
      bake,
    },
  };
};

type LegPair = Pick<BuilderLeg, 'fromIndex' | 'toIndex' | 'from' | 'to'>;

const buildLegPairs = (waypoints: readonly LatLng[], mode: TrackMode): LegPair[] => {
  const pairs: LegPair[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    pairs.push({
      fromIndex: i - 1,
      toIndex: i,
      from: waypoints[i - 1] as LatLng,
      to: waypoints[i] as LatLng,
    });
  }
  // The closing leg is where one-way networks bite: three sides of a block can
  // route perfectly and the fourth be impossible in that direction.
  if (mode === 'circuit' && waypoints.length > 2) {
    pairs.push({
      fromIndex: waypoints.length - 1,
      toIndex: 0,
      from: waypoints[waypoints.length - 1] as LatLng,
      to: waypoints[0] as LatLng,
    });
  }
  return pairs;
};

const toStatus = (cached: RouteLeg | RoutingError | undefined): LegStatus => {
  if (cached === undefined) return { state: 'routing' };
  return 'polyline' in cached ? { state: 'ok', leg: cached } : { state: 'failed', error: cached };
};

/**
 * Coordinates are rounded to roughly 10cm before keying. Without it, a drag
 * that ends a nanometre from where it started counts as a different leg and
 * costs a network call.
 */
const cacheKey = (from: LatLng, to: LatLng, profile: RoutingProfile): string =>
  `${profile}|${from.lat.toFixed(6)},${from.lng.toFixed(6)}|${to.lat.toFixed(6)},${to.lng.toFixed(6)}`;
