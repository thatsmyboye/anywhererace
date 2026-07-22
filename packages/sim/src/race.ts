import type { Result } from '@anywhererace/core';
import { clamp01, conditionsAt, err, ok } from '@anywhererace/core';
import type { BunchMember } from './bunch';
import { SOLO_BUNCH, readBunch } from './bunch';
import type { RaceEvent } from './events';
import type { GroupMember } from './groups';
import { GroupTracker, classifyPass } from './groups';
import { hashResult } from './hash';
import type { TrackProfile, WindProfile } from './profile';
import { buildTrackProfile, buildWindProfile, windAt } from './profile';
import type { RaceSetup, RacerRuntime } from './setup';
import { prepareRace } from './setup';
import type { Traffic } from './tick';
import { tickRacer } from './tick';
import { ALL_TOGGLES_ON, SIM_HZ, TICK_SECONDS, TUNING } from './tuning';
import type {
  DebugToggles,
} from './tuning';
import type {
  FinishRecord,
  LapRecord,
  RaceInput,
  RaceResult,
  RaceSnapshot,
  RacerSnapshot,
  SimError,
} from './types';
import { SIM_VERSION } from './version';

/**
 * The race loop.
 *
 * "Watch live", "2x", and "skip to the end" are the same code path — they only
 * differ in how many times the host calls `step`. Nothing in here knows about
 * wall-clock time, and nothing in here can block: the caller decides the
 * granularity.
 */

/** Cooldown per pair, so two racers running side by side do not spam the log. */
const OVERTAKE_COOLDOWN_S = 1.5;

export interface RaceRunner {
  readonly setup: RaceSetup;
  readonly events: readonly RaceEvent[];
  readonly finished: boolean;
  readonly tick: number;
  readonly elapsedS: number;
  /** Advance the simulation. Returns true while the race is still running. */
  step(ticks?: number): boolean;
  /** Run to completion in a tight loop. This is "skip to end". */
  runToEnd(): Result<RaceResult, SimError>;
  snapshot(): RaceSnapshot;
  /** Result so far. Only meaningful once `finished` is true. */
  result(): Result<RaceResult, SimError>;
}

export const createRace = (input: RaceInput): Result<RaceRunner, SimError> => {
  const prepared = prepareRace(input);
  if (!prepared.ok) return prepared;
  return ok(new Race(prepared.value, { ...ALL_TOGGLES_ON, ...input.toggles }));
};

/** Convenience wrapper: prepare, run to the end, return the result. */
export const runRace = (input: RaceInput): Result<RaceResult, SimError> => {
  const created = createRace(input);
  if (!created.ok) return created;
  return created.value.runToEnd();
};

class Race implements RaceRunner {
  readonly setup: RaceSetup;
  readonly events: RaceEvent[] = [];

  private readonly profile: TrackProfile;
  private readonly wind: WindProfile;
  private readonly toggles: DebugToggles;
  private readonly mechanicalHazardPerTick: number;
  private readonly crashDnfChanceValue: number;
  private readonly lastPassS = new Map<string, number>();
  /**
   * The shape of the field as a commentator would call it. Pure observation —
   * it reads distances and speeds and emits events, and nothing in the tick
   * consults it, so it cannot affect a result.
   *
   * Not to be confused with `bunch.ts`, which answers the neighbouring question
   * — who is riding with whom *right now* — and which the tick does read. The
   * two are separate because this one is deliberately slow to believe a change
   * and the other one cannot afford to be. See both files.
   */
  private readonly groups = new GroupTracker();
  /** Last tick's ordering among racers still circulating, by racer id. */
  private previousRanks = new Map<string, number>();

  private currentTick = 0;
  private done = false;
  private leaderFinishedTick: number | undefined;
  private nextPosition = 1;
  private raceBestLapS: number | undefined;
  private raceBestSectorS: number[] = [];
  private endReason: 'all-classified' | 'timeout-after-leader' | 'hard-tick-cap' =
    'all-classified';

  constructor(setup: RaceSetup, toggles: DebugToggles) {
    this.setup = setup;
    this.toggles = toggles;
    this.profile = buildTrackProfile(setup.track, setup.vehicle);
    this.wind = buildWindProfile(setup.config.weather, setup.expectedDurationS);
    this.mechanicalHazardPerTick = mechanicalHazard(setup);
    this.crashDnfChanceValue = crashDnfChance(setup);

    this.events.push({
      type: 'race-start',
      tick: 0,
      atS: 0,
      grid: setup.racers.map((r) => r.spec.id),
    });
  }

