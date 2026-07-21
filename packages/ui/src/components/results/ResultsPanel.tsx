import { useMemo } from 'react';
import { formatDurationS } from '@anywhererace/core';
import type { RaceEvent, RaceResult } from '@anywhererace/sim';
import {
  buildIncidentTimeline,
  buildLapChart,
  buildNarrative,
  buildPositionChart,
  buildSectorSummary,
  isRetirement,
} from '@anywhererace/sim';
import type { Incident } from '@anywhererace/sim';
import type { RacerView } from '../../useRaceClient';
import { PatternSwatch } from '../PatternSwatch';
import { LapTimes, PositionOverTime } from './RaceCharts';

/**
 * The results.
 *
 * A panel over the finished race rather than a separate screen, so the scrubber
 * survives underneath: read a chart, dismiss, and scrub to the lap it was
 * telling you about. Everything here is derived from the event log on the fly —
 * nothing is stored, so a chart can never disagree with the race it describes.
 *
 * Order is classification, then the story, then the charts. Who won is what
 * everyone looks at first, and leading with prose buries it.
 */

export type ResultsPanelProps = {
  result: RaceResult;
  events: readonly RaceEvent[];
  racers: readonly RacerView[];
  racersById: ReadonlyMap<string, RacerView>;
  trackName: string;
  onDismiss: () => void;
  /** Rendered in the header — a save button, a share link later. */
  actions?: React.ReactNode;
  /**
   * Set when a saved race was re-simulated and no longer matches the result it
   * was saved with. CLAUDE.md is explicit: still play it, but say so.
   */
  versionMismatch?: { savedWith: string; runningOn: string } | undefined;
};

export const ResultsPanel = ({
  result,
  events,
  racers,
  racersById,
  trackName,
  onDismiss,
  actions,
  versionMismatch,
}: ResultsPanelProps) => {
  const names = useMemo(
    () => new Map(racers.map((racer) => [racer.racerId, racer.name])),
    [racers],
  );

  const narrative = useMemo(
    () => buildNarrative({ result, events, names, trackName }),
    [result, events, names, trackName],
  );
  const lapChart = useMemo(() => buildLapChart(result), [result]);
  const positionChart = useMemo(() => buildPositionChart(events, result), [events, result]);
  const sectors = useMemo(() => buildSectorSummary(events), [events]);
  const incidents = useMemo(() => buildIncidentTimeline(events), [events]);

  const name = (id: string): string => names.get(id) ?? id;

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-[#0b0e13]/95 backdrop-blur">
      <header className="flex shrink-0 items-center gap-3 border-b border-[#2b3543] px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-[#e6ebf2]">Results</h2>
          <p className="truncate text-xs text-[#8d9bb0]">
            {trackName}
            <span className="mx-1.5 text-[#2b3543]">·</span>
            {formatDurationS(result.durationS, 0)}
            <span className="mx-1.5 text-[#2b3543]">·</span>
            <span className="font-mono">{result.resultHash.slice(0, 8)}</span>
          </p>
        </div>
        {actions}
        <button
          type="button"
          onClick={onDismiss}
          className="rounded border border-[#2b3543] bg-[#1f2632] px-3 py-1.5 text-sm text-[#e6ebf2] transition-colors hover:bg-[#2b3543]"
        >
          Back to the race
        </button>
      </header>

      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 overflow-y-auto p-5">
        {versionMismatch === undefined ? null : (
          <p className="rounded border border-[#ffb020]/40 bg-[#ffb020]/10 px-3 py-2 text-xs leading-snug text-[#ffb020]">
            This race was created with simulation version {versionMismatch.savedWith}; you are
            running {versionMismatch.runningOn}. It has been replayed with the current physics, so
            the result below may differ from the one it was saved with.
          </p>
        )}

        <Classification result={result} racersById={racersById} />

        <section className="flex flex-col gap-1">
          <h3 className={sectionHeading}>Race report</h3>
          <div className="rounded-lg border border-[#2b3543] bg-[#161b24] p-4">
            <p className="mb-2 text-sm font-semibold text-[#e6ebf2]">{narrative.headline}</p>
            <p className="text-sm leading-relaxed text-[#8d9bb0]">
              {narrative.beats
                .filter((beat) => beat.kind !== 'headline')
                .map((beat) => beat.text)
                .join(' ')}
            </p>
          </div>
        </section>

        <PositionOverTime chart={positionChart} racers={racersById} />
        <LapTimes chart={lapChart} racers={racersById} />

        {sectors.bests.length === 0 ? null : (
          <section className="flex flex-col gap-1">
            <h3 className={sectionHeading}>Sector bests</h3>
            <div className="flex flex-wrap gap-2">
              {sectors.bests.map((best) => (
                <div
                  key={best.sector}
                  className="flex-1 rounded-lg border border-[#2b3543] bg-[#161b24] px-3 py-2"
                >
                  <p className="text-[11px] uppercase tracking-wide text-[#8d9bb0]">
                    Sector {best.sector + 1}
                  </p>
                  <p className="text-sm tabular-nums text-[#3ddc97]">
                    {formatDurationS(best.timeS, 2)}
                  </p>
                  <p className="truncate text-xs text-[#8d9bb0]">{name(best.racerId)}</p>
                </div>
              ))}
              {sectors.idealLapS === undefined ? null : (
                <div className="flex-1 rounded-lg border border-dashed border-[#2b3543] px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-[#8d9bb0]">Ideal lap</p>
                  <p className="text-sm tabular-nums text-[#e6ebf2]">
                    {formatDurationS(sectors.idealLapS, 2)}
                  </p>
                  <p className="text-xs text-[#8d9bb0]">Nobody drove it</p>
                </div>
              )}
            </div>
          </section>
        )}

        <IncidentTimeline incidents={incidents} name={name} />
      </div>
    </div>
  );
};

