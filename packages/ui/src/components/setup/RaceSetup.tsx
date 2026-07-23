import { useCallback, useState } from 'react';
import type { Track, WeatherProvider } from '@anywhererace/core';
import { formatDurationS } from '@anywhererace/core';
import type { GridOrder, RaceConfig } from '@anywhererace/sim';
import { getVehicleClass } from '@anywhererace/sim';
import type { RosterPresetSummary } from '@anywhererace/store';
import { useRaceSetup } from '../../useRaceSetup';
import { UnitToggle, useUnits } from '../../units';
import { RosterTable } from './RosterTable';
import { SeparationPoints } from './SeparationPoints';
import { WeatherPicker } from './WeatherPicker';

/**
 * Race setup.
 *
 * One scrolling page rather than a wizard, because these settings interact: the
 * track's routing profile decides which vehicles are legal, the vehicle and lap
 * count decide how long the race is, and the field size drives the roster.
 * Hiding any of that behind a "next" button makes the relationships invisible
 * exactly when the user is trying to reason about them.
 */

export type RaceSetupProps = {
  track: Track;
  weather: WeatherProvider;
  presets: readonly RosterPresetSummary[];
  onStart: (config: RaceConfig) => void;
  onBack: () => void;
  onSavePreset: (name: string, roster: { name: string; color: string; personality: string; skill: number }[]) => void | Promise<void>;
  onLoadPreset: (id: string) => Promise<{ name: string; personality: string; skill: number }[] | undefined>;
  onDeletePreset?: (id: string) => void | Promise<void>;
};

const GRID_ORDERS: { value: GridOrder; label: string; help: string }[] = [
  { value: 'reverse-skill', label: 'Reverse skill', help: 'Slowest at the front. The most to watch.' },
  { value: 'by-skill', label: 'By skill', help: 'Fastest at the front. Often processional.' },
  { value: 'random', label: 'Random', help: 'Drawn from the seed.' },
];