  get finished(): boolean {
    return this.done;
  }

  get tick(): number {
    return this.currentTick;
  }

  get elapsedS(): number {
    return this.currentTick * TICK_SECONDS;
  }

  step(ticks = 1): boolean {
    for (let i = 0; i < ticks && !this.done; i++) this.stepOnce();
    return !this.done;
  }

  runToEnd(): Result<RaceResult, SimError> {
    while (!this.done) this.stepOnce();
    return this.result();
  }

  private stepOnce(): void {
    const elapsedS = this.elapsedS;
    const conditions = conditionsAt(this.setup.config.weather, elapsedS);
    const windVector = windAt(this.wind, elapsedS);

    // Ordering is snapshotted before anybody moves, so a racer's traffic
    // decision does not depend on whether the car ahead has already been
    // updated this tick. That keeps the tick order-independent.
    const ordering = this.orderField();
    const trafficByRacer = this.buildTraffic(ordering);
    // Who is riding with whom, as the tick needs it — re-read every tick, with
    // none of the lag `groups.ts` deliberately applies. Built from the same
    // pre-movement snapshot as the traffic map, for the same reason.
    const bunchByRacer = readBunch(bunchMembers(ordering));

    const ctx = {
      setup: this.setup,
      profile: this.profile,
      toggles: this.toggles,
      mechanicalHazardPerTick: this.mechanicalHazardPerTick,
      crashDnfChance: this.crashDnfChanceValue,
      ordering,
      conditions,
      windNorth: windVector.north,
      windEast: windVector.east,
      tick: this.currentTick,
      elapsedS,
      emit: (event: RaceEvent) => this.events.push(event),
    };

    const previousDistances = this.setup.racers.map((r) => r.distanceM);

    for (const racer of this.setup.racers) {
      tickRacer(
        racer,
        trafficByRacer.get(racer.spec.id),
        bunchByRacer.get(racer.spec.id) ?? SOLO_BUNCH,
        ctx,
      );
    }

    this.currentTick += 1;

    for (let i = 0; i < this.setup.racers.length; i++) {
      const racer = this.setup.racers[i] as RacerRuntime;
      this.checkLines(racer, previousDistances[i] as number);
    }

    this.assignPositions();
    // Before overtake detection: a pass is classified against the settled shape
    // of the field, so the shape has to be up to date first.
    this.groups.sample(this.groupMembers(), this.currentTick, this.elapsedS, (event) =>
      this.events.push(event),
    );
    this.detectOvertakes();
    this.checkTermination();
  }

  private groupMembers(): GroupMember[] {
    const members: GroupMember[] = [];
    for (const racer of this.setup.racers) {
      if (racer.status !== 'racing') continue;
      members.push({
        id: racer.spec.id,
        distanceM: racer.distanceM,
        speedMs: racer.speedMs,
      });
    }
    return members;
  }

  /** Racing and finished racers by distance, front to back. */
  private orderField(): RacerRuntime[] {
    return this.setup.racers
      .slice()
      .sort((a, b) => rankRacers(a, b));
  }

  private buildTraffic(ordering: readonly RacerRuntime[]): Map<string, Traffic> {
    const map = new Map<string, Traffic>();
    for (let i = 1; i < ordering.length; i++) {
      const racer = ordering[i] as RacerRuntime;
      const ahead = ordering[i - 1] as RacerRuntime;
      if (racer.status !== 'racing' || ahead.status !== 'racing') continue;
      const gapM = ahead.distanceM - racer.distanceM;
      if (gapM <= 0) continue;
      map.set(racer.spec.id, {
        racer: ahead,
        gapM,
        // Below walking pace the time gap is meaningless and would explode.
        gapS: gapM / Math.max(racer.speedMs, 1),
      });
    }
    return map;
  }

