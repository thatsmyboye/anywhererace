import type { RacerId } from '@anywhererace/core';
import type { LapEvent, RaceEvent, SectorEvent } from './events';
import { eventsOfType } from './events';
import type { FinishRecord, RaceResult, RacerStatus, SegmentTiming } from './types';

/**
 * Reading a race back out of its event log.
 *
 * All of this is derived, never stored. The log already carries every fact
 * these functions need, and deriving on demand means a chart can never drift
 * out of step with the race it is describing — which is exactly what would
 * happen if the sim wrote a parallel summary as it went.
 *
 * Pure and headless, like the rest of `packages/sim`: no DOM, no charting
 * library, no formatting. The UI decides how any of this looks.
 */

// --- lap chart --------------------------------------------------------------

export type LapChartRow = {
  racerId: RacerId;
  /** Lap times in order. `undefined` where the racer did not complete that lap. */
  laps: (number | undefined)[];
  bestLapS: number | undefined;
};

export type LapChart = {
  /** 1-based lap numbers covering the longest run in the field. */
  lapNumbers: number[];
  rows: LapChartRow[];
  /** Fastest lap of the race, and who set it. */
  fastest: { racerId: RacerId; lap: number; timeS: number } | undefined;
};

export const buildLapChart = (result: RaceResult): LapChart => {
  const maxLap = Math.max(0, ...result.finishers.map((f) => f.laps.length));
  const lapNumbers = Array.from({ length: maxLap }, (_, i) => i + 1);

  let fastest: LapChart['fastest'];
  const rows = result.finishers.map((finisher): LapChartRow => {
    const byLap = new Map(finisher.laps.map((lap) => [lap.lap, lap.timeS]));
    for (const lap of finisher.laps) {
      if (fastest === undefined || lap.timeS < fastest.timeS) {
        fastest = { racerId: finisher.racerId, lap: lap.lap, timeS: lap.timeS };
      }
    }
    return {
      racerId: finisher.racerId,
      laps: lapNumbers.map((lap) => byLap.get(lap)),
      ...(finisher.bestLapS === undefined ? {} : { bestLapS: finisher.bestLapS }),
    } as LapChartRow;
  });

  return { lapNumbers, rows, fastest };
};

// --- position over time -----------------------------------------------------

export type PositionPoint = {
  /** 0 is the grid; 1 upwards is the position after completing that lap. */
  lap: number;
  position: number;
};

export type PositionChart = {
  lapNumbers: number[];
  series: { racerId: RacerId; points: PositionPoint[] }[];
  fieldSize: number;
};

/**
 * Position at each lap crossing.
 *
 * Built from lap events rather than from tick snapshots: a racer's position is
 * only unambiguous at a timing line, and sampling positions mid-lap would show
 * a car "leading" simply because it happens to be further round the loop than
 * someone a lap ahead of it.
 *
 * Lap 0 is the grid, so a line starts where the racer actually started rather
 * than appearing from nowhere after the first lap.
 */
export const buildPositionChart = (
  events: readonly RaceEvent[],
  result: RaceResult,
): PositionChart => {
  const lapEvents = eventsOfType(events, 'lap');
  const grid = eventsOfType(events, 'race-start')[0]?.grid ?? [];
  const fieldSize = result.finishers.length;

  const points = new Map<RacerId, PositionPoint[]>();
  for (const [index, racerId] of grid.entries()) {
    points.set(racerId, [{ lap: 0, position: index + 1 }]);
  }
  // A racer missing from the grid event still deserves a series.
  for (const finisher of result.finishers) {
    if (!points.has(finisher.racerId)) points.set(finisher.racerId, []);
  }

  const byLap = new Map<number, LapEvent[]>();
  for (const event of lapEvents) {
    const bucket = byLap.get(event.lap);
    if (bucket === undefined) byLap.set(event.lap, [event]);
    else bucket.push(event);
  }

  const lapNumbers = [...byLap.keys()].sort((a, b) => a - b);
  for (const lap of lapNumbers) {
    // Whoever crossed the line first is leading it. Ties break on racer id so
    // the chart is reproducible rather than at the mercy of sort stability.
    const crossings = (byLap.get(lap) ?? [])
      .slice()
      .sort((a, b) => a.atS - b.atS || (a.racerId < b.racerId ? -1 : 1));

    crossings.forEach((event, index) => {
      points.get(event.racerId)?.push({ lap, position: index + 1 });
    });
  }

  return {
    lapNumbers: [0, ...lapNumbers],
    series: [...points.entries()].map(([racerId, series]) => ({ racerId, points: series })),
    fieldSize,
  };
};

