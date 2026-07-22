import { useMemo } from 'react';
import { formatDurationS, formatShortDistanceM } from '@anywhererace/core';
import type { UnitSystem } from '@anywhererace/core';
import type { RaceResult, RaceSnapshot, RacerSnapshot } from '@anywhererace/sim';
import type { RacerView } from '../useRaceClient';
import { useUnits } from '../units';
import { PatternSwatch } from './PatternSwatch';

/**
 * The timing tower.
 *
 * CLAUDE.md is right that this has to be permanently on screen: for most of a
 * race the map alone does not tell you who is winning. Two racers a hundred
 * metres apart look identical to two racers a second apart, and the interesting
 * question is almost always the gap.
 *
 * Gaps are shown in seconds rather than metres because that is how racing is
 * actually discussed, and because a metre gap means something completely
 * different at 20kph than at 300kph.
 */

export type TimingTowerProps = {
  snapshot: RaceSnapshot | undefined;
  racers: readonly RacerView[];
  racersById: ReadonlyMap<string, RacerView>;
  totalLaps: number;
  lapLengthM: number;
  /**
   * The classification, once there is one. Needed because a racer who has
   * finished sits at exactly the race distance — so every gap derived from
   * distance collapses to zero the moment they cross the line, and the tower
   * would report a twelve-car dead heat.
   */
  result?: RaceResult | undefined;
};

type Gap =
  | { kind: 'none' }
  | { kind: 'seconds'; value: number }
  /** Used on the grid and at a standstill, where a time gap is meaningless. */
  | { kind: 'meters'; value: number };

type Row = {
  racer: RacerView;
  state: RacerSnapshot;
  gapToLeader: Gap;
  gapToAhead: Gap;
  lapsDown: number;
};

/**
 * Below this speed a time gap is not worth showing. Dividing a distance by a
 * near-zero speed produces enormous numbers — on the grid, before the race has
 * started, every gap would read as several seconds when in truth nobody has
 * moved. Metres are the honest unit at a standstill.
 */
const MIN_SPEED_FOR_TIME_GAP_MS = 2;

const formatGap = (gap: Gap, system: UnitSystem): string => {
  switch (gap.kind) {
    case 'none':
      return '';
    case 'seconds':
      return `+${gap.value.toFixed(2)}`;
    case 'meters':
      return `+${formatShortDistanceM(gap.value, system)}`;
  }
};

export const TimingTower = ({
  snapshot,
  racers,
  racersById,
  totalLaps,
  lapLengthM,
  result,
}: TimingTowerProps) => {
  const rows = useMemo(
    () => buildRows(snapshot, racersById, lapLengthM, result),
    [snapshot, racersById, lapLengthM, result],
  );

  if (snapshot === undefined) {
    return (
      <div className="rounded-lg border border-[#2b3543] bg-[#161b24]/90 p-4 text-sm text-[#8d9bb0] backdrop-blur">
        Building the race…
      </div>
    );
  }

  const leaderLap = rows[0]?.state.lap ?? 0;

  return (
    <div className="flex max-h-[70vh] w-[19rem] flex-col overflow-hidden rounded-lg border border-[#2b3543] bg-[#161b24]/90 backdrop-blur">
      <header className="flex items-baseline justify-between border-b border-[#2b3543] px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-[#8d9bb0]">
          Timing
        </span>
        {totalLaps > 1 ? (
          <span className="text-xs tabular-nums text-[#8d9bb0]">
            Lap <span className="text-[#e6ebf2]">{Math.min(leaderLap + 1, totalLaps)}</span> /{' '}
            {totalLaps}
          </span>
        ) : (
          <span className="text-xs tabular-nums text-[#8d9bb0]">
            {formatDurationS(snapshot.elapsedS, 1)}
          </span>
        )}
      </header>

      <ol className="flex-1 overflow-y-auto">
        {rows.map((row) => (
          <TowerRow key={row.racer.racerId} row={row} />
        ))}
      </ol>

      {racers.length === 0 ? null : (
        <footer className="border-t border-[#2b3543] px-3 py-1.5 text-[10px] text-[#8d9bb0]">
          Gap to leader · interval to car ahead
        </footer>
      )}
    </div>
  );
};

