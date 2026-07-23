import { useMemo, useState } from 'react';
import type { TrackSummary } from '@anywhererace/store';
import type { Championship } from '@anywhererace/championship';
import { computeStandings, findTourBreaks, isComplete, nextLegIndex } from '@anywhererace/championship';
import { getVehicleClass, isRetirement } from '@anywhererace/sim';
import { vehiclesForProfile } from '@anywhererace/track';
import { ChampionshipStandings } from './ChampionshipStandings';

/**
 * A championship's home: its standings, its legs, and the controls to add,
 * order and race them.
 *
 * The championship is already saved by the time this is shown, which is what
 * makes "build a new track for it" safe — navigating off to the builder and
 * back cannot lose an unsaved draft, because there is no draft. Adding a leg,
 * racing one, reordering them: each mutates the stored championship through the
 * callbacks, so the standings are never out of step with what is on disk.
 */

export type AddLegInput = {
  trackId: string;
  vehicleClassId: string;
  laps: number;
};

export type ChampionshipViewProps = {
  championship: Championship;
  /** Saved tracks available to add as legs. */
  tracks: readonly TrackSummary[];
  /** True while the app is baking weather and adding a leg. */
  busy?: boolean;
  error?: string | undefined;
  onAddLeg: (input: AddLegInput) => void;
  onRemoveLeg: (legId: string) => void;
  onReorderLeg: (legId: string, direction: -1 | 1) => void;
  onRaceLeg: (legIndex: number) => void;
  onBuildTrack: () => void;
  onBack: () => void;
  onDelete: () => void;
};