// --- sectors ----------------------------------------------------------------

export type SectorBest = {
  sector: number;
  racerId: RacerId;
  timeS: number;
  lap: number;
};

export type SectorSummary = {
  /** Fastest time in each sector, and who set it. */
  bests: SectorBest[];
  /**
   * The sum of the fastest sectors, which is usually quicker than anyone's
   * actual best lap — the "ideal lap" nobody drove.
   */
  idealLapS: number | undefined;
  /** Per racer, their own best in each sector. */
  personalBests: Map<RacerId, (number | undefined)[]>;
};

export const buildSectorSummary = (events: readonly RaceEvent[]): SectorSummary => {
  const sectorEvents = eventsOfType(events, 'sector');
  const bests = new Map<number, SectorBest>();
  const personalBests = new Map<RacerId, (number | undefined)[]>();

  for (const event of sectorEvents) {
    const current = bests.get(event.sector);
    if (current === undefined || event.timeS < current.timeS) {
      bests.set(event.sector, {
        sector: event.sector,
        racerId: event.racerId,
        timeS: event.timeS,
        lap: event.lap,
      });
    }

    const personal = personalBests.get(event.racerId) ?? [];
    const existing = personal[event.sector];
    if (existing === undefined || event.timeS < existing) personal[event.sector] = event.timeS;
    personalBests.set(event.racerId, personal);
  }

  const ordered = [...bests.values()].sort((a, b) => a.sector - b.sector);
  return {
    bests: ordered,
    idealLapS:
      ordered.length === 0 ? undefined : ordered.reduce((total, best) => total + best.timeS, 0),
    personalBests,
  };
};

// --- incidents --------------------------------------------------------------

export type IncidentKind = 'lockup' | 'spin' | 'crash' | 'mechanical' | 'failed-pass';

export type Incident = {
  atS: number;
  tick: number;
  racerId: RacerId;
  kind: IncidentKind;
  /** Seconds lost. Undefined for a retirement, where the loss is the race. */
  timeLostS?: number;
  lap?: number;
  /** True where the incident came out of an overtake attempt. */
  fromPassAttempt: boolean;
  /** True where the incident ended the racer's race. */
  terminal: boolean;
};

/**
 * Every incident, in order.
 *
 * Failed passes are included but marked as such: on a narrow track they are the
 * whole story of someone's race, and leaving them out would make a timeline
 * that says "nothing happened" for a racer who spent ten minutes trying to get
 * past the same car.
 */
export const buildIncidentTimeline = (events: readonly RaceEvent[]): Incident[] => {
  const incidents: Incident[] = [];

  for (const event of events) {
    switch (event.type) {
      case 'mistake':
        incidents.push({
          atS: event.atS,
          tick: event.tick,
          racerId: event.racerId,
          kind: event.kind,
          timeLostS: event.timeLostS,
          fromPassAttempt: event.causedByPassAttempt,
          terminal: false,
        });
        break;
      case 'crash':
        incidents.push({
          atS: event.atS,
          tick: event.tick,
          racerId: event.racerId,
          kind: 'crash',
          lap: event.lap,
          fromPassAttempt: false,
          terminal: true,
        });
        break;
      case 'mechanical':
        incidents.push({
          atS: event.atS,
          tick: event.tick,
          racerId: event.racerId,
          kind: 'mechanical',
          lap: event.lap,
          fromPassAttempt: false,
          terminal: true,
        });
        break;
      case 'failed-pass':
        incidents.push({
          atS: event.atS,
          tick: event.tick,
          racerId: event.racerId,
          kind: 'failed-pass',
          timeLostS: event.timeLostS,
          fromPassAttempt: true,
          terminal: false,
        });
        break;
      default:
        break;
    }
  }

  return incidents.sort((a, b) => a.tick - b.tick);
};

