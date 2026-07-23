import { useMemo, useState } from 'react';
import { MAX_FIELD_SIZE, MIN_FIELD_SIZE, createRng } from '@anywhererace/core';
import type {
  Championship,
  ChampionshipRacer,
  PointsTable,
  ScoringMode,
} from '@anywhererace/championship';
import { F1_POINTS_TABLE, linearPointsTable } from '@anywhererace/championship';
import { ARCHETYPES } from '@anywhererace/sim';
import type { GridOrder } from '@anywhererace/sim';
import { buildPalette } from '../../palette';
import { generateRacerNames } from '../../racerNames';
import type { RosterEntry } from '../../useRaceSetup';
import { RosterTable } from '../setup/RosterTable';

/**
 * Championship creation.
 *
 * A championship is created with its rules and its field but *no legs*: legs
 * are added afterwards, in the championship's own view, because that is what
 * lets a user build a fresh track for it without losing an in-progress draft.
 * Everything decided here — the scoring, the points table, above all the field —
 * is fixed for the life of the championship, since the standings depend on it
 * not moving underneath them.
 */

export type ChampionshipSetupProps = {
  onCreate: (championship: Championship) => void;
  onCancel: () => void;
};

type PointsPreset = 'f1' | 'linear' | 'custom';

const DEFAULT_FIELD_SIZE = 12;
const MIN_FIELD = MIN_FIELD_SIZE;
const MAX_FIELD = MAX_FIELD_SIZE;

