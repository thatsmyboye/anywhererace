import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LatLng, Track, WeatherSpec } from '@anywhererace/core';
import { DRY_STILL_CONDITIONS, centroidOf, hasBasemapKey, kphToMs } from '@anywhererace/core';
import type { RaceConfig } from '@anywhererace/sim';
import { getVehicleClass, isRetirement } from '@anywhererace/sim';
import type { RaceResult, VehicleClass } from '@anywhererace/sim';
import type { Championship } from '@anywhererace/championship';
import { configForLeg, legResultFromRaceResult } from '@anywhererace/championship';
import {
  SHARE_SCHEMA_VERSION,
  createTrackStore,
  encodeSharedRace,
  isPayloadUrlSafe,
} from '@anywhererace/store';
import type {
  ChampionshipSummary,
  RosterPresetSummary,
  SharedRace,
  StoredRaceSummary,
  TrackSummary,
} from '@anywhererace/store';
import {
  ChampionshipSetup,
  ChampionshipView,
  RaceSetup,
  RaceView,
  TrackBuilder,
  TrackList,
  UnitToggle,
  useUnits,
} from '@anywhererace/ui';
import type { AddLegInput } from '@anywhererace/ui';
import { createProviders, describeDegraded } from './providers';
import type { DegradedState } from './providers';
import { buildShareUrl, clearShareParam, readSharedRaceFromLocation } from './shareLink';

/**
 * The app shell.
 *
 * A three-way view switch rather than a router: there are three screens, no
 * deep links yet, and pulling in a routing library to manage that would be
 * more machinery than the problem deserves. When shared race links arrive —
 * which do need real URLs — this becomes a router, and that is the right time.
 */

type View =
  | { name: 'list' }
  | { name: 'builder' }
  | { name: 'setup'; track: Track }
  | { name: 'championshipSetup' }
  | { name: 'championship'; championship: Championship }
  | {
      name: 'race';
      track: Track;
      config: RaceConfig;
      /**
       * Set when replaying a saved race or opening a shared one, so the replay
       * can be checked against the hash it was created with.
       */
      savedAs?: { resultHash: string; simVersion: string };
      /** True when this race arrived by link — a read-only copy to watch or fork. */
      shared?: boolean;
      /**
       * Set when this race is a championship leg, so a finish can be recorded
       * back into the championship's standings and return there afterwards.
       */
      leg?: { championship: Championship; legIndex: number };
    };

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;