  /**
   * Lap, sector, and finish-line crossings. The exact crossing instant is
   * interpolated within the tick — at 20Hz an uninterpolated lap time would be
   * quantized to 50ms, which is far too coarse for a timing tower that shows
   * thousandths.
   */
  private checkLines(racer: RacerRuntime, previousDistanceM: number): void {
    if (racer.status !== 'racing') return;

    const { lapLengthM, raceDistanceM, sectorBoundariesM, totalLaps, track } = this.setup;
    const isCircuit = track.mode === 'circuit';
    const tickStartS = (this.currentTick - 1) * TICK_SECONDS;
    const travelledM = racer.distanceM - previousDistanceM;

    const crossTimeS = (markM: number): number => {
      if (travelledM <= 0) return tickStartS;
      const fraction = (markM - previousDistanceM) / travelledM;
      return tickStartS + fraction * TICK_SECONDS;
    };

    if (isCircuit) {
      for (const boundary of sectorBoundariesM) {
        const markM = racer.lap * lapLengthM + boundary;
        if (previousDistanceM < markM && racer.distanceM >= markM && markM < raceDistanceM) {
          this.recordSector(racer, crossTimeS(markM));
        }
      }

      while (racer.lap < totalLaps) {
        const markM = (racer.lap + 1) * lapLengthM;
        if (racer.distanceM < markM) break;
        const atS = crossTimeS(markM);
        this.recordSector(racer, atS);
        this.recordLap(racer, atS);
      }
    }

    if (racer.distanceM >= raceDistanceM - TUNING.race.finishToleranceM) {
      this.finish(racer, crossTimeS(raceDistanceM));
    }
  }

  private recordSector(racer: RacerRuntime, atS: number): void {
    const sectorCount = this.setup.sectorBoundariesM.length + 1;
    const sector = racer.currentSector;
    const timeS = atS - racer.sectorStartS;

    const previousBest = racer.bestSectorS[sector];
    const personalBest = previousBest === undefined || timeS < previousBest;
    if (personalBest) racer.bestSectorS[sector] = timeS;

    const previousRaceBest = this.raceBestSectorS[sector];
    const raceBest = previousRaceBest === undefined || timeS < previousRaceBest;
    if (raceBest) this.raceBestSectorS[sector] = timeS;

    racer.currentSectors.push({ sector, timeS });
    racer.sectorStartS = atS;
    racer.currentSector = (sector + 1) % sectorCount;

    this.events.push({
      type: 'sector',
      tick: this.currentTick,
      atS,
      racerId: racer.spec.id,
      lap: racer.lap + 1,
      sector,
      timeS,
      personalBest,
      raceBest,
    });
  }

  private recordLap(racer: RacerRuntime, atS: number): void {
    const timeS = atS - racer.lapStartS;
    const personalBest = racer.bestLapS === undefined || timeS < racer.bestLapS;
    if (personalBest) racer.bestLapS = timeS;
    const raceBest = this.raceBestLapS === undefined || timeS < this.raceBestLapS;
    if (raceBest) this.raceBestLapS = timeS;

    const record: LapRecord = {
      lap: racer.lap + 1,
      timeS,
      sectors: racer.currentSectors.slice(),
    };
    racer.laps.push(record);
    racer.currentSectors = [];
    racer.lap += 1;
    racer.lapStartS = atS;

    this.events.push({
      type: 'lap',
      tick: this.currentTick,
      atS,
      racerId: racer.spec.id,
      lap: record.lap,
      lapTimeS: timeS,
      personalBest,
      raceBest,
    });
  }

  private finish(racer: RacerRuntime, atS: number): void {
    racer.status = 'finished';
    racer.finishTimeS = atS;
    racer.finalDistanceM = this.setup.raceDistanceM;
    racer.distanceM = this.setup.raceDistanceM;
    racer.position = this.nextPosition;
    this.nextPosition += 1;

    if (this.leaderFinishedTick === undefined) this.leaderFinishedTick = this.currentTick;

    this.events.push({
      type: 'finish',
      tick: this.currentTick,
      atS,
      racerId: racer.spec.id,
      position: racer.position,
      totalTimeS: atS,
    });
  }

  /**
   * Finishers keep the position they crossed the line in. Everyone still
   * running is ranked behind them by distance, and retirements behind that.
   */
  private assignPositions(): void {
    const running = this.setup.racers
      .filter((r) => r.status === 'racing')
      .sort((a, b) => b.distanceM - a.distanceM || compareId(a, b));

    let position = this.nextPosition;
    for (const racer of running) racer.position = position++;

    const retired = this.setup.racers
      .filter((r) => isOut(r.status))
      .sort((a, b) => (b.finalDistanceM ?? 0) - (a.finalDistanceM ?? 0) || compareId(a, b));
    for (const racer of retired) racer.position = position++;
  }

