import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ISOTimestamp, Track, WeatherConditions, WeatherProvider, WeatherSpec } from '@anywhererace/core';
import { DRY_STILL_CONDITIONS, MAX_FIELD_SIZE, MIN_FIELD_SIZE, centroidOf, createRng, kphToMs } from '@anywhererace/core';
import type { GridOrder, RaceConfig, RacerSpec, VehicleClass } from '@anywhererace/sim';
import { ARCHETYPES, VEHICLE_CLASSES } from '@anywhererace/sim';
import { vehiclesForProfile } from '@anywhererace/track';
import { buildPalette } from './palette';
import { generateRacerNames } from './racerNames';

/**
 * Race setup state.
 *
 * The settings interact, which is why they live together rather than in
 * separate little widgets: the track's routing profile decides which vehicle
 * classes are legal, the vehicle and lap count decide how long the race runs
 * and therefore how much forecast to fetch, and the field size drives the
 * roster. Changing one has to be able to correct the others.
 */

export type WeatherMode = 'forecast' | 'manual';

export type RosterEntry = {
  /** Stable across edits so React keys and the palette do not shuffle. */
  id: string;
  name: string;
  personality: string;
  /** 0-1. */
  skill: number;
};

export type UseRaceSetupOptions = {
  track: Track;
  weather: WeatherProvider;
  /** Injected so tests are not at the mercy of the clock. */
  now?: () => Date;
};

const DEFAULT_FIELD_SIZE = 12;
const MIN_FIELD = MIN_FIELD_SIZE;
const MAX_FIELD = MAX_FIELD_SIZE;
const DEFAULT_LAPS = 5;

/**
 * Rough race duration, used only to decide how many hours of forecast to fetch.
 * Deliberately generous: over-fetching costs one request, while under-fetching
 * means the last laps of a long race run on extrapolated weather.
 */
const DURATION_SAFETY_FACTOR = 1.6;