export const RaceSetup = ({
  track,
  weather,
  presets,
  onStart,
  onBack,
  onSavePreset,
  onLoadPreset,
  onDeletePreset,
}: RaceSetupProps) => {
  const setup = useRaceSetup({ track, weather });
  const { actions } = setup;
  const units = useUnits();
  const [presetName, setPresetName] = useState('');
  const selectedFormat = getVehicleClass(setup.vehicleClassId)?.raceFormat ?? 'standard';

  const savePreset = useCallback(() => {
    const name = presetName.trim() === '' ? `Roster of ${setup.roster.length}` : presetName.trim();
    void onSavePreset(
      name,
      setup.roster.map((entry, index) => ({
        name: entry.name,
        color: setup.palette[index]?.color ?? '#888888',
        personality: entry.personality,
        skill: entry.skill,
      })),
    );
    setPresetName('');
  }, [onSavePreset, presetName, setup.roster, setup.palette]);

  const loadPreset = useCallback(
    async (id: string) => {
      const rows = await onLoadPreset(id);
      if (rows !== undefined) actions.loadRoster(rows);
    },
    [onLoadPreset, actions],
  );

  return (
    <div className="flex h-full w-full flex-col bg-[#0b0e13] text-[#e6ebf2]">
      <header className="flex shrink-0 items-center gap-3 border-b border-[#2b3543] bg-[#161b24] px-4 py-3">
        <button type="button" onClick={onBack} className={ghost}>
          ← Back
        </button>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{track.name}</h1>
          <p className="text-xs tabular-nums text-[#8d9bb0]">
            {units.distance(track.lengthMeters)} · {track.mode} · {track.routingProfile}
          </p>
        </div>
        <UnitToggle className="ml-auto shrink-0" />
      </header>

      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 overflow-y-auto p-4 md:p-5">
        <section className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Vehicle</span>
            <select
              value={setup.vehicleClassId}
              onChange={(event) => actions.setVehicleClassId(event.target.value)}
              className={inputClass}
            >
              {setup.allowedVehicles.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.label}
                </option>
              ))}
            </select>
          </label>

          {setup.isCircuit ? (
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Laps</span>
              <input
                type="number"
                min={1}
                max={200}
                value={setup.laps}
                onChange={(event) => actions.setLaps(Number(event.target.value))}
                className={inputClass}
              />
            </label>
          ) : (
            <div className="flex flex-col gap-1">
              <span className={labelClass}>Distance</span>
              <span className="px-2 py-1.5 text-sm tabular-nums">
                {units.distance(track.lengthMeters)}
              </span>
            </div>
          )}

          <label className="flex flex-col gap-1">
            <span className={labelClass}>Field</span>
            <input
              type="number"
              min={2}
              max={40}
              value={setup.fieldSize}
              onChange={(event) => actions.setFieldSize(Number(event.target.value))}
              className={inputClass}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className={labelClass}>Grid</span>
            <select
              value={setup.gridOrder}
              onChange={(event) => actions.setGridOrder(event.target.value as GridOrder)}
              className={inputClass}
            >
              {GRID_ORDERS.map((order) => (
                <option key={order.value} value={order.value} title={order.help}>
                  {order.label}
                </option>
              ))}
            </select>
          </label>
        </section>

        {setup.blockedVehicles.length === 0 ? null : (
          <p className="text-[11px] leading-snug text-[#8d9bb0]">
            {setup.blockedVehicles.length} more classes exist but cannot race a{' '}
            <em>{track.routingProfile}</em> track:{' '}
            {setup.blockedVehicles.map((vehicle) => vehicle.label).join(', ')}. Rebuilding the
            track under a different routing profile would allow them — it changes the route&rsquo;s
            length and shape, so it makes a new track rather than editing this one.
          </p>
        )}

        {/* Only for the bunch-racing classes: for a motor race the answer is
            uninteresting, since the field is strung out by lap two whatever the
            road does. */}
        {selectedFormat === 'cycling' ? (
          <SeparationPoints points={track.separationPoints} />
        ) : null}

        <WeatherPicker
          mode={setup.weatherMode}
          conditions={setup.conditionsAtStart}
          manualConditions={setup.manualConditions}
          startsAt={setup.startsAt}
          fetching={setup.fetchingForecast}
          error={setup.forecastError}
          onModeChange={actions.setWeatherMode}
          onManualChange={actions.setManualConditions}
          onStartsAtChange={actions.setStartsAt}
          onRefresh={() => void actions.refreshForecast()}
        />

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className={labelClass}>Roster ({setup.fieldSize})</h2>
            <button type="button" onClick={actions.randomizeField} className={ghost}>
              Randomise
            </button>

            <span className="ml-auto flex items-center gap-1">
              <input
                value={presetName}
                onChange={(event) => setPresetName(event.target.value)}
                placeholder="Preset name"
                aria-label="Name for this roster preset"
                className="w-32 rounded border border-[#2b3543] bg-[#0b0e13] px-2 py-1 text-xs outline-none focus:border-[#4da3ff]"
              />
              <button type="button" onClick={savePreset} className={ghost}>
                Save roster
              </button>
            </span>
          </div>

          {presets.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-1 text-xs text-[#8d9bb0]">
              <span>Load:</span>
              {presets.map((preset) => (
                <span key={preset.id} className="flex items-center overflow-hidden rounded border border-[#2b3543]">
                  <button
                    type="button"
                    onClick={() => void loadPreset(preset.id)}
                    className="bg-[#1f2632] px-2 py-1 text-[#e6ebf2] transition-colors hover:bg-[#2b3543]"
                  >
                    {preset.name}{' '}
                    <span className="text-[#8d9bb0]">({preset.racerCount})</span>
                  </button>
                  {onDeletePreset === undefined ? null : (
                    <button
                      type="button"
                      onClick={() => void onDeletePreset(preset.id)}
                      aria-label={`Delete preset ${preset.name}`}
                      className="bg-[#1f2632] px-1.5 py-1 text-[#8d9bb0] transition-colors hover:bg-[#2b3543] hover:text-[#ff5c5c]"
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}

          <RosterTable roster={setup.roster} palette={setup.palette} onChange={actions.updateRacer} />
        </section>

        <section className="flex flex-wrap items-center gap-3">
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Seed</span>
            <input
              value={setup.seed}
              onChange={(event) => actions.setSeed(event.target.value)}
              className={`${inputClass} w-40 font-mono`}
            />
          </label>
          <button type="button" onClick={actions.rerollSeed} className={`${ghost} mt-5`}>
            New seed
          </button>
          <p className="mt-5 text-[11px] leading-snug text-[#8d9bb0]">
            The same seed, track and settings always produce exactly the same race.
          </p>
        </section>
      </div>

      <footer className="flex shrink-0 items-center gap-4 border-t border-[#2b3543] bg-[#161b24] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-5 md:pb-3">
        <p className="text-xs tabular-nums text-[#8d9bb0]">
          {units.distance(setup.raceDistanceM)}
          <span className="mx-1.5 text-[#2b3543]">·</span>
          about {formatDurationS(setup.estimatedDurationS, 0)}
          <span className="mx-1.5 text-[#2b3543]">·</span>
          {setup.fieldSize} racers
        </p>
        <button
          type="button"
          onClick={() => onStart(setup.config)}
          className="ml-auto rounded bg-[#4da3ff] px-4 py-2 text-sm font-semibold text-[#0b0e13] transition-colors hover:bg-[#6fb5ff]"
        >
          Start race
        </button>
      </footer>
    </div>
  );
};

const labelClass = 'text-[11px] font-semibold uppercase tracking-wide text-[#8d9bb0]';
const inputClass =
  'rounded border border-[#2b3543] bg-[#0b0e13] px-2 py-1.5 text-sm text-[#e6ebf2] outline-none focus:border-[#4da3ff]';
const ghost =
  'rounded border border-[#2b3543] bg-[#1f2632] px-2 py-1 text-xs text-[#e6ebf2] transition-colors hover:bg-[#2b3543] disabled:opacity-40';
