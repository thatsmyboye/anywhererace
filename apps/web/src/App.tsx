import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Track } from '@anywhererace/core';
import { hasBasemapKey } from '@anywhererace/core';
import type { RaceConfig } from '@anywhererace/sim';
import { getVehicleClass } from '@anywhererace/sim';
import { createTrackStore } from '@anywhererace/store';
import type { TrackSummary } from '@anywhererace/store';
import { RaceView, TrackBuilder, TrackList } from '@anywhererace/ui';
import { buildDemoConfig } from './demoRace';
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
  | { name: 'race'; track: Track; config: RaceConfig };

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;

export const App = () => {
  const [degraded, setDegraded] = useState<DegradedState>({ routing: false, elevation: false });
  const providers = useMemo(
    () => createProviders({ maptilerKey: MAPTILER_KEY, onDegradedChange: setDegraded }),
    [],
  );
  const store = useMemo(() => createTrackStore(), []);

  const [view, setView] = useState<View>({ name: 'list' });
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [storeError, setStoreError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await store.list();
    if (result.ok) {
      setTracks(result.value);
      setStoreError(undefined);
    } else {
      setStoreError(result.error.message);
    }
    setLoading(false);
  }, [store]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const raceTrack = useCallback(
    async (id: string) => {
      const result = await store.get(id);
      if (!result.ok) {
        setStoreError(result.error.message);
        return;
      }
      const track = result.value.track;
      setView({ name: 'race', track, config: buildDemoConfig(track) });
    },
    [store],
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
          header={
            <header className="rounded-lg border border-[#2b3543] bg-[#161b24]/90 px-3 py-2 backdrop-blur">
              <div className="flex items-baseline justify-between gap-3">
                <h1 className="text-sm font-semibold text-[#e6ebf2]">{view.track.name}</h1>
                <button
                  type="button"
                  onClick={() => setView({ name: 'list' })}
                  className="text-xs text-[#8d9bb0] underline-offset-2 hover:text-[#e6ebf2] hover:underline"
                >
                  Back
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
        loading={loading}
        error={storeError}
        onCreate={() => setView({ name: 'builder' })}
        onRace={(id) => void raceTrack(id)}
        onDelete={(id) => void deleteTrack(id)}
      />
    </div>
  );
};

/**
 * Vite needs to see `new Worker(new URL(...))` literally in order to bundle the
 * worker — the URL cannot be built from a variable.
 */
const createSimWorker = (): Worker =>
  new Worker(new URL('@anywhererace/worker/worker', import.meta.url), { type: 'module' });