// --- where a racer gained and lost ------------------------------------------

export type SegmentHeatBand = {
  /** Meters along the lap. Lap-relative, so it is the same road on every lap. */
  startM: number;
  endM: number;
  /**
   * Seconds this racer lost against the field through this stretch, per lap of
   * it. Negative means they gained. Zero means they were the field.
   */
  deltaS: number;
};

export type SegmentHeat = {
  racerId: RacerId;
  bands: SegmentHeatBand[];
  /**
   * The largest `|deltaS|` present, so a color ramp can be scaled to this race
   * rather than to an absolute scale that would render a close race blank and a
   * processional one saturated end to end.
   */
  peakS: number;
};

/**
 * Where one racer gained and lost time against the field.
 *
 * The reference is the **median** of every racer's mean time through the band,
 * not the mean of it. One rider crawling through a corner after a spin would
 * drag a mean far enough to paint that corner slow for everybody else, which is
 * precisely backwards: their mistake was theirs, not the road's.
 *
 * Bands the racer never rode end to end are absent rather than zero. A retired
 * racer has nothing to say about the half of the lap they never reached, and
 * drawing that as "level with the field" would be a claim the data cannot make.
 */
export const buildSegmentHeat = (
  timing: SegmentTiming,
  racerId: RacerId,
): SegmentHeat | undefined => {
  const mine = timing.perRacer.find((entry) => entry.racerId === racerId);
  if (mine === undefined) return undefined;

  const bands: SegmentHeatBand[] = [];
  let peakS = 0;

  for (let index = 0; index < timing.segmentCount; index++) {
    const passes = mine.passes[index] ?? 0;
    if (passes === 0) continue;

    const reference = medianBandTime(timing, index);
    if (reference === undefined) continue;

    const deltaS = (mine.totalS[index] ?? 0) / passes - reference;
    if (Math.abs(deltaS) > peakS) peakS = Math.abs(deltaS);
    bands.push({
      startM: index * timing.segmentLengthM,
      endM: (index + 1) * timing.segmentLengthM,
      deltaS,
    });
  }

  return { racerId, bands, peakS };
};

/** Median of every racer's mean time through one band. Undefined if nobody rode it. */
const medianBandTime = (timing: SegmentTiming, index: number): number | undefined => {
  const means: number[] = [];
  for (const entry of timing.perRacer) {
    const passes = entry.passes[index] ?? 0;
    if (passes === 0) continue;
    means.push((entry.totalS[index] ?? 0) / passes);
  }
  if (means.length === 0) return undefined;

  means.sort((a, b) => a - b);
  const middle = Math.floor(means.length / 2);
  return means.length % 2 === 1
    ? (means[middle] as number)
    : ((means[middle - 1] as number) + (means[middle] as number)) / 2;
};

// --- helpers the UI and the narrative both want -----------------------------

export const isRetirement = (status: RacerStatus): boolean =>
  status === 'dnf-crash' || status === 'dnf-mechanical' || status === 'dnf-timeout';

/** Places gained from the grid. Negative means places lost. */
export const placesGained = (
  finisher: FinishRecord,
  grid: readonly RacerId[],
): number | undefined => {
  const gridSlot = grid.indexOf(finisher.racerId);
  return gridSlot < 0 ? undefined : gridSlot + 1 - finisher.position;
};

export const sectorTimesForLap = (
  events: readonly RaceEvent[],
  racerId: RacerId,
  lap: number,
): SectorEvent[] =>
  eventsOfType(events, 'sector')
    .filter((event) => event.racerId === racerId && event.lap === lap)
    .sort((a, b) => a.sector - b.sector);