export const ChampionshipSetup = ({ onCreate, onCancel }: ChampionshipSetupProps) => {
  const [name, setName] = useState('');
  const [scoring, setScoring] = useState<ScoringMode>('hybrid');
  const [tour, setTour] = useState(false);
  const [gridOrder, setGridOrder] = useState<GridOrder>('reverse-skill');
  const [roster, setRoster] = useState<RosterEntry[]>(() => makeField(DEFAULT_FIELD_SIZE, randomSeed()));

  const [pointsPreset, setPointsPreset] = useState<PointsPreset>('f1');
  const [customPoints, setCustomPoints] = useState(F1_POINTS_TABLE.perPosition.join(', '));
  const [finisherFloor, setFinisherFloor] = useState(0);

  const palette = useMemo(() => buildPalette(roster.length), [roster.length]);

  const pointsTable = useMemo(
    () => resolvePointsTable(pointsPreset, customPoints, finisherFloor, roster.length),
    [pointsPreset, customPoints, finisherFloor, roster.length],
  );

  const setFieldSize = (size: number) => {
    const clamped = Math.min(MAX_FIELD, Math.max(MIN_FIELD, Math.round(size)));
    setRoster((current) => {
      if (clamped === current.length) return current;
      if (clamped < current.length) return current.slice(0, clamped);
      return [...current, ...makeField(clamped - current.length, randomSeed(), current.length)];
    });
  };

  const updateRacer = (id: string, patch: Partial<Omit<RosterEntry, 'id'>>) =>
    setRoster((current) => current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));

  const canCreate = name.trim().length > 0 && (pointsPreset !== 'custom' || pointsTable.perPosition.length > 0);

  const create = () => {
    const racers: ChampionshipRacer[] = roster.map((entry, index) => ({
      id: entry.id,
      name: entry.name,
      color: palette[index]?.color ?? '#888888',
      personality: entry.personality,
      skill: entry.skill,
    }));
    const nowIso = new Date().toISOString();
    onCreate({
      id: `champ-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim(),
      createdAt: nowIso,
      updatedAt: nowIso,
      tour,
      scoring,
      pointsTable,
      gridOrder,
      racers,
      legs: [],
    });
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-5 overflow-y-auto p-4 text-[#e6ebf2] md:p-8">
      <header className="flex items-baseline justify-between">
        <div>
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-[#8d9bb0] underline-offset-2 hover:text-[#e6ebf2] hover:underline"
          >
            ← All championships
          </button>
          <h1 className="mt-1 text-xl font-semibold">New championship</h1>
          <p className="text-sm text-[#8d9bb0]">
            Set the rules and the field. You add the tracks next.
          </p>
        </div>
        <button
          type="button"
          disabled={!canCreate}
          onClick={create}
          className="rounded bg-[#4da3ff] px-3 py-2 text-sm font-semibold text-[#0b0e13] transition-colors hover:bg-[#6fb5ff] disabled:opacity-50"
        >
          Create
        </button>
      </header>

      <label className="flex flex-col gap-1 text-xs text-[#8d9bb0]">
        Name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Summer Series"
          className="rounded border border-[#2b3543] bg-[#0b0e13] px-2 py-2 text-sm text-[#e6ebf2] outline-none focus:border-[#4da3ff]"
        />
      </label>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-[#8d9bb0]">
          Scoring
          <select
            value={scoring}
            onChange={(event) => setScoring(event.target.value as ScoringMode)}
            className="rounded border border-[#2b3543] bg-[#0b0e13] px-2 py-2 text-sm text-[#e6ebf2] outline-none focus:border-[#4da3ff]"
          >
            <option value="time">Time — lowest total time wins</option>
            <option value="points">Points — points table each leg</option>
            <option value="hybrid">Hybrid — time, points break ties</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[#8d9bb0]">
          Grid order (every leg)
          <select
            value={gridOrder}
            onChange={(event) => setGridOrder(event.target.value as GridOrder)}
            className="rounded border border-[#2b3543] bg-[#0b0e13] px-2 py-2 text-sm text-[#e6ebf2] outline-none focus:border-[#4da3ff]"
          >
            <option value="random">Random</option>
            <option value="by-skill">By skill</option>
            <option value="reverse-skill">Reverse skill</option>
          </select>
        </label>
      </section>

      {scoring !== 'time' ? (
        <section className="flex flex-col gap-2 rounded-lg border border-[#2b3543] bg-[#161b24] p-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[#8d9bb0]">
            Points table
          </h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-[#8d9bb0]">
              Preset
              <select
                value={pointsPreset}
                onChange={(event) => {
                  const preset = event.target.value as PointsPreset;
                  setPointsPreset(preset);
                  if (preset === 'custom') {
                    setCustomPoints(resolvePointsTable('f1', '', finisherFloor, roster.length).perPosition.join(', '));
                  }
                }}
                className="rounded border border-[#2b3543] bg-[#0b0e13] px-2 py-1.5 text-sm text-[#e6ebf2] outline-none focus:border-[#4da3ff]"
              >
                <option value="f1">F1 top ten (25-18-15…)</option>
                <option value="linear">Linear (every finisher scores)</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            <label className="flex w-28 flex-col gap-1 text-xs text-[#8d9bb0]">
              Below table
              <input
                type="number"
                min={0}
                max={50}
                value={finisherFloor}
                onChange={(event) => setFinisherFloor(Math.max(0, Math.round(Number(event.target.value))))}
                className="rounded border border-[#2b3543] bg-[#0b0e13] px-2 py-1.5 text-sm text-[#e6ebf2] outline-none focus:border-[#4da3ff]"
              />
            </label>
          </div>
          {pointsPreset === 'custom' ? (
            <label className="flex flex-col gap-1 text-xs text-[#8d9bb0]">
              Points by position (comma separated, first = winner)
              <input
                value={customPoints}
                onChange={(event) => setCustomPoints(event.target.value)}
                className="rounded border border-[#2b3543] bg-[#0b0e13] px-2 py-1.5 font-mono text-sm text-[#e6ebf2] outline-none focus:border-[#4da3ff]"
              />
            </label>
          ) : (
            <p className="text-[11px] tabular-nums text-[#8d9bb0]">
              {pointsTable.perPosition.join(' · ')}
              {finisherFloor > 0 ? ` · then ${finisherFloor} each` : ''}
            </p>
          )}
        </section>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={tour}
          onChange={(event) => setTour(event.target.checked)}
          className="h-4 w-4 accent-[#4da3ff]"
        />
        <span>
          Tour — each leg starts where the last finished
          <span className="ml-1 text-xs text-[#8d9bb0]">(continuity is checked, not enforced)</span>
        </span>
      </label>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[#8d9bb0]">
            Field · {roster.length}
          </h2>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-[#8d9bb0]">
              Size
              <input
                type="number"
                min={MIN_FIELD}
                max={MAX_FIELD}
                value={roster.length}
                onChange={(event) => setFieldSize(Number(event.target.value))}
                className="w-16 rounded border border-[#2b3543] bg-[#0b0e13] px-2 py-1 text-sm text-[#e6ebf2] outline-none focus:border-[#4da3ff]"
              />
            </label>
            <button
              type="button"
              onClick={() => setRoster((current) => makeField(current.length, randomSeed()))}
              className="rounded bg-[#1f2632] px-2.5 py-1 text-xs transition-colors hover:bg-[#2b3543]"
            >
              Randomize
            </button>
          </div>
        </div>
        <RosterTable roster={roster} palette={palette} onChange={updateRacer} />
      </section>
    </div>
  );
};

/**
 * Resolve the editor state into a points table.
 *
 * `linear` tracks the field size — every finisher scores, so its length is the
 * field. `custom` is parsed leniently: anything that is not a non-negative
 * number is dropped, so a half-typed list never produces `NaN` points.
 */
const resolvePointsTable = (
  preset: PointsPreset,
  custom: string,
  finisherFloor: number,
  fieldSize: number,
): PointsTable => {
  if (preset === 'f1') return { ...F1_POINTS_TABLE, finisherFloor };
  if (preset === 'linear') return { ...linearPointsTable(fieldSize), finisherFloor };
  const perPosition = custom
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return { perPosition, finisherFloor };
};

/**
 * A fresh field, the same shape race setup uses: names generated, skills spread
 * evenly rather than drawn at random so the field is not four racers within a
 * percent of each other, personalities drawn from the archetypes.
 */
const makeField = (count: number, seed: string, startIndex = 0): RosterEntry[] => {
  const rng = createRng(seed);
  const names = generateRacerNames(count, rng.fork('names'));
  const skillRng = rng.fork('skills');
  return Array.from({ length: count }, (_, i) => {
    const spread = count === 1 ? 0.5 : i / (count - 1);
    return {
      id: `r${String(startIndex + i + 1).padStart(2, '0')}`,
      name: names[i] ?? `Racer ${startIndex + i + 1}`,
      personality: ARCHETYPES[skillRng.int(ARCHETYPES.length)]?.id ?? 'metronome',
      skill: Number((0.5 + spread * 0.45).toFixed(2)),
    };
  });
};

/** Seed picker only — not part of any simulation, so `Math.random` is fine here. */
const randomSeed = (): string => Math.random().toString(36).slice(2, 10);