export const useRaceSetup = (options: UseRaceSetupOptions) => {
  const { track, weather, now = () => new Date() } = options;

  /**
   * The clock, held in a ref so it can never reach a dependency array.
   *
   * `now` defaults to a fresh arrow function, so its identity changes on every
   * render. As a plain dependency of `refreshForecast` that made
   * `refreshForecast` change every render, which made the effect that calls it
   * fire every render, which called `setState`, which caused another render —
   * an unbounded refetch loop.
   *
   * It was not a quiet one. It hammered Open-Meteo until the service
   * rate-limited us and the provider fell back to dry-and-still, so the visible
   * symptom was a real forecast appearing and then being silently replaced by
   * invented weather a second later, with "Fetching..." stuck on for good. A
   * user about to start a race would race whatever the loop had last written.
   */
  const nowRef = useRef(now);
  nowRef.current = now;

  const allowedVehicles = useMemo(() => vehiclesForProfile(track.routingProfile), [track.routingProfile]);
  const blockedVehicles = useMemo(
    () => VEHICLE_CLASSES.filter((vehicle) => !allowedVehicles.some((v) => v.id === vehicle.id)),
    [allowedVehicles],
  );

  const [vehicleClassId, setVehicleClassId] = useState<string>(
    () => allowedVehicles[allowedVehicles.length - 1]?.id ?? VEHICLE_CLASSES[0]?.id ?? 'runner',
  );
  const [laps, setLaps] = useState(DEFAULT_LAPS);
  const [gridOrder, setGridOrder] = useState<GridOrder>('reverse-skill');
  const [seed, setSeed] = useState(() => randomSeed());

  const [weatherMode, setWeatherMode] = useState<WeatherMode>('forecast');
  const [manualConditions, setManualConditions] = useState<WeatherConditions>(DRY_STILL_CONDITIONS);
  const [startsAt, setStartsAt] = useState<ISOTimestamp | undefined>(undefined);
  const [forecast, setForecast] = useState<WeatherSpec | undefined>(undefined);
  const [forecastError, setForecastError] = useState<string | undefined>(undefined);
  const [fetchingForecast, setFetchingForecast] = useState(false);

  const [roster, setRoster] = useState<RosterEntry[]>(() => makeRoster(DEFAULT_FIELD_SIZE, randomSeed()));

  // Switching to a profile that forbids the chosen class has to correct itself,
  // or the user is left holding an illegal selection with no way to see it.
  useEffect(() => {
    if (allowedVehicles.some((vehicle) => vehicle.id === vehicleClassId)) return;
    const replacement = allowedVehicles[allowedVehicles.length - 1]?.id;
    if (replacement !== undefined) setVehicleClassId(replacement);
  }, [allowedVehicles, vehicleClassId]);

  const vehicle = useMemo(
    () => VEHICLE_CLASSES.find((candidate) => candidate.id === vehicleClassId),
    [vehicleClassId],
  );

  const raceDistanceM = track.mode === 'circuit' ? track.lengthMeters * laps : track.lengthMeters;
  const estimatedDurationS = useMemo(
    () => (vehicle === undefined ? 0 : estimateDuration(raceDistanceM, vehicle)),
    [raceDistanceM, vehicle],
  );

  // --- roster --------------------------------------------------------------

  const setFieldSize = useCallback((size: number) => {
    const clamped = Math.min(MAX_FIELD, Math.max(MIN_FIELD, Math.round(size)));
    setRoster((current) => {
      if (clamped === current.length) return current;
      if (clamped < current.length) return current.slice(0, clamped);
      // Growing keeps everyone already there — a user who has hand-tuned ten
      // racers should not lose them by asking for twelve.
      const extra = makeRoster(clamped - current.length, randomSeed(), current.length);
      return [...current, ...extra];
    });
  }, []);

  const updateRacer = useCallback((id: string, patch: Partial<Omit<RosterEntry, 'id'>>) => {
    setRoster((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    );
  }, []);

  const randomizeField = useCallback(() => {
    setRoster((current) => makeRoster(current.length, randomSeed()));
  }, []);

  const loadRoster = useCallback(
    (rows: readonly { name: string; personality: string; skill: number }[]) => {
      if (rows.length === 0) return;
      setRoster(
        rows.slice(0, MAX_FIELD).map((row, index) => ({
          id: `r${String(index + 1).padStart(2, '0')}`,
          name: row.name,
          personality: row.personality,
          skill: row.skill,
        })),
      );
    },
    [],
  );

  // Colours are assigned from the OkLCH palette by position rather than stored
  // per racer, which is what guarantees that no two racers in a field are hard
  // to tell apart. See `palette.ts`.
  const palette = useMemo(() => buildPalette(roster.length), [roster.length]);

  // --- weather -------------------------------------------------------------

  /**
   * Which fetch is the current one.
   *
   * Changing laps or vehicle changes how much forecast to ask for, so a user
   * typing a lap count legitimately starts several requests in a second. Without
   * a sequence number the slowest of them wins whenever it happens to land last,
   * and the race is set up against a forecast for a duration the user has
   * already changed.
   */
  const forecastSeq = useRef(0);

  const refreshForecast = useCallback(async () => {
    if (estimatedDurationS <= 0) return;
    const seq = ++forecastSeq.current;
    const isStale = (): boolean => forecastSeq.current !== seq;

    setFetchingForecast(true);
    setForecastError(undefined);

    const fetchedAt = nowRef.current().toISOString();
    const at = centroidOf(track.nodes.length > 0 ? track.nodes : track.polyline);
    const start = startsAt ?? fetchedAt;

    const result = await weather.forecast({
      at,
      startsAt: start,
      durationS: estimatedDurationS * DURATION_SAFETY_FACTOR,
    });

    if (isStale()) return;

    if (!result.ok) {
      setForecast(undefined);
      setForecastError(result.error.message);
      setFetchingForecast(false);
      return;
    }

    // Baked here and never re-fetched. A race saved today has to replay
    // identically a year from now, which it can only do if the weather it ran
    // in was written down rather than looked up again.
    setForecast({
      kind: 'live',
      fetchedAt,
      startsAt: start,
      timeline: result.value,
      latitude: at.lat,
      longitude: at.lng,
    });
    setForecastError(undefined);
    setFetchingForecast(false);
  }, [weather, track, startsAt, estimatedDurationS]);

  useEffect(() => {
    if (weatherMode !== 'forecast') return;
    void refreshForecast();
  }, [weatherMode, refreshForecast]);

  const weatherSpec: WeatherSpec = useMemo(() => {
    if (weatherMode === 'manual' || forecast === undefined) {
      return { kind: 'manual', conditions: manualConditions };
    }
    return forecast;
  }, [weatherMode, forecast, manualConditions]);

  /** Conditions at the flag, for the summary line. */
  const conditionsAtStart: WeatherConditions =
    weatherSpec.kind === 'manual'
      ? weatherSpec.conditions
      : (weatherSpec.timeline.find((sample) => sample.atOffsetS >= 0)?.conditions ??
        weatherSpec.timeline[0]?.conditions ??
        DRY_STILL_CONDITIONS);

  // --- the config ----------------------------------------------------------

  const config: RaceConfig = useMemo(() => {
    const racers: RacerSpec[] = roster.map((entry, index) => ({
      id: entry.id,
      name: entry.name,
      color: palette[index]?.color ?? '#888888',
      personality: entry.personality,
      skill: entry.skill,
    }));

    return {
      trackId: track.id,
      laps: track.mode === 'circuit' ? laps : 1,
      vehicleClassId,
      weather: weatherSpec,
      fieldSize: racers.length,
      racers,
      seed,
      gridOrder,
    };
  }, [roster, palette, track.id, track.mode, laps, vehicleClassId, weatherSpec, seed, gridOrder]);

  return {
    vehicle,
    vehicleClassId,
    allowedVehicles,
    blockedVehicles,
    laps,
    gridOrder,
    seed,
    roster,
    palette,
    fieldSize: roster.length,
    weatherMode,
    manualConditions,
    startsAt,
    forecast,
    forecastError,
    fetchingForecast,
    conditionsAtStart,
    estimatedDurationS,
    raceDistanceM,
    config,
    isCircuit: track.mode === 'circuit',
    actions: {
      setVehicleClassId,
      setLaps: (value: number) => setLaps(Math.max(1, Math.round(value))),
      setGridOrder,
      setSeed,
      rerollSeed: () => setSeed(randomSeed()),
      setFieldSize,
      updateRacer,
      randomizeField,
      loadRoster,
      setWeatherMode,
      setManualConditions,
      setStartsAt,
      refreshForecast,
    },
  };
};

/**
 * A fresh field.
 *
 * Skills are spread evenly rather than drawn at random, because a randomly
 * generated field is very often one where four racers are within a percent of
 * each other and nothing decisive happens. Personalities are drawn from the
 * archetypes, so a field usually contains several recognisable characters.
 */
const makeRoster = (count: number, seed: string, startIndex = 0): RosterEntry[] => {
  const rng = createRng(seed);
  const names = generateRacerNames(count, rng.fork('names'));
  const skillRng = rng.fork('skills');

  return Array.from({ length: count }, (_, i) => {
    const spread = count === 1 ? 0.5 : i / (count - 1);
    return {
      id: `r${String(startIndex + i + 1).padStart(2, '0')}`,
      name: names[i] ?? `Racer ${startIndex + i + 1}`,
      personality: ARCHETYPES[skillRng.int(ARCHETYPES.length)]?.id ?? 'metronome',
      // 0.5 to 0.95: below about half, a racer is so far off the pace that they
      // are simply not in the race, which is not interesting to watch.
      skill: Number((0.5 + spread * 0.45).toFixed(2)),
    };
  });
};

const estimateDuration = (raceDistanceM: number, vehicle: VehicleClass): number => {
  // The same crude estimate the sim uses to scale mechanical failure: assume a
  // fraction of top speed to account for corners, junctions and traffic.
  const assumedSpeedMs = kphToMs(vehicle.topSpeedKph) * 0.7;
  return assumedSpeedMs <= 0 ? 0 : raceDistanceM / assumedSpeedMs;
};

/**
 * A short, readable seed.
 *
 * `Math.random` is fine here and only here: this picks the seed, it is not part
 * of the simulation. Once chosen, the seed is what makes everything downstream
 * reproducible — and the user can type their own over it.
 */
const randomSeed = (): string => Math.random().toString(36).slice(2, 10);