export const App = () => {
  const units = useUnits();
  const [degraded, setDegraded] = useState<DegradedState>({ routing: false, elevation: false, weather: false });
  const providers = useMemo(
    () => createProviders({ maptilerKey: MAPTILER_KEY, onDegradedChange: setDegraded }),
    [],
  );
  const store = useMemo(() => createTrackStore(), []);

  // A shared race, if the app was opened from a link. Read once, synchronously,
  // so the shared race is the first thing on screen rather than a flash of the
  // track list. The link is then wiped from the address bar (see below).
  const opened = useMemo(() => readSharedRaceFromLocation(), []);
  const [sharedError, setSharedError] = useState(
    opened.status === 'error' ? opened.error : undefined,
  );

  const [view, setView] = useState<View>(
    opened.status === 'ok'
      ? {
          name: 'race',
          track: opened.race.track,
          config: opened.race.config,
          savedAs: { resultHash: opened.race.resultHash, simVersion: opened.race.simVersion },
          shared: true,
        }
      : { name: 'list' },
  );

  useEffect(() => {
    // Take the link into memory once, then clear it: a refresh should reopen the
    // app, and a user's own later races should not carry a stranger's payload.
    if (opened.status !== 'none') clearShareParam();
  }, [opened.status]);
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [presets, setPresets] = useState<RosterPresetSummary[]>([]);
  const [races, setRaces] = useState<StoredRaceSummary[]>([]);
  const [championships, setChampionships] = useState<ChampionshipSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [storeError, setStoreError] = useState<string | undefined>(undefined);
  // Set while off building a new track for a championship, so a save returns to
  // that championship rather than the list.
  const [returnToChampionshipId, setReturnToChampionshipId] = useState<string | undefined>(undefined);
  // True while a leg is being added — baking its weather is a network round-trip.
  const [addingLeg, setAddingLeg] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [result, presetResult, raceResult, championshipResult] = await Promise.all([
      store.list(),
      store.listRosterPresets(),
      store.listRaces(),
      store.listChampionships(),
    ]);
    if (result.ok) {
      setTracks(result.value);
      setStoreError(undefined);
    } else {
      setStoreError(result.error.message);
    }
    if (presetResult.ok) setPresets(presetResult.value);
    if (raceResult.ok) setRaces(raceResult.value);
    if (championshipResult.ok) setChampionships(championshipResult.value);
    setLoading(false);
  }, [store]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openSetup = useCallback(
    async (id: string) => {
      const result = await store.get(id);
      if (!result.ok) {
        setStoreError(result.error.message);
        return;
      }
      setView({ name: 'setup', track: result.value.track });
    },
    [store],
  );

  // --- championships -------------------------------------------------------

  const openChampionship = useCallback(
    async (id: string) => {
      const result = await store.getChampionship(id);
      if (!result.ok) {
        setStoreError(result.error.message);
        return;
      }
      setView({ name: 'championship', championship: result.value });
    },
    [store],
  );

  const createChampionship = useCallback(
    async (championship: Championship) => {
      const saved = await store.saveChampionship({ championship });
      if (!saved.ok) {
        setStoreError(saved.error.message);
        return;
      }
      await refresh();
      setView({ name: 'championship', championship: saved.value });
    },
    [store, refresh],
  );

  const deleteChampionship = useCallback(
    async (id: string) => {
      await store.removeChampionship(id);
      await refresh();
    },
    [store, refresh],
  );

  /**
   * Persist a mutated championship and keep the open view in step with it.
   *
   * Every leg change — added, removed, reordered, raced — routes through here,
   * so the standings on screen and the standings on disk are never allowed to
   * diverge.
   */
  const persistChampionship = useCallback(
    async (championship: Championship): Promise<Championship | undefined> => {
      const saved = await store.saveChampionship({ championship });
      if (!saved.ok) {
        setStoreError(saved.error.message);
        return undefined;
      }
      await refresh();
      setView((current) =>
        current.name === 'championship' && current.championship.id === saved.value.id
          ? { name: 'championship', championship: saved.value }
          : current,
      );
      return saved.value;
    },
    [store, refresh],
  );

  /**
   * Add a leg to a championship: load the full track, bake its weather now, and
   * append it. Weather is baked at add time and never re-fetched, exactly as a
   * standalone race bakes it, so the championship replays identically later.
   */
  const addLeg = useCallback(
    async (championship: Championship, input: AddLegInput) => {
      setAddingLeg(true);
      const trackResult = await store.get(input.trackId);
      if (!trackResult.ok) {
        setStoreError(trackResult.error.message);
        setAddingLeg(false);
        return;
      }
      const track = trackResult.value.track;
      const vehicle = getVehicleClass(input.vehicleClassId);
      const weather = await bakeLegWeather(track, vehicle, input.laps, providers.weather);

      const leg = {
        id: `leg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        trackId: track.id,
        trackName: track.name,
        trackMode: track.mode,
        startPoint: endpointOf(track, 'start'),
        finishPoint: endpointOf(track, 'finish'),
        vehicleClassId: input.vehicleClassId,
        laps: input.laps,
        weather,
        seed: Math.random().toString(36).slice(2, 10),
      };
      await persistChampionship({ ...championship, legs: [...championship.legs, leg] });
      setAddingLeg(false);
    },
    [store, providers, persistChampionship],
  );

  const removeLeg = useCallback(
    (championship: Championship, legId: string) =>
      void persistChampionship({
        ...championship,
        legs: championship.legs.filter((leg) => leg.id !== legId),
      }),
    [persistChampionship],
  );

  const reorderLeg = useCallback(
    (championship: Championship, legId: string, direction: -1 | 1) => {
      const index = championship.legs.findIndex((leg) => leg.id === legId);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= championship.legs.length) return;
      const legs = [...championship.legs];
      const moved = legs[index];
      const swap = legs[target];
      if (moved === undefined || swap === undefined) return;
      legs[index] = swap;
      legs[target] = moved;
      void persistChampionship({ ...championship, legs });
    },
    [persistChampionship],
  );

  /** Run one leg: reuse the race view, tagged so its finish is recorded back. */
  const raceLeg = useCallback(
    async (championship: Championship, legIndex: number) => {
      const leg = championship.legs[legIndex];
      if (leg === undefined) return;
      const trackResult = await store.get(leg.trackId);
      if (!trackResult.ok) {
        setStoreError(
          'The track this leg was built on has been deleted, so it cannot be raced.',
        );
        return;
      }
      setView({
        name: 'race',
        track: trackResult.value.track,
        config: configForLeg(championship, leg),
        leg: { championship, legIndex },
      });
    },
    [store],
  );

  /** Fold a finished leg's result into the championship and return to it. */
  const recordLegResult = useCallback(
    async (championship: Championship, legIndex: number, result: RaceResult): Promise<boolean> => {
      const legResult = legResultFromRaceResult(result, new Date().toISOString());
      const legs = championship.legs.map((leg, index) =>
        index === legIndex ? { ...leg, result: legResult } : leg,
      );
      const saved = await persistChampionship({ ...championship, legs });
      return saved !== undefined;
    },
    [persistChampionship],
  );

  const buildTrackForChampionship = useCallback((championshipId: string) => {
    setReturnToChampionshipId(championshipId);
    setView({ name: 'builder' });
  }, []);

  const saveRosterPreset = useCallback(
    async (name: string, racers: { name: string; color: string; personality: string; skill: number }[]) => {
      const id = `roster-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const result = await store.saveRosterPreset({ id, name, racers });
      if (!result.ok) {
        setStoreError(result.error.message);
        return;
      }
      await refresh();
    },
    [store, refresh],
  );

  const loadRosterPreset = useCallback(
    async (id: string) => {
      const result = await store.getRosterPreset(id);
      return result.ok ? result.value.racers : undefined;
    },
    [store],
  );

  const deleteRosterPreset = useCallback(
    async (id: string) => {
      await store.removeRosterPreset(id);
      await refresh();
    },
    [store, refresh],
  );

  const saveTrack = useCallback(
    async (track: Track) => {
      const result = await store.save({
        track,
        builtWith: {
          routing: providers.routing.id,
          elevation: providers.elevation.id,
          // Read the live snapshot rather than the rendered state: a service
          // can fall back *during* the bake, which is exactly when it matters.
          degraded: providers.degraded(),
        },
      });
      if (!result.ok) {
        setStoreError(result.error.message);
        return;
      }
      await refresh();
      // If this track was built for a championship, go back to it rather than
      // to the list — the new track is now available to add as a leg.
      if (returnToChampionshipId !== undefined) {
        const target = returnToChampionshipId;
        setReturnToChampionshipId(undefined);
        await openChampionship(target);
        return;
      }
      setView({ name: 'list' });
    },
    [store, providers, refresh, returnToChampionshipId, openChampionship],
  );

  /**
   * Save a finished race as its *inputs*.
   *
   * The sim is deterministic, so the seed and config are the race; storing the
   * finishing order too would duplicate something already determined and would
   * rot the moment the physics changed. The hash and sim version are kept so a
   * replay can be checked against what it was saved with.
   */
  const saveRace = useCallback(
    async (track: Track, config: RaceConfig, result: RaceResult) => {
      const winner = result.finishers[0];
      const runnerUp = result.finishers[1];
      const vehicle = getVehicleClass(config.vehicleClassId);

      const saved = await store.saveRace({
        id: `race-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        trackId: track.id,
        createdAt: new Date().toISOString(),
        config,
        simVersion: result.simVersion,
        resultHash: result.resultHash,
        summary: {
          trackName: track.name,
          vehicleLabel: vehicle?.label ?? config.vehicleClassId,
          laps: config.laps,
          fieldSize: config.racers.length,
          winnerName:
            config.racers.find((racer) => racer.id === winner?.racerId)?.name ?? 'Nobody',
          ...(runnerUp?.gapToWinnerS === undefined ? {} : { marginS: runnerUp.gapToWinnerS }),
          retirements: result.finishers.filter((f) => isRetirement(f.status)).length,
        },
      });
      if (!saved.ok) setStoreError(saved.error.message);
      return saved.ok;
    },
    [store],
  );

  /**
   * Reopen a saved race by re-running it. The stored hash is handed to the race
   * view so a replay that no longer matches can say so.
   */
  const replayRace = useCallback(
    async (raceId: string) => {
      const race = await store.getRace(raceId);
      if (!race.ok) {
        setStoreError(race.error.message);
        return;
      }
      const track = await store.get(race.value.trackId);
      if (!track.ok) {
        setStoreError(
          'The track this race was run on has been deleted, so it cannot be replayed.',
        );
        return;
      }
      setView({
        name: 'race',
        track: track.value.track,
        config: race.value.config,
        savedAs: { resultHash: race.value.resultHash, simVersion: race.value.simVersion },
      });
    },
    [store],
  );

  const deleteRace = useCallback(
    async (raceId: string) => {
      await store.removeRace(raceId);
      await refresh();
    },
    [store, refresh],
  );

  const deleteTrack = useCallback(
    async (id: string) => {
      await store.remove(id);
      await refresh();
    },
    [store, refresh],
  );

  /**
   * Build a shareable link for a finished race, or report that it is too big.
   *
   * A link carries the race's *inputs* — the baked track above all — so a large
   * course produces a payload past what a URL can safely hold. Rather than mint
   * a link that silently breaks in someone's chat client, the caller is told,
   * and the Supabase-backed short link stays the documented path for those.
   */
  const buildRaceLink = useCallback(
    (track: Track, config: RaceConfig, result: RaceResult): string | undefined => {
      const shared: SharedRace = {
        schemaVersion: SHARE_SCHEMA_VERSION,
        simVersion: result.simVersion,
        track,
        config,
        resultHash: result.resultHash,
      };
      const payload = encodeSharedRace(shared);
      return isPayloadUrlSafe(payload) ? buildShareUrl(payload) : undefined;
    },
    [],
  );

  /**
   * Keep a shared race. The embedded track has to be saved too — the recipient
   * has no store, so saving the race alone would leave a `trackId` pointing at
   * nothing and a replay that cannot find its road.
   */
  const saveSharedRace = useCallback(
    async (track: Track, config: RaceConfig, result: RaceResult): Promise<boolean> => {
      const savedTrack = await store.save({
        track,
        builtWith: {
          // Honest provenance: this track came from a link, not from a bake on
          // this machine, and its degraded flags travelled with it if at all.
          routing: 'shared-link',
          elevation: 'shared-link',
          degraded: { routing: false, elevation: false },
        },
      });
      if (!savedTrack.ok) {
        setStoreError(savedTrack.error.message);
        return false;
      }
      const ok = await saveRace(track, config, result);
      if (ok) await refresh();
      return ok;
    },
    [store, saveRace, refresh],
  );

  const styleUrl = useMemo(() => providers.tiles.styleUrl(), [providers]);

  if (sharedError !== undefined) {
    return (
      <SharedRaceError
        message={sharedError.message}
        onDismiss={() => {
          setSharedError(undefined);
          setView({ name: 'list' });
        }}
      />
    );
  }

  if (view.name === 'builder') {
    return (
      <div className="h-dvh w-screen overflow-hidden">
        <TrackBuilder
          routing={providers.routing}
          elevation={providers.elevation}
          geocoding={providers.geocoding}
          styleUrl={styleUrl}
          attribution={providers.tiles.attribution}
          onSave={saveTrack}
          onCancel={() => {
            const target = returnToChampionshipId;
            setReturnToChampionshipId(undefined);
            if (target !== undefined) void openChampionship(target);
            else setView({ name: 'list' });
          }}
          degradedNotice={describeDegraded(degraded, hasBasemapKey(MAPTILER_KEY))}
        />
      </div>
    );
  }

  if (view.name === 'setup') {
    return (
      <div className="h-dvh w-screen overflow-hidden">
        <RaceSetup
          track={view.track}
          weather={providers.weather}
          presets={presets}
          onBack={() => setView({ name: 'list' })}
          onStart={(config) => setView({ name: 'race', track: view.track, config })}
          onSavePreset={saveRosterPreset}
          onLoadPreset={loadRosterPreset}
          onDeletePreset={deleteRosterPreset}
        />
      </div>
    );
  }

  if (view.name === 'championshipSetup') {
    return (
      <div className="h-dvh w-screen overflow-hidden bg-[#0b0e13]">
        <ChampionshipSetup
          onCreate={(championship) => void createChampionship(championship)}
          onCancel={() => setView({ name: 'list' })}
        />
      </div>
    );
  }

  if (view.name === 'championship') {
    const champ = view.championship;
    return (
      <div className="h-dvh w-screen overflow-hidden bg-[#0b0e13]">
        <ChampionshipView
          championship={champ}
          tracks={tracks}
          busy={addingLeg}
          error={storeError}
          onAddLeg={(input) => void addLeg(champ, input)}
          onRemoveLeg={(legId) => removeLeg(champ, legId)}
          onReorderLeg={(legId, direction) => reorderLeg(champ, legId, direction)}
          onRaceLeg={(legIndex) => void raceLeg(champ, legIndex)}
          onBuildTrack={() => buildTrackForChampionship(champ.id)}
          onBack={() => setView({ name: 'list' })}
          onDelete={() => {
            void deleteChampionship(champ.id);
            setView({ name: 'list' });
          }}
        />
      </div>
    );
  }

  if (view.name === 'race') {
    const race = view;
    const vehicle = getVehicleClass(race.config.vehicleClassId);
    return (
      <div className="h-dvh w-screen overflow-hidden bg-[#0b0e13]">
        <RaceView
          track={race.track}
          config={race.config}
          createWorker={createSimWorker}
          styleUrl={styleUrl}
          attribution={providers.tiles.attribution}
          trackName={race.track.name}
          savedAs={race.savedAs}
          resultActions={(result) =>
            race.leg !== undefined ? (
              <div className="flex items-center gap-2">
                <ShareRaceButton buildUrl={() => buildRaceLink(race.track, race.config, result)} />
                <RecordLegButton
                  alreadyRaced={race.leg.championship.legs[race.leg.legIndex]?.result !== undefined}
                  onRecord={async () => {
                    const leg = race.leg;
                    if (leg === undefined) return;
                    const ok = await recordLegResult(leg.championship, leg.legIndex, result);
                    if (ok) await openChampionship(leg.championship.id);
                  }}
                />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <ShareRaceButton buildUrl={() => buildRaceLink(race.track, race.config, result)} />
                {race.shared ? (
                  <SaveRaceButton
                    label="Save to my races"
                    onSave={() => saveSharedRace(race.track, race.config, result)}
                  />
                ) : (
                  <SaveRaceButton onSave={() => saveRace(race.track, race.config, result)} />
                )}
              </div>
            )
          }
          header={
            <header className="rounded-lg border border-[#2b3543] bg-[#161b24]/90 px-3 py-2 backdrop-blur">
              <div className="flex items-baseline justify-between gap-3">
                <h1 className="min-w-0 truncate text-sm font-semibold text-[#e6ebf2]">
                  {race.track.name}
                </h1>
                <span className="flex items-center gap-2">
                  <UnitToggle className="self-center" />
                  <button
                    type="button"
                    onClick={() => {
                      const leg = race.leg;
                      if (leg !== undefined) void openChampionship(leg.championship.id);
                      else setView({ name: 'setup', track: race.track });
                    }}
                    className="text-xs text-[#8d9bb0] underline-offset-2 hover:text-[#e6ebf2] hover:underline"
                  >
                    {race.leg !== undefined ? 'Back to championship' : race.shared ? 'Fork' : 'Settings'}
                  </button>
                </span>
              </div>
              <p className="text-xs text-[#8d9bb0]">
                {race.leg !== undefined ? (
                  <span className="text-[#4da3ff]">
                    {race.leg.championship.name} · leg {race.leg.legIndex + 1} ·{' '}
                  </span>
                ) : race.shared ? (
                  <span className="text-[#3ddc97]">Shared race · </span>
                ) : null}
                {units.distance(race.track.lengthMeters)} · {race.config.laps} laps ·{' '}
                {vehicle?.label ?? race.config.vehicleClassId}
              </p>
            </header>
          }
        />
      </div>
    );
  }

  return (
    <div className="h-dvh w-screen overflow-hidden bg-[#0b0e13]">
      <TrackList
        tracks={tracks}
        races={races}
        championships={championships}
        loading={loading}
        error={storeError}
        onCreate={() => setView({ name: 'builder' })}
        onRace={(id) => void openSetup(id)}
        onDelete={(id) => void deleteTrack(id)}
        onReplay={(id) => void replayRace(id)}
        onDeleteRace={(id) => void deleteRace(id)}
        onCreateChampionship={() => setView({ name: 'championshipSetup' })}
        onOpenChampionship={(id) => void openChampionship(id)}
        onDeleteChampionship={(id) => void deleteChampionship(id)}
      />
    </div>
  );
};

/**
 * Saving is explicit rather than automatic. Most races are watched once and
 * forgotten, and silently filling a user's storage with every race they
 * happened to run is not a favour.
 */
const SaveRaceButton = ({
  onSave,
  label = 'Save race',
}: {
  onSave: () => Promise<boolean>;
  label?: string;
}) => {
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');

  return (
    <button
      type="button"
      disabled={state !== 'idle'}
      onClick={() => {
        setState('saving');
        void onSave().then((ok) => setState(ok ? 'saved' : 'idle'));
      }}
      className="rounded border border-[#2b3543] bg-[#1f2632] px-3 py-1.5 text-sm text-[#e6ebf2] transition-colors hover:bg-[#2b3543] disabled:opacity-60"
    >
      {state === 'saved' ? 'Saved' : state === 'saving' ? 'Saving…' : label}
    </button>
  );
};

/**
 * Record a championship leg's result into the standings.
 *
 * A leg raced for the first time reads "Record result"; re-racing one that was
 * already scored reads "Update result", because recording overwrites the stored
 * finish — the seed is fixed, so a re-race is the same race, but a re-race under
 * a changed sim is exactly how a user brings a stale leg's standings current.
 */
const RecordLegButton = ({
  alreadyRaced,
  onRecord,
}: {
  alreadyRaced: boolean;
  onRecord: () => Promise<void>;
}) => {
  const [state, setState] = useState<'idle' | 'saving'>('idle');
  return (
    <button
      type="button"
      disabled={state !== 'idle'}
      onClick={() => {
        setState('saving');
        void onRecord().finally(() => setState('idle'));
      }}
      className="rounded bg-[#4da3ff] px-3 py-1.5 text-sm font-semibold text-[#0b0e13] transition-colors hover:bg-[#6fb5ff] disabled:opacity-60"
    >
      {state === 'saving'
        ? 'Recording…'
        : alreadyRaced
          ? 'Update result & continue'
          : 'Record result & continue'}
    </button>
  );
};

/**
 * Share a finished race as a link.
 *
 * The link is the race's inputs, not a recording, so copying it is the whole
 * interaction: the recipient's own build re-runs it. A course too big to fit a
 * URL says so plainly rather than copying a link that would break in transit.
 */
const ShareRaceButton = ({ buildUrl }: { buildUrl: () => string | undefined }) => {
  const [state, setState] = useState<'idle' | 'copied' | 'too-big' | 'failed'>('idle');

  const onClick = () => {
    const url = buildUrl();
    if (url === undefined) {
      setState('too-big');
      return;
    }
    void navigator.clipboard
      .writeText(url)
      .then(() => setState('copied'))
      .catch(() => setState('failed'));
  };

  const label =
    state === 'copied'
      ? 'Link copied'
      : state === 'too-big'
        ? 'Too big for a link'
        : state === 'failed'
          ? 'Copy failed'
          : 'Share';

  return (
    <button
      type="button"
      onClick={onClick}
      title={
        state === 'too-big'
          ? 'This track is too large to fit in a URL. A short-link fallback is not wired up yet.'
          : undefined
      }
      className="rounded border border-[#3ddc97]/40 bg-[#3ddc97]/10 px-3 py-1.5 text-sm text-[#3ddc97] transition-colors hover:bg-[#3ddc97]/20"
    >
      {label}
    </button>
  );
};

/** Shown when a link cannot be opened — corrupt, truncated, or from a newer build. */
const SharedRaceError = ({ message, onDismiss }: { message: string; onDismiss: () => void }) => (
  <div className="flex h-dvh w-screen items-center justify-center bg-[#0b0e13] p-8">
    <div className="max-w-md rounded-lg border border-[#ffb020]/40 bg-[#161b24] p-6">
      <h2 className="mb-2 text-lg font-semibold text-[#ffb020]">This shared race could not be opened</h2>
      <p className="mb-4 text-sm text-[#8d9bb0]">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded border border-[#2b3543] bg-[#1f2632] px-3 py-1.5 text-sm text-[#e6ebf2] transition-colors hover:bg-[#2b3543]"
      >
        Go to AnywhereRace
      </button>
    </div>
  </div>
);

/** A track's start or finish point, for a tour's continuity check. */
const endpointOf = (track: Track, which: 'start' | 'finish'): LatLng => {
  const points = track.nodes.length > 0 ? track.nodes : track.polyline;
  const point = which === 'start' ? points[0] : points[points.length - 1];
  return point === undefined ? { lat: 0, lng: 0 } : { lat: point.lat, lng: point.lng };
};

/**
 * How long a fraction of the field's forecast to fetch. Generous by design: the
 * same crude estimate race setup uses, so a leg's weather covers its whole run.
 */
const DURATION_SAFETY_FACTOR = 1.6;

const estimateLegDurationS = (track: Track, laps: number, vehicle: VehicleClass | undefined): number => {
  if (vehicle === undefined) return 0;
  const distanceM = track.mode === 'circuit' ? track.lengthMeters * laps : track.lengthMeters;
  const assumedSpeedMs = kphToMs(vehicle.topSpeedKph) * 0.7;
  return assumedSpeedMs <= 0 ? 0 : distanceM / assumedSpeedMs;
};

/**
 * Bake a leg's weather at add time, and never re-fetch it.
 *
 * The live forecast for the track's centroid is fetched once and frozen onto
 * the leg, exactly as a standalone race bakes it, so the championship replays
 * identically later. If the forecast is unavailable the leg falls back to a
 * dry, still day — a legitimate, deterministic `WeatherSpec`, not a lookup —
 * rather than failing to add.
 */
const bakeLegWeather = async (
  track: Track,
  vehicle: VehicleClass | undefined,
  laps: number,
  weather: ReturnType<typeof createProviders>['weather'],
): Promise<WeatherSpec> => {
  const durationS = estimateLegDurationS(track, laps, vehicle);
  const fallback: WeatherSpec = { kind: 'manual', conditions: DRY_STILL_CONDITIONS };
  if (durationS <= 0) return fallback;

  const fetchedAt = new Date().toISOString();
  const at = centroidOf(track.nodes.length > 0 ? track.nodes : track.polyline);
  const result = await weather.forecast({
    at,
    startsAt: fetchedAt,
    durationS: durationS * DURATION_SAFETY_FACTOR,
  });
  if (!result.ok) return fallback;
  return {
    kind: 'live',
    fetchedAt,
    startsAt: fetchedAt,
    timeline: result.value,
    latitude: at.lat,
    longitude: at.lng,
  };
};

/**
 * Vite needs to see `new Worker(new URL(...))` literally in order to bundle the
 * worker — the URL cannot be built from a variable.
 */
const createSimWorker = (): Worker =>
  new Worker(new URL('@anywhererace/worker/worker', import.meta.url), { type: 'module' });