export const ChampionshipView = ({
  championship,
  tracks,
  busy = false,
  error,
  onAddLeg,
  onRemoveLeg,
  onReorderLeg,
  onRaceLeg,
  onBuildTrack,
  onBack,
  onDelete,
}: ChampionshipViewProps) => {
  const next = nextLegIndex(championship);
  const complete = isComplete(championship);
  const tourBreaks = useMemo(
    () => (championship.tour ? findTourBreaks(championship.legs) : []),
    [championship.tour, championship.legs],
  );

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-4 overflow-y-auto p-4 text-[#e6ebf2] md:p-8">
      <header className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-[#8d9bb0] underline-offset-2 hover:text-[#e6ebf2] hover:underline"
          >
            ← All championships
          </button>
          <h1 className="mt-1 truncate text-xl font-semibold">{championship.name}</h1>
          <p className="text-sm text-[#8d9bb0]">
            {championship.tour ? 'Tour' : 'Series'} · {scoringLabel(championship.scoring)} ·{' '}
            {championship.racers.length} racers · {championship.legs.length}{' '}
            {championship.legs.length === 1 ? 'leg' : 'legs'}
          </p>
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="shrink-0 rounded px-2 py-1.5 text-sm text-[#8d9bb0] transition-colors hover:bg-[#2b3543] hover:text-[#ff5c5c]"
        >
          Delete
        </button>
      </header>

      {error === undefined ? null : (
        <p className="rounded border border-[#ff5c5c]/40 bg-[#ff5c5c]/10 px-3 py-2 text-sm text-[#ff5c5c]">
          {error}
        </p>
      )}

      {complete ? (
        <p className="rounded-lg border border-[#3ddc97]/40 bg-[#3ddc97]/10 px-3 py-2 text-sm text-[#3ddc97]">
          Every leg is done. {championship.racers.find((r) => r.id === standingsLeaderId(championship))?.name ?? 'Nobody'}{' '}
          takes the championship.
        </p>
      ) : null}

      {championship.legs.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[#8d9bb0]">
            Standings
          </h2>
          <ChampionshipStandings championship={championship} />
        </section>
      ) : null}

      {tourBreaks.length > 0 ? (
        <p className="rounded border border-[#ffb020]/40 bg-[#ffb020]/10 px-3 py-2 text-xs text-[#ffb020]">
          This tour does not join up: {tourBreaks
            .map((b) => `leg ${b.legIndex + 1} finishes ${(b.gapM / 1000).toFixed(1)}km from where leg ${b.legIndex + 2} starts`)
            .join('; ')}
          . A tour is presented as one continuous journey, so a gap will read oddly.
        </p>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[#8d9bb0]">Legs</h2>
        {championship.legs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#2b3543] p-6 text-center text-sm text-[#8d9bb0]">
            No legs yet. Add a saved track below, or build a new one for this championship.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {championship.legs.map((leg, index) => {
              const raced = leg.result !== undefined;
              const isNext = index === next;
              const winnerName = raced
                ? championship.racers.find(
                    (r) => r.id === leg.result?.finishers.find((f) => f.position === 1 && !isRetirement(f.status))?.racerId,
                  )?.name
                : undefined;
              const vehicle = getVehicleClass(leg.vehicleClassId);
              return (
                <li
                  key={leg.id}
                  className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${
                    isNext
                      ? 'border-[#4da3ff]/60 bg-[#4da3ff]/5'
                      : 'border-[#2b3543] bg-[#161b24]'
                  }`}
                >
                  <span className="w-6 shrink-0 text-center text-sm tabular-nums text-[#8d9bb0]">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-medium">{leg.trackName}</h3>
                    <p className="text-xs tabular-nums text-[#8d9bb0]">
                      {leg.trackMode === 'circuit' ? `${leg.laps} laps` : 'point-to-point'} ·{' '}
                      {vehicle?.label ?? leg.vehicleClassId}
                      {raced && winnerName !== undefined ? (
                        <span className="text-[#3ddc97]"> · won by {winnerName}</span>
                      ) : raced ? (
                        <span className="text-[#ff8f6b]"> · no finisher</span>
                      ) : null}
                    </p>
                  </div>

                  {!raced ? (
                    <div className="flex shrink-0 items-center text-[#8d9bb0]">
                      <button
                        type="button"
                        onClick={() => onReorderLeg(leg.id, -1)}
                        disabled={!canReorder(championship, index, -1)}
                        className="rounded px-1 py-1 text-xs transition-colors hover:bg-[#2b3543] disabled:opacity-30"
                        aria-label={`Move ${leg.trackName} earlier`}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => onReorderLeg(leg.id, 1)}
                        disabled={!canReorder(championship, index, 1)}
                        className="rounded px-1 py-1 text-xs transition-colors hover:bg-[#2b3543] disabled:opacity-30"
                        aria-label={`Move ${leg.trackName} later`}
                      >
                        ↓
                      </button>
                    </div>
                  ) : null}

                  <button
                    type="button"
                    onClick={() => onRaceLeg(index)}
                    className={`shrink-0 rounded px-3 py-1.5 text-sm transition-colors ${
                      isNext
                        ? 'bg-[#4da3ff] font-semibold text-[#0b0e13] hover:bg-[#6fb5ff]'
                        : 'bg-[#1f2632] hover:bg-[#2b3543]'
                    }`}
                  >
                    {raced ? 'Replay' : 'Race'}
                  </button>

                  {!raced ? (
                    <button
                      type="button"
                      onClick={() => onRemoveLeg(leg.id)}
                      className="shrink-0 rounded px-2 py-1.5 text-sm text-[#8d9bb0] transition-colors hover:bg-[#2b3543] hover:text-[#ff5c5c]"
                      aria-label={`Remove ${leg.trackName}`}
                    >
                      Remove
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <AddLegForm
        tracks={tracks}
        busy={busy}
        onAddLeg={onAddLeg}
        onBuildTrack={onBuildTrack}
      />
    </div>
  );
};

/**
 * The add-a-leg form.
 *
 * Vehicle classes are filtered to the selected track's routing profile — a
 * pedestrian trail cannot host a rally car — exactly as race setup does, so a
 * user cannot assemble a leg the sim would refuse.
 */
const AddLegForm = ({
  tracks,
  busy,
  onAddLeg,
  onBuildTrack,
}: {
  tracks: readonly TrackSummary[];
  busy: boolean;
  onAddLeg: (input: AddLegInput) => void;
  onBuildTrack: () => void;
}) => {
  const [trackId, setTrackId] = useState<string>(tracks[0]?.id ?? '');
  const [vehicleClassId, setVehicleClassId] = useState<string>('');
  const [laps, setLaps] = useState(3);

  const selected = tracks.find((t) => t.id === trackId);
  const vehicles = useMemo(
    () => (selected ? vehiclesForProfile(selected.routingProfile) : []),
    [selected],
  );

  // Keep the vehicle selection legal for the chosen track: default to the last
  // (fastest) class, and correct an inherited pick the new profile forbids.
  const effectiveVehicle =
    vehicles.some((v) => v.id === vehicleClassId) ? vehicleClassId : vehicles[vehicles.length - 1]?.id ?? '';

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-[#2b3543] bg-[#161b24] p-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[#8d9bb0]">Add a leg</h2>
      {tracks.length === 0 ? (
        <p className="text-sm text-[#8d9bb0]">
          No saved tracks to add. Build one for this championship.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-[#8d9bb0]">
            Track
            <select
              value={trackId}
              onChange={(event) => setTrackId(event.target.value)}
              className="rounded border border-[#2b3543] bg-[#0b0e13] px-2 py-1.5 text-sm text-[#e6ebf2] outline-none focus:border-[#4da3ff]"
            >
              {tracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name} ({(track.lengthMeters / 1000).toFixed(1)}km, {track.mode})
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-[#8d9bb0]">
            Vehicle
            <select
              value={effectiveVehicle}
              onChange={(event) => setVehicleClassId(event.target.value)}
              className="rounded border border-[#2b3543] bg-[#0b0e13] px-2 py-1.5 text-sm text-[#e6ebf2] outline-none focus:border-[#4da3ff]"
            >
              {vehicles.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.label}
                </option>
              ))}
            </select>
          </label>

          {selected?.mode === 'circuit' ? (
            <label className="flex w-20 flex-col gap-1 text-xs text-[#8d9bb0]">
              Laps
              <input
                type="number"
                min={1}
                max={200}
                value={laps}
                onChange={(event) => setLaps(Math.max(1, Math.round(Number(event.target.value))))}
                className="rounded border border-[#2b3543] bg-[#0b0e13] px-2 py-1.5 text-sm text-[#e6ebf2] outline-none focus:border-[#4da3ff]"
              />
            </label>
          ) : null}

          <button
            type="button"
            disabled={busy || effectiveVehicle === '' || trackId === ''}
            onClick={() =>
              onAddLeg({
                trackId,
                vehicleClassId: effectiveVehicle,
                laps: selected?.mode === 'circuit' ? laps : 1,
              })
            }
            className="rounded bg-[#1f2632] px-3 py-1.5 text-sm transition-colors hover:bg-[#2b3543] disabled:opacity-50"
          >
            {busy ? 'Adding…' : 'Add leg'}
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={onBuildTrack}
        className="self-start text-xs text-[#4da3ff] underline-offset-2 hover:underline"
      >
        + Build a new track for this championship
      </button>
    </section>
  );
};

const scoringLabel = (scoring: Championship['scoring']): string =>
  scoring === 'points' ? 'points' : scoring === 'hybrid' ? 'time (points break ties)' : 'time';

/**
 * A leg may be reordered only among unraced legs: moving a raced leg would
 * shuffle the standings' leg columns under results that already exist. Both the
 * leg and the one it would swap with must be unraced.
 */
const canReorder = (championship: Championship, index: number, direction: -1 | 1): boolean => {
  const target = index + direction;
  const here = championship.legs[index];
  const swap = championship.legs[target];
  if (here === undefined || swap === undefined) return false;
  return here.result === undefined && swap.result === undefined;
};

/** The current leader's racer id, using the same ranking the table shows. */
const standingsLeaderId = (championship: Championship): string | undefined =>
  computeStandings(championship)[0]?.racerId;