  /**
   * An overtake is a *persistent* change in relative order, so it has to be
   * measured against the last tick's ordering rather than against how far each
   * racer moved during this one. A real pass takes several seconds and a tick
   * is 50ms; comparing within a tick can only ever detect a swap that never
   * happens.
   *
   * Working pairwise also makes retirements a non-event: when a racer drops
   * out, everyone behind them gains a rank, but no *pair* has flipped, so
   * nothing is logged.
   */
  private detectOvertakes(): void {
    const racing = this.setup.racers
      .filter((r) => r.status === 'racing')
      .sort((a, b) => b.distanceM - a.distanceM || compareId(a, b));

    const ranks = new Map<string, number>();
    racing.forEach((racer, index) => ranks.set(racer.spec.id, index));

    const movers = racing.filter((racer) => {
      const previous = this.previousRanks.get(racer.spec.id);
      return previous !== undefined && previous !== ranks.get(racer.spec.id);
    });

    // The overwhelmingly common case: nothing changed hands this tick.
    if (movers.length > 1) {
      for (const passer of movers) {
        const wasRank = this.previousRanks.get(passer.spec.id) as number;
        const nowRank = ranks.get(passer.spec.id) as number;
        if (nowRank >= wasRank) continue;

        for (const victim of movers) {
          if (victim === passer) continue;
          const victimWas = this.previousRanks.get(victim.spec.id) as number;
          const victimNow = ranks.get(victim.spec.id) as number;
          if (!(victimWas < wasRank && victimNow > nowRank)) continue;

          // Keyed on the unordered pair, so two racers trading places
          // repeatedly while side by side log one move, not a stream of them.
          const key = pairKey(passer.spec.id, victim.spec.id);
          const last = this.lastPassS.get(key);
          if (last !== undefined && this.elapsedS - last < OVERTAKE_COOLDOWN_S) continue;
          this.lastPassS.set(key, this.elapsedS);

          this.events.push({
            type: 'overtake',
            tick: this.currentTick,
            atS: this.elapsedS,
            racerId: passer.spec.id,
            victimId: victim.spec.id,
            forPosition: passer.position,
            distanceM: passer.distanceM,
            // Classified here rather than downstream: only the sim knows which
            // group each racer was in, and a consumer left to infer it from
            // positions alone would infer it wrong.
            significance: classifyPass(
              this.groups.grouping,
              passer.spec.id,
              victim.spec.id,
              passer.position,
            ),
          });
        }
      }
    }

    this.previousRanks = ranks;
  }

  private checkTermination(): void {
    const stillRacing = this.setup.racers.some((r) => r.status === 'racing');
    if (!stillRacing) {
      this.end('all-classified');
      return;
    }
    if (
      this.leaderFinishedTick !== undefined &&
      this.currentTick - this.leaderFinishedTick > TUNING.race.maxTicksAfterLeaderFinish
    ) {
      this.end('timeout-after-leader');
      return;
    }
    if (this.currentTick >= TUNING.race.maxTicks) this.end('hard-tick-cap');
  }

  private end(reason: 'all-classified' | 'timeout-after-leader' | 'hard-tick-cap'): void {
    // Anyone still circulating when the flag falls is classified where they are.
    for (const racer of this.setup.racers) {
      if (racer.status === 'racing') {
        // Nothing broke — they simply did not finish inside the flag. Calling
        // this a mechanical would be a lie, and on an over-long course it was
        // the lie that made a whole field look like it had blown up at once.
        racer.status = 'dnf-timeout';
        racer.finalDistanceM = racer.distanceM;
      }
    }
    this.assignPositions();
    this.done = true;
    this.endReason = reason;
    this.events.push({
      type: 'race-end',
      tick: this.currentTick,
      atS: this.elapsedS,
      reason,
    });
  }

  snapshot(): RaceSnapshot {
    return {
      tick: this.currentTick,
      elapsedS: this.elapsedS,
      racers: this.setup.racers.map(
        (r): RacerSnapshot => ({
          racerId: r.spec.id,
          distanceAlongRoute: r.distanceM,
          lateralOffset: r.lateralOffsetM,
          speedMs: r.speedMs,
          lap: r.lap,
          position: r.position,
          status: r.status,
        }),
      ),
    };
  }