const Classification = ({
  result,
  racersById,
}: {
  result: RaceResult;
  racersById: ReadonlyMap<string, RacerView>;
}) => (
  <section className="flex flex-col gap-1">
    <h3 className={sectionHeading}>Classification</h3>
    <div className="overflow-hidden rounded-lg border border-[#2b3543]">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-[#2b3543] bg-[#1f2632] text-left text-[11px] uppercase tracking-wide text-[#8d9bb0]">
            <th className="w-10 px-2 py-1.5 font-semibold">Pos</th>
            <th className="px-2 py-1.5 font-semibold">Racer</th>
            <th className="w-28 px-2 py-1.5 text-right font-semibold">Time</th>
            <th className="w-24 px-2 py-1.5 text-right font-semibold">Gap</th>
            <th className="w-24 px-2 py-1.5 text-right font-semibold">Best lap</th>
          </tr>
        </thead>
        <tbody>
          {result.finishers.map((finisher) => {
            const racer = racersById.get(finisher.racerId);
            const retired = isRetirement(finisher.status);
            return (
              <tr
                key={finisher.racerId}
                className={`border-b border-[#2b3543]/50 last:border-b-0 ${retired ? 'opacity-50' : ''}`}
              >
                <td className="px-2 py-1 tabular-nums text-[#8d9bb0]">{finisher.position}</td>
                <td className="px-2 py-1">
                  <span className="flex items-center gap-2">
                    {racer === undefined ? null : (
                      <PatternSwatch appearance={racer.appearance} label={String(racer.number)} />
                    )}
                    <span className="truncate text-[#e6ebf2]">
                      {racer?.name ?? finisher.racerId}
                    </span>
                  </span>
                </td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {finisher.totalTimeS === undefined ? (
                    <span className="text-[#ff5c5c]">
                      {finisher.status === 'dnf-crash'
                        ? 'Crash'
                        : finisher.status === 'dnf-timeout'
                          ? 'Timed out'
                          : 'Mechanical'}
                    </span>
                  ) : (
                    formatDurationS(finisher.totalTimeS)
                  )}
                </td>
                <td className="px-2 py-1 text-right tabular-nums text-[#8d9bb0]">
                  {finisher.gapToWinnerS === undefined
                    ? finisher.totalTimeS === undefined
                      ? `${finisher.lapsCompleted} laps`
                      : '—'
                    : `+${finisher.gapToWinnerS.toFixed(3)}`}
                </td>
                <td className="px-2 py-1 text-right tabular-nums text-[#8d9bb0]">
                  {finisher.bestLapS === undefined ? '—' : formatDurationS(finisher.bestLapS, 2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </section>
);

/**
 * The incident timeline.
 *
 * Failed passes are counted but not listed individually: on a narrow track
 * there can be hundreds, and a timeline that is 90% "tried a move, did not get
 * it" hides the handful of moments that actually decided the race.
 */
const IncidentTimeline = ({
  incidents,
  name,
}: {
  incidents: readonly Incident[];
  name: (id: string) => string;
}) => {
  const notable = incidents.filter((incident) => incident.kind !== 'failed-pass');
  const failedPasses = incidents.length - notable.length;

  return (
    <section className="flex flex-col gap-1">
      <h3 className={sectionHeading}>
        Incidents ({notable.length})
        {failedPasses === 0 ? null : (
          <span className="ml-2 font-normal normal-case tracking-normal text-[#8d9bb0]">
            plus {failedPasses} moves that did not come off
          </span>
        )}
      </h3>

      {notable.length === 0 ? (
        <p className="rounded-lg border border-[#2b3543] bg-[#161b24] px-3 py-2 text-sm text-[#8d9bb0]">
          A clean race.
        </p>
      ) : (
        <ol className="overflow-hidden rounded-lg border border-[#2b3543]">
          {notable.map((incident, index) => (
            <li
              key={`${incident.tick}-${incident.racerId}-${index}`}
              className="flex items-baseline gap-3 border-b border-[#2b3543]/50 bg-[#161b24] px-3 py-1.5 text-sm last:border-b-0"
            >
              <span className="w-14 shrink-0 tabular-nums text-xs text-[#8d9bb0]">
                {formatDurationS(incident.atS, 0)}
              </span>
              <span className={`w-20 shrink-0 text-xs font-semibold uppercase ${toneFor(incident)}`}>
                {LABELS[incident.kind]}
              </span>
              <span className="min-w-0 flex-1 truncate text-[#e6ebf2]">
                {name(incident.racerId)}
                {incident.fromPassAttempt ? (
                  <span className="text-[#8d9bb0]"> — after a move that was not there</span>
                ) : null}
              </span>
              <span className="shrink-0 tabular-nums text-xs text-[#8d9bb0]">
                {incident.terminal
                  ? `lap ${(incident.lap ?? 0) + 1}`
                  : `${incident.timeLostS?.toFixed(1) ?? '0.0'}s`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};

const LABELS: Record<Incident['kind'], string> = {
  lockup: 'Lock-up',
  spin: 'Spin',
  crash: 'Crash',
  mechanical: 'Mechanical',
  'failed-pass': 'Move',
};

const toneFor = (incident: Incident): string =>
  incident.terminal ? 'text-[#ff5c5c]' : incident.kind === 'spin' ? 'text-[#ffb020]' : 'text-[#8d9bb0]';

const sectionHeading = 'text-[11px] font-semibold uppercase tracking-wide text-[#8d9bb0]';