const TowerRow = ({ row }: { row: Row }) => {
  const { racer, state } = row;
  const { system } = useUnits();
  const retired =
    state.status === 'dnf-crash' ||
    state.status === 'dnf-mechanical' ||
    state.status === 'dnf-timeout';

  return (
    <li
      className={`flex items-center gap-2 border-b border-[#2b3543]/50 px-3 py-1.5 text-sm last:border-b-0 ${
        retired ? 'opacity-45' : ''
      }`}
    >
      <span className="w-5 shrink-0 text-right text-xs tabular-nums text-[#8d9bb0]">
        {state.position}
      </span>

      <PatternSwatch appearance={racer.appearance} label={String(racer.number)} />

      <span className="min-w-0 flex-1 truncate text-[#e6ebf2]">{racer.name}</span>

      <span className="shrink-0 text-right text-xs tabular-nums">
        {retired ? (
          <span className="text-[#ff5c5c]">
            {state.status === 'dnf-crash' ? 'CRASH' : state.status === 'dnf-timeout' ? 'TIME' : 'MECH'}
          </span>
        ) : row.lapsDown > 0 ? (
          <span className="text-[#8d9bb0]">
            +{row.lapsDown} lap{row.lapsDown > 1 ? 's' : ''}
          </span>
        ) : row.gapToLeader.kind === 'none' ? (
          <span className="text-[#3ddc97]">Leader</span>
        ) : (
          <span className="text-[#e6ebf2]">{formatGap(row.gapToLeader, system)}</span>
        )}
        {row.gapToAhead.kind !== 'none' && row.lapsDown === 0 && !retired ? (
          <span className="block text-[10px] text-[#8d9bb0]">
            {formatGap(row.gapToAhead, system)}
          </span>
        ) : null}
      </span>
    </li>
  );
};

/**
 * Gaps are derived from distance and speed rather than from crossing times.
 *
 * Timing loops would be more faithful to how real timing works, but they only
 * update when a racer crosses one — so a gap would sit stale for most of a lap,
 * which is exactly when the viewer is watching a fight develop. Dividing the
 * distance gap by the *chasing* racer's speed answers the question the viewer
 * is actually asking: how long until they are there.
 */
const buildRows = (
  snapshot: RaceSnapshot | undefined,
  racersById: ReadonlyMap<string, RacerView>,
  lapLengthM: number,
  result: RaceResult | undefined,
): Row[] => {
  if (snapshot === undefined) return [];

  const ordered = snapshot.racers.slice().sort((a, b) => a.position - b.position);
  const leader = ordered[0];
  if (leader === undefined) return [];

  const classified = new Map(result?.finishers.map((record) => [record.racerId, record]) ?? []);

  const rows: Row[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const state = ordered[i] as RacerSnapshot;
    const racer = racersById.get(state.racerId);
    if (racer === undefined) continue;

    const behindLeaderM = leader.distanceAlongRoute - state.distanceAlongRoute;
    const ahead = ordered[i - 1];
    const aheadM =
      ahead === undefined ? undefined : ahead.distanceAlongRoute - state.distanceAlongRoute;

    const asGap = (distanceM: number | undefined): Gap => {
      if (distanceM === undefined) return { kind: 'none' };
      if (state.speedMs < MIN_SPEED_FOR_TIME_GAP_MS) return { kind: 'meters', value: distanceM };
      return { kind: 'seconds', value: distanceM / state.speedMs };
    };

    // Once a racer has crossed the line their distance is pinned to the race
    // distance, so the classification is the only honest source of a gap.
    // Scrubbing back mid-race puts their status back to 'racing' in that
    // recorded frame, and live gaps resume by themselves.
    const record = state.status === 'finished' ? classified.get(state.racerId) : undefined;

    rows.push({
      racer,
      state,
      gapToLeader:
        record !== undefined
          ? record.gapToWinnerS === undefined
            ? { kind: 'none' }
            : { kind: 'seconds', value: record.gapToWinnerS }
          : i === 0
            ? { kind: 'none' }
            : asGap(behindLeaderM),
      gapToAhead: record !== undefined ? { kind: 'none' } : asGap(aheadM),
      lapsDown: record !== undefined || lapLengthM <= 0 ? 0 : Math.floor(behindLeaderM / lapLengthM),
    });
  }
  return rows;
};
