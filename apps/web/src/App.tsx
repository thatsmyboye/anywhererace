import { useEffect, useMemo, useState } from 'react';
import type { Track } from '@anywhererace/core';
import { createMapTilerProvider, hasBasemapKey } from '@anywhererace/core';
import type { RaceConfig } from '@anywhererace/sim';
import { getVehicleClass } from '@anywhererace/sim';
import { RaceView } from '@anywhererace/ui';
import { buildDemoConfig, buildDemoTrack } from './demoRace';

/**
 * The app shell.
 *
 * There is no track builder or race setup screen yet, so this loads a demo race
 * and drops straight into the race view. When those screens arrive this becomes
 * a router; for now it is the smallest thing that puts a real race on a real
 * map.
 */

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY as string | undefined;

export const App = () => {
  const [track, setTrack] = useState<Track | undefined>(undefined);
  const [config, setConfig] = useState<RaceConfig | undefined>(undefined);
  const [buildError, setBuildError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    buildDemoTrack()
      .then((demoTrack) => {
        if (cancelled) return;
        setTrack(demoTrack);
        setConfig(buildDemoConfig(demoTrack));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setBuildError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tiles = useMemo(() => createMapTilerProvider({ apiKey: MAPTILER_KEY }), []);

  if (buildError !== undefined) {
    return (
      <Centered>
        <h1 className="mb-2 text-lg font-semibold text-[#ff5c5c]">Could not build the track</h1>
        <p className="text-sm text-[#8d9bb0]">{buildError}</p>
      </Centered>
    );
  }

  if (track === undefined || config === undefined) {
    return (
      <Centered>
        <p className="text-sm text-[#8d9bb0]">Building the track…</p>
      </Centered>
    );
  }

  const vehicle = getVehicleClass(config.vehicleClassId);

  return (
    <div className="h-dvh w-screen overflow-hidden bg-[#0b0e13]">
      <RaceView
        track={track}
        config={config}
        createWorker={createSimWorker}
        styleUrl={tiles.styleUrl()}
        attribution={tiles.attribution}
        header={
          <header className="rounded-lg border border-[#2b3543] bg-[#161b24]/90 px-3 py-2 backdrop-blur">
            <h1 className="text-sm font-semibold text-[#e6ebf2]">{track.name}</h1>
            <p className="text-xs text-[#8d9bb0]">
              {(track.lengthMeters / 1000).toFixed(2)}km · {config.laps} laps ·{' '}
              {vehicle?.label ?? config.vehicleClassId}
            </p>
            {hasBasemapKey(MAPTILER_KEY) ? null : (
              <p className="mt-1 text-[10px] leading-tight text-[#ffb020]">
                No basemap key set — showing a blank background. Add
                VITE_MAPTILER_KEY to .env.local.
              </p>
            )}
          </header>
        }
      />
    </div>
  );
};

/**
 * Vite needs to see `new Worker(new URL(...), ...)` literally in order to
 * bundle the worker — the URL cannot be built from a variable, which is why
 * this is written out here rather than passed in as a string.
 */
const createSimWorker = (): Worker =>
  new Worker(new URL('@anywhererace/worker/worker', import.meta.url), { type: 'module' });

const Centered = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-dvh w-screen items-center justify-center bg-[#0b0e13] p-8">
    <div className="max-w-md text-center">{children}</div>
  </div>
);
