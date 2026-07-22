import type { RacerId } from '@anywhererace/core';
import type { RacerSegmentTimes, SegmentTiming } from './types';

/**
 * How long each racer took through each stretch of road.
 *
 * The one thing only the sim can answer. The event log records moments, not
 * elapsed time per meter, and the recorded frames the worker keeps for scrubbing
 * are downsampled and capped — so anything derived from them would quietly get
 * coarser on exactly the long races where this is most interesting. The tick
 * loop sees every racer move every 50ms, so it does the accounting.
 *
 * This is pure bookkeeping. It touches no `Rng`, nothing in the tick reads it
 * back, and deleting it would not change a single finishing time — which is
 * also why it cannot move the determinism goldens. It is not in the result hash
 * for the same reason.
 */

export const SEGMENT_RESOLUTION = {
  /**
   * Meters per band, aimed for. Long enough that a racer's time through one is
   * not dominated by tick quantization — at racing speed a 50ms tick covers a
   * few meters, so a hundred-meter band averages dozens of them — and short
   * enough to point at one corner or one ramp rather than a third of the lap.
   */
  targetLengthM: 100,
  /** A short circuit still needs enough bands to read as a map, not a bar chart. */
  minCount: 24,
  /** And a 40km point-to-point does not need four hundred. */
  maxCount: 240,
} as const;

/** Bands for a lap of this length, at the resolution above. */
export const segmentCountFor = (lapLengthM: number): number => {
  const wanted = Math.round(lapLengthM / SEGMENT_RESOLUTION.targetLengthM);
  return Math.min(
    SEGMENT_RESOLUTION.maxCount,
    Math.max(SEGMENT_RESOLUTION.minCount, wanted),
  );
};

type OpenBand = {
  segment: number;
  pendingS: number;
  /**
   * Whether this racer entered the band at its start rather than being dropped
   * into the middle of it. A grid slot sits wherever it sits, so the first band
   * of the race is a partial traversal and must not be averaged in with the
   * complete ones.
   */
  clean: boolean;
};

export class SegmentTimer {
  readonly segmentLengthM: number;
  readonly segmentCount: number;

  private readonly totals = new Map<RacerId, number[]>();
  private readonly passes = new Map<RacerId, number[]>();
  private readonly open = new Map<RacerId, OpenBand>();

  constructor(
    private readonly lapLengthM: number,
    private readonly racerIds: readonly RacerId[],
  ) {
    this.segmentCount = segmentCountFor(lapLengthM);
    this.segmentLengthM = lapLengthM / this.segmentCount;
    for (const id of racerIds) {
      this.totals.set(id, new Array<number>(this.segmentCount).fill(0));
      this.passes.set(id, new Array<number>(this.segmentCount).fill(0));
    }
  }

  /**
   * Book one tick of travel.
   *
   * A tick covers at most a handful of meters — the fastest class in the data
   * does about 5m in 50ms — and the shortest band is tens of meters, so a tick
   * can cross at most one boundary. That is what lets this split the tick in
   * two rather than walk a loop, and it is the one assumption here worth
   * knowing about if a 700kph vehicle class is ever added.
   */
  record(racerId: RacerId, fromM: number, toM: number, dtS: number): void {
    const state = this.stateFor(racerId, fromM);
    const travelledM = toM - fromM;

    // Stopped, or gone backwards after an incident. Either way the time belongs
    // to the band they are sitting in.
    if (travelledM <= 0) {
      state.pendingS += dtS;
      return;
    }

    const arrived = this.indexAt(toM);
    if (arrived === state.segment) {
      state.pendingS += dtS;
      return;
    }

    // Split the tick where it crossed the line: the part before belongs to the
    // band being left, and completes it.
    const toBoundaryM = this.distanceToBandEnd(fromM);
    const beforeS = dtS * Math.min(1, Math.max(0, toBoundaryM / travelledM));
    state.pendingS += beforeS;
    this.commit(racerId, state);

    state.segment = arrived;
    state.pendingS = dtS - beforeS;
    state.clean = true;
  }

  build(): SegmentTiming {
    const perRacer: RacerSegmentTimes[] = this.racerIds.map((racerId) => ({
      racerId,
      totalS: this.totals.get(racerId) ?? [],
      passes: this.passes.get(racerId) ?? [],
    }));
    return {
      segmentLengthM: this.segmentLengthM,
      segmentCount: this.segmentCount,
      perRacer,
    };
  }

  private stateFor(racerId: RacerId, atM: number): OpenBand {
    const existing = this.open.get(racerId);
    if (existing !== undefined) return existing;
    // First sighting. Whatever band they are in was entered before we were
    // watching, so it does not count.
    const fresh: OpenBand = { segment: this.indexAt(atM), pendingS: 0, clean: false };
    this.open.set(racerId, fresh);
    return fresh;
  }

  /**
   * Bank a completed traversal. A band left without having been entered cleanly
   * is dropped rather than averaged in — as is whatever is still pending when
   * the race ends, since a racer who stops mid-band never finished it.
   */
  private commit(racerId: RacerId, state: OpenBand): void {
    if (!state.clean) return;
    const totals = this.totals.get(racerId);
    const passes = this.passes.get(racerId);
    if (totals === undefined || passes === undefined) return;
    totals[state.segment] = (totals[state.segment] ?? 0) + state.pendingS;
    passes[state.segment] = (passes[state.segment] ?? 0) + 1;
  }

  /** Which band a cumulative route distance falls in, folded back onto one lap. */
  private indexAt(distanceM: number): number {
    const lapRelM = this.lapRelative(distanceM);
    return Math.min(this.segmentCount - 1, Math.floor(lapRelM / this.segmentLengthM));
  }

  /** Meters from here to the end of the band this position is in. */
  private distanceToBandEnd(distanceM: number): number {
    const lapRelM = this.lapRelative(distanceM);
    return this.segmentLengthM - (lapRelM % this.segmentLengthM);
  }

  private lapRelative(distanceM: number): number {
    if (this.lapLengthM <= 0) return 0;
    return ((distanceM % this.lapLengthM) + this.lapLengthM) % this.lapLengthM;
  }
}