  result(): Result<RaceResult, SimError> {
    if (!this.done) {
      return err({
        kind: 'race-did-not-terminate',
        message: 'result() called before the race finished. Call runToEnd() or step() first.',
      });
    }

    const ordered = this.setup.racers.slice().sort((a, b) => a.position - b.position);
    const winnerTimeS = ordered.find((r) => r.status === 'finished')?.finishTimeS;

    const finishers: FinishRecord[] = ordered.map((racer) => {
      const record: FinishRecord = {
        racerId: racer.spec.id,
        position: racer.position,
        status: racer.status,
        lapsCompleted: racer.lap,
        distanceM: racer.finalDistanceM ?? racer.distanceM,
        laps: racer.laps,
        traits: racer.traits,
      };
      if (racer.finishTimeS !== undefined) record.totalTimeS = racer.finishTimeS;
      if (racer.bestLapS !== undefined) record.bestLapS = racer.bestLapS;
      if (
        racer.finishTimeS !== undefined &&
        winnerTimeS !== undefined &&
        racer.finishTimeS > winnerTimeS
      ) {
        record.gapToWinnerS = racer.finishTimeS - winnerTimeS;
      }
      return record;
    });

    return ok({
      simVersion: SIM_VERSION,
      seed: this.setup.config.seed,
      trackId: this.setup.track.id,
      vehicleClassId: this.setup.vehicle.id,
      durationS: this.elapsedS,
      totalTicks: this.currentTick,
      finishers,
      resultHash: hashResult(finishers),
    });
  }

  /** Exposed for the debug panel; the reason a race stopped is easy to get wrong. */
  get terminationReason(): string {
    return this.endReason;
  }
}

/**
 * The racers still circulating, front to back, in the minimal shape `bunch.ts`
 * reads. Retired racers are dropped rather than sorted to the back: nobody
 * shelters behind a wreck, and a group must not be considered broken by one.
 *
 * `ordering` is already sorted, and filtering preserves that.
 */
const bunchMembers = (ordering: readonly RacerRuntime[]): BunchMember[] => {
  const members: BunchMember[] = [];
  for (const racer of ordering) {
    if (racer.status !== 'racing') continue;
    members.push({ id: racer.spec.id, distanceM: racer.distanceM, speedMs: racer.speedMs });
  }
  return members;
};

/**
 * Field ordering for traffic: whoever is furthest along the road is in front.
 * Retired racers sort to the back so nobody drafts a stationary wreck.
 */
const rankRacers = (a: RacerRuntime, b: RacerRuntime): number => {
  const aOut = isOut(a.status);
  const bOut = isOut(b.status);
  if (aOut !== bOut) return aOut ? 1 : -1;
  return b.distanceM - a.distanceM || compareId(a, b);
};

/** A racer who is out of the race, by any of the three ways to be. */
const isOut = (status: RacerRuntime['status']): boolean =>
  status === 'dnf-crash' || status === 'dnf-mechanical' || status === 'dnf-timeout';

const compareId = (a: RacerRuntime, b: RacerRuntime): number =>
  a.spec.id < b.spec.id ? -1 : a.spec.id > b.spec.id ? 1 : 0;

const pairKey = (a: string, b: string): string => `${a}>${b}`;

/**
 * Per-tick mechanical failure probability.
 *
 * `reliability` is quoted as the chance of surviving a nominal race, so it is
 * first rescaled to the expected duration of *this* race — a five-lap sprint
 * should not break as many cars as a fifty-lap enduro — and then spread evenly
 * across the ticks. `Math.pow` is fine here: this runs once, before the race.
 */
const mechanicalHazard = (setup: RaceSetup): number => {
  const durationRatio = setup.expectedDurationS / TUNING.reliability.nominalRaceDurationS;
  const survivalChance = Math.pow(setup.vehicle.reliability, durationRatio);
  const failureChance = 1 - survivalChance;
  const expectedTicks = Math.max(1, setup.expectedDurationS * SIM_HZ);
  return failureChance / expectedTicks;
};

/**
 * Probability that a crash-severity moment ends the race, for this class on
 * this race.
 *
 * Crash-severity moments fire at a per-tick rate, so their *count* scales with
 * how long the race is. If a fixed fraction of them were terminal, terminal
 * crashes would scale with duration too — which is why a multi-hour bicycle
 * race used to retire almost everyone. Dividing the per-class `crashProneness`
 * by the duration ratio cancels that: the expected number of terminal crashes
 * over a race no longer grows with its length, the same guarantee the
 * mechanical hazard gives `reliability`. Short races are left alone (the ratio
 * is capped at 1) so a sprint does not become a demolition derby.
 */
const crashDnfChance = (setup: RaceSetup): number => {
  const durationRatio = Math.max(
    1,
    setup.expectedDurationS / TUNING.incidents.crashNominalDurationS,
  );
  return clamp01(setup.vehicle.crashProneness / durationRatio);
};
