import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Track } from '@anywhererace/core';
import { hasBasemapKey } from '@anywhererace/core';
import type { RaceConfig } from '@anywhererace/sim';
import { getVehicleClass, isRetirement } from '@anywhererace/sim';
import type { RaceResult } from '@anywhererace/sim';
import { createTrackStore } from '@anywhererace/store';
import type { RosterPresetSummary, StoredRaceSummary, TrackSummary } from '@anywhererace/store';
import { RaceSetup, RaceView, TrackBuilder, TrackList } from '@anywhererace/ui';
import { createProviders, describeDegraded } from './providers';
import type { DegradedState } from './providers';

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
  | {
      name: 'race';
      track: Track;
      config: RaceConfig;
      /** Set when replaying a saved race, so the replay can be checked. */
      savedAs?: { resultHash: string; simVersion: string };
    };

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;

export const App = () => {
  const [degraded, setDegraded] = useState<DegradedState>({ routing: false, elevation: false, weather: false });
  const providers = useMemo(
    () => createProviders({ maptilerKey: MAPTILER_KEY, onDegradedChange: setDegraded }),
    [],
  );
  const store = useMemo(() => createTrackStore(), []);

  const [view, setView] = useState<View>({ name: 'list' });
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [presets, setPresets] = useState<RosterPresetSummary[]>([]);
  const [races, setRaces] = useState<StoredRaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [storeError, setStoreError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [result, presetResult, raceResult] = await Promise.all([
      store.list(),
      store.listRosterPresets(),
      store.listRaces(),
    ]);
    if (result.ok) {
      setTracks(result.value);
      setStoreError(undefined);
    } else {
      setStoreError(result.error.message);
    }
    if (presetResult.ok) setPresets(presetResult.value);
    if (raceResult.ok) setRaces(raceResult.value);
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
      setView({ name: 'list' });
    },
    [store, providers, refresh],
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

  const styleUrl = useMemo(() => providers.tiles.styleUrl(), [providers]);

  if (view.name === 'builder') {
    return (
      <div className="h-dvh w-screen overflow-hidden">
        <TrackBuilder
          routing={providers.routing}
          elevation={providers.elevation}
          styleUrl={styleUrl}
          attribution={providers.tiles.attribution}
          onSave={saveTrack}
          onCancel={() => setView({ name: 'list' })}
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

  if (view.name === 'race') {
    const vehicle = getVehicleClass(view.config.vehicleClassId);
    return (
      <div className="h-dvh w-screen overflow-hidden bg-[#0b0e13]">
        <RaceView
          track={view.track}
          config={view.config}
          createWorker={createSimWorker}
          styleUrl={styleUrl}
          attribution={providers.tiles.attribution}
          trackName={view.track.name}
          savedAs={view.savedAs}
          resultActions={(result) => (
            <SaveRaceButton onSave={() => saveRace(view.track, view.config, result)} />
          )}
          header={
            <header className="rounded-lg border border-[#2b3543] bg-[#161b24]/90 px-3 py-2 backdrop-blur">
              <div className="flex items-baseline justify-between gap-3">
                <h1 className="text-sm font-semibold text-[#e6ebf2]">{view.track.name}</h1>
                <button
                  type="button"
                  onClick={() => setView({ name: 'setup', track: view.track })}
                  className="text-xs text-[#8d9bb0] underline-offset-2 hover:text-[#e6ebf2] hover:underline"
                >
                  Settings
                </button>
              </div>
              <p className="text-xs text-[#8d9bb0]">
                {(view.track.lengthMeters / 1000).toFixed(2)}km · {view.config.laps} laps ·{' '}
                {vehicle?.label ?? view.config.vehicleClassId}
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
        loading={loading}
        error={storeError}
        onCreate={() => setView({ name: 'builder' })}
        onRace={(id) => void openSetup(id)}
        onDelete={(id) => void deleteTrack(id)}
        onReplay={(id) => void replayRace(id)}
        onDeleteRace={(id) => void deleteRace(id)}
      />
    </div>
  );
};

/**
 * Saving is explicit rather than automatic. Most races are watched once and
 * forgotten, and silently filling a user's storage with every race they
 * happened to run is not a favour.
 */
const SaveRaceButton = ({ onSave }: { onSave: () => Promise<boolean> }) => {
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
      {state === 'saved' ? 'Saved' : state === 'saving' ? 'Saving…' : 'Save race'}
    </button>
  );
};

/**
 * Vite needs to see `new Worker(new URL(...))` literally in order to bundle the
 * worker — the URL cannot be built from a variable.
 */
const createSimWorker = (): Worker =>
  new Worker(new URL('@anywhererace/worker/worker', import.meta.url), { type: 'module' });
