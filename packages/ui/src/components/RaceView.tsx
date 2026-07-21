import { useState } from 'react';
import type { Track } from '@anywhererace/core';
import type { DebugToggles, RaceConfig, RaceResult } from '@anywhererace/sim';
import { getVehicleClass } from '@anywhererace/sim';
import { EventFeed } from './EventFeed';
import { PlaybackControls } from './PlaybackControls';
import { RaceMap } from './RaceMap';
import { TimingTower } from './TimingTower';
import { ResultsPanel } from './results/ResultsPanel';
import { useRaceClient } from '../useRaceClient';

/**
 * The race view: map, timing tower, event feed, transport controls.
 *
 * Layout is map-dominant with everything else floating over it. The map is the
 * spectacle and gets the whole viewport; the panels are translucent so the
 * track underneath stays visible, and they sit in a `pointer-events-none`
 * overlay so only the controls themselves intercept clicks — dragging the map
 * behind a panel still works.
 */

export type RaceViewProps = {
  track: Track;
  config: RaceConfig;
  toggles?: Partial<DebugToggles>;
  createWorker: () => Worker;
  styleUrl: string;
  attribution: string;
  /** Rendered above the timing tower — race name, vehicle class, weather. */
  header?: React.ReactNode;
  /** Rendered in the results header, for saving or sharing the race. */
  resultActions?: (result: RaceResult) => React.ReactNode;
  /** Track name, shown in the results header and used in the narrative. */
  trackName?: string;
  /**
   * Set when replaying a saved race. The replay is checked against what it was
   * saved with, and any disagreement is shown rather than hidden — CLAUDE.md is
   * explicit that a version mismatch still plays, but honestly.
   */
  savedAs?: { resultHash: string; simVersion: string } | undefined;
};

/** Ticks per simulated second. Mirrors SIM_HZ; the worker confirms it on ready. */
const SIM_HZ = 20;

export const RaceView = ({
  track,
  config,
  toggles,
  createWorker,
  styleUrl,
  attribution,
  header,
  resultActions,
  trackName,
  savedAs,
}: RaceViewProps) => {
  // Results open themselves when the flag falls, but dismissing them returns to
  // the finished race with its scrubber intact rather than closing anything —
  // so a chart can send you back to the lap it was describing.
  const [resultsDismissed, setResultsDismissed] = useState(false);
  const race = useRaceClient({
    track,
    config,
    ...(toggles ? { toggles } : {}),
    createWorker,
  });

  if (race.status === 'error') {
    return (
      <div className="flex h-full items-center justify-center bg-[#0b0e13] p-8">
        <div className="max-w-md rounded-lg border border-[#ff5c5c]/40 bg-[#161b24] p-5">
          <h2 className="mb-2 text-lg font-semibold text-[#ff5c5c]">This race could not start</h2>
          <p className="text-sm text-[#8d9bb0]">
            {race.error?.message ?? 'The simulation worker failed.'}
          </p>
        </div>
      </div>
    );
  }

  const totalLaps = track.mode === 'circuit' ? config.laps : 1;
  // How this race should be narrated. v1 runs one class for the whole field, so
  // the class settles it — see `RaceFormat`. An unknown class would already have
  // failed the race setup, so falling back to 'standard' only ever means
  // "show everything", which is the safe way to be wrong.
  const format = getVehicleClass(config.vehicleClassId)?.raceFormat ?? 'standard';

  return (
    <div className="relative h-full w-full bg-[#0b0e13]">
      <RaceMap
        track={track}
        racers={race.racers}
        frameRef={race.frameRef}
        styleUrl={styleUrl}
        attribution={attribution}
      />

      {/* Overlay. Ignores pointer events so the map stays draggable underneath;
          individual panels opt back in. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="pointer-events-auto flex flex-col gap-3">
            {header}
            <TimingTower
              snapshot={race.snapshot}
              racers={race.racers}
              racersById={race.racersById}
              totalLaps={totalLaps}
              lapLengthM={track.lengthMeters}
              result={race.result}
            />
          </div>

          <div className="pointer-events-auto">
            <EventFeed events={race.feed} racersById={race.racersById} format={format} />
          </div>
        </div>

        <div className="flex justify-center">
          <PlaybackControls
            speed={race.speed}
            finished={race.status === 'finished'}
            elapsedS={race.snapshot?.elapsedS ?? 0}
            progress={race.progress}
            recordedTicks={race.recordedTicks}
            currentTick={race.snapshot?.tick ?? 0}
            simHz={SIM_HZ}
            onPlay={race.controls.play}
            onPause={race.controls.pause}
            onSkipToEnd={race.controls.skipToEnd}
            onSeek={race.controls.seek}
          />
        </div>
      </div>

      {race.status === 'finished' && race.result !== undefined && resultsDismissed ? (
        <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
          <button
            type="button"
            onClick={() => setResultsDismissed(false)}
            className="pointer-events-auto rounded-lg border border-[#2b3543] bg-[#161b24]/95 px-4 py-2 text-sm backdrop-blur transition-colors hover:bg-[#1f2632]"
          >
            <span className="text-[#8d9bb0]">Winner </span>
            <span className="font-semibold text-[#e6ebf2]">
              {race.racersById.get(race.result.finishers[0]?.racerId ?? '')?.name ?? '—'}
            </span>
            <span className="ml-3 border-l border-[#2b3543] pl-3 text-[10px] uppercase tracking-wider text-[#8d9bb0]">
              See results
            </span>
          </button>
        </div>
      ) : null}

      {race.status === 'finished' && race.result !== undefined && !resultsDismissed ? (
        <ResultsPanel
          result={race.result}
          events={race.events}
          racers={race.racers}
          racersById={race.racersById}
          trackName={trackName ?? track.name}
          onDismiss={() => setResultsDismissed(true)}
          actions={resultActions?.(race.result)}
          versionMismatch={
            savedAs !== undefined && savedAs.resultHash !== race.result.resultHash
              ? { savedWith: savedAs.simVersion, runningOn: race.result.simVersion }
              : undefined
          }
        />
      ) : null}
    </div>
  );
};
