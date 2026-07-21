import type { WeatherConditions } from '@anywhererace/core';
import type { WeatherMode } from '../../useRaceSetup';

/**
 * Weather.
 *
 * Two modes, matching the decision recorded in CLAUDE.md: a real forecast —
 * for now by default, or for a scheduled future start — or hand-set conditions.
 * Either way it is baked into the race config at creation and never fetched
 * again, so a saved race replays in the weather it was actually run in.
 */

export type WeatherPickerProps = {
  mode: WeatherMode;
  conditions: WeatherConditions;
  manualConditions: WeatherConditions;
  startsAt: string | undefined;
  fetching: boolean;
  error: string | undefined;
  onModeChange: (mode: WeatherMode) => void;
  onManualChange: (conditions: WeatherConditions) => void;
  onStartsAtChange: (startsAt: string | undefined) => void;
  onRefresh: () => void;
};

export const WeatherPicker = ({
  mode,
  conditions,
  manualConditions,
  startsAt,
  fetching,
  error,
  onModeChange,
  onManualChange,
  onStartsAtChange,
  onRefresh,
}: WeatherPickerProps) => (
  <section className="flex flex-col gap-2">
    <div className="flex items-center gap-2">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[#8d9bb0]">Weather</h2>
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => onModeChange('forecast')}
          aria-pressed={mode === 'forecast'}
          className={pill(mode === 'forecast')}
        >
          Real forecast
        </button>
        <button
          type="button"
          onClick={() => onModeChange('manual')}
          aria-pressed={mode === 'manual'}
          className={pill(mode === 'manual')}
        >
          Set by hand
        </button>
      </div>
      {mode === 'forecast' ? (
        <button type="button" onClick={onRefresh} disabled={fetching} className={ghost}>
          {fetching ? 'Fetching…' : 'Refresh'}
        </button>
      ) : null}
    </div>

    {mode === 'forecast' ? (
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-xs text-[#8d9bb0]">
          <span className="shrink-0">Starts</span>
          <input
            type="datetime-local"
            value={toLocalInput(startsAt)}
            onChange={(event) =>
              onStartsAtChange(
                event.target.value === '' ? undefined : new Date(event.target.value).toISOString(),
              )
            }
            className="rounded border border-[#2b3543] bg-[#0b0e13] px-2 py-1 text-xs text-[#e6ebf2] outline-none focus:border-[#4da3ff]"
          />
          {startsAt === undefined ? (
            <span className="text-[11px]">now</span>
          ) : (
            <button type="button" onClick={() => onStartsAtChange(undefined)} className={ghost}>
              Use now
            </button>
          )}
        </label>

        {error === undefined ? (
          <ConditionsSummary conditions={conditions} />
        ) : (
          <p className="rounded border border-[#ffb020]/40 bg-[#ffb020]/10 px-2 py-1.5 text-[11px] leading-snug text-[#ffb020]">
            {error} Falling back to hand-set conditions.
          </p>
        )}
      </div>
    ) : (
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Slider
          label="Temperature"
          value={manualConditions.temperatureC}
          min={-10}
          max={45}
          step={1}
          format={(v) => `${v.toFixed(0)}°C`}
          onChange={(temperatureC) => onManualChange({ ...manualConditions, temperatureC })}
        />
        <Slider
          label="Rain"
          value={manualConditions.precipitationMmPerHour}
          min={0}
          max={10}
          step={0.5}
          format={(v) => (v === 0 ? 'dry' : `${v.toFixed(1)} mm/h`)}
          onChange={(precipitationMmPerHour) =>
            onManualChange({ ...manualConditions, precipitationMmPerHour })
          }
        />
        <Slider
          label="Wind"
          value={manualConditions.windSpeedMs}
          min={0}
          max={25}
          step={0.5}
          format={(v) => (v === 0 ? 'still' : `${v.toFixed(1)} m/s`)}
          onChange={(windSpeedMs) => onManualChange({ ...manualConditions, windSpeedMs })}
        />
        <Slider
          label="Wind from"
          value={manualConditions.windFromDegrees}
          min={0}
          max={350}
          step={10}
          format={(v) => `${compass(v)} (${v.toFixed(0)}°)`}
          onChange={(windFromDegrees) => onManualChange({ ...manualConditions, windFromDegrees })}
        />
      </div>
    )}
  </section>
);

const ConditionsSummary = ({ conditions }: { conditions: WeatherConditions }) => (
  <p className="text-xs tabular-nums text-[#e6ebf2]">
    {conditions.temperatureC.toFixed(0)}°C
    <span className="mx-1.5 text-[#2b3543]">·</span>
    {conditions.precipitationMmPerHour === 0
      ? 'dry'
      : `${conditions.precipitationMmPerHour.toFixed(1)} mm/h rain`}
    <span className="mx-1.5 text-[#2b3543]">·</span>
    {conditions.windSpeedMs.toFixed(1)} m/s from {compass(conditions.windFromDegrees)}
    <span className="mx-1.5 text-[#2b3543]">·</span>
    {Math.round(conditions.cloudCoverFraction * 100)}% cloud
  </p>
);

const Slider = ({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) => (
  <label className="flex flex-col gap-0.5">
    <span className="flex justify-between text-[11px] text-[#8d9bb0]">
      {label}
      <span className="tabular-nums text-[#e6ebf2]">{format(value)}</span>
    </span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className="h-1 cursor-pointer appearance-none rounded bg-[#2b3543] accent-[#4da3ff]"
    />
  </label>
);

/** Wind direction reads far better as a compass point than as degrees. */
const compass = (degrees: number): string => {
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return points[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16] ?? 'N';
};

/**
 * `datetime-local` wants local wall-clock time with no zone, so the stored UTC
 * instant is shifted into the browser's offset before display and converted
 * back on the way out.
 */
const toLocalInput = (iso: string | undefined): string => {
  if (iso === undefined) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

const pill = (active: boolean): string =>
  [
    'rounded px-2 py-1 text-xs font-medium transition-colors',
    active ? 'bg-[#4da3ff] text-[#0b0e13]' : 'bg-[#1f2632] text-[#e6ebf2] hover:bg-[#2b3543]',
  ].join(' ');

const ghost =
  'rounded border border-[#2b3543] bg-[#1f2632] px-2 py-1 text-[11px] text-[#e6ebf2] transition-colors hover:bg-[#2b3543] disabled:opacity-40';
