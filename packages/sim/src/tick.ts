import type { TrackNode, WeatherConditions } from '@anywhererace/core';
import { clamp, clamp01, lerp } from '@anywhererace/core';
import type { BunchState } from './bunch';
import type { MistakeKind, RaceEvent } from './events';
import type { TrackProfile } from './profile';
import { nodeIndexAt } from './profile';
import type { RaceSetup, RacerRuntime } from './setup';
import type { DebugToggles } from './tuning';
import { TICK_SECONDS, TUNING } from './tuning';

/**
 * The tick.
 *
 * Per racer, per tick, in the order CLAUDE.md lays out: target speed, then
 * modifiers, then personality, then traffic, then incidents, then integration.
 * Keep this readable — it is the thing that will be tuned constantly, and every
 * step here is individually switchable from the debug panel.
 *
 * Only arithmetic and `Math.sqrt` appear below. Anything needing trigonometry,
 * logarithms or exponentiation is precomputed in `profile.ts` or `setup.ts`.
 */

export type TickContext = {
  readonly setup: RaceSetup;
  readonly profile: TrackProfile;
  readonly toggles: DebugToggles;
  /** Mechanical failure probability per racer per tick. Derived once at init. */
  readonly mechanicalHazardPerTick: number;
  /**
   * Probability that a crash-severity moment ends the race for this class, on
   * this race. Per vehicle and normalized to race duration, derived once at
   * init — see `race.ts`. A survived crash becomes a heavy time loss instead.
   */
  readonly crashDnfChance: number;
  /** Field ordering, front to back, from the start of this tick. */
  readonly ordering: readonly RacerRuntime[];
  readonly conditions: WeatherConditions;
  readonly windNorth: number;
  readonly windEast: number;
  readonly tick: number;
  readonly elapsedS: number;
  readonly emit: (event: RaceEvent) => void;
};

/** Per-tick view of the racer directly ahead on the road, if there is one. */
type Traffic = {
  readonly racer: RacerRuntime;
  readonly gapM: number;
  readonly gapS: number;
};

export const tickRacer = (
  racer: RacerRuntime,
  ahead: Traffic | undefined,
  bunch: BunchState,
  ctx: TickContext,
): void => {
  if (racer.status !== 'racing') return;

  const { setup, profile, toggles } = ctx;
  const vehicle = setup.vehicle;
  const topSpeedMs = setup.topSpeedMs;
  const nodeIndex = nodeIndexAt(profile, setup.track.startLine, racer.distanceM);
  const node = profile.nodes[nodeIndex] as TrackNode;
  const progress = clamp01(racer.distanceM / setup.raceDistanceM);

  // --- 3. Personality overlay -------------------------------------------
  // Deciding to go comes first, because an attack changes the effort below and
  // because it is a decision about the road ahead rather than about this
  // instant. Nothing is emitted when a racer commits: whether the move actually
  // opens a gap is the ground truth, and `groups.ts` reports that when it
  // happens — the same reason an overtake is logged on the swap and not on the
  // attempt.
  if (toggles.tactics) considerAttack(racer, bunch, nodeIndex, progress, ctx);

  // Computed after, because effort feeds the power-limited speed below.
  const effort = computeEffort(racer, ctx, progress);

  // --- 1. Target speed: the power-limited term --------------------------
  let powerMs = topSpeedMs * effort;

  // --- 2. Modifiers ------------------------------------------------------
  if (toggles.gradient) powerMs *= gradientMultiplier(node.gradient, vehicle);
  if (toggles.surface) powerMs *= profile.surfaceSpeedScale[nodeIndex] as number;

  const wetness = toggles.weather
    ? clamp01(ctx.conditions.precipitationMmPerHour / TUNING.weather.fullWetMmPerHour)
    : 0;
  // How much of the weather a racer shrugs off. 0 = takes the full hit.
  const weatherShield = 1 - TUNING.weather.weatherSkillOffset * racer.traits.weatherSkill;

  if (toggles.weather) {
    const visibilityLoss =
      (TUNING.weather.wetVisibilityLoss * wetness +
        TUNING.weather.cloudVisibilityLoss * ctx.conditions.cloudCoverFraction) *
      weatherShield;
    powerMs *= 1 - visibilityLoss;
  }

  if (toggles.wind) {
    // Positive is a tailwind. Precomputed heading components keep this a dot
    // product rather than a trig call.
    const along =
      ctx.windNorth * (profile.headingNorth[nodeIndex] as number) +
      ctx.windEast * (profile.headingEast[nodeIndex] as number);
    const sensitivity = setup.windSensitivity;
    // Skill helps you hide from a headwind; nobody needs skill to enjoy a tailwind.
    powerMs += along * sensitivity * (along < 0 ? weatherShield : 1);
  }

  // A racer already committed to a move is offline and in clean air.
  const committedToPass = ctx.elapsedS < racer.passingUntilS;

  let dirtyAirGripLoss = 0;
  if (toggles.draft) {
    // How much air is being broken for this racer, in wheels. Two sources, and
    // they add:
    //
    //   The wheels immediately ahead — the classic pairwise tow, scaled by how
    //   close this racer actually is to the one in front.
    //
    //   The turns their group shares out. Nobody stays on the front of a bunch;
    //   they rotate, and averaged over any length of road that makes the *group*
    //   more efficient than any of its members riding alone — including whoever
    //   happens to be leading it at this instant. Without this term the racer on
    //   the front is modelled as a solo rider and the bunch can never sustain
    //   more than its least sheltered member's pace.
    //
    // Additive, and with the rotation term much the smaller of the two, because
    // the difference between the racer on the front and the racers behind them
    // is load-bearing: it is the only thing that makes a follower faster than a
    // leader, and therefore the only thing that ever closes a gap. Taking the
    // larger of the two instead — which is what this did first — hands the
    // leader the same shelter as everyone else, nobody has a reason to catch
    // anybody, and a peloton dissolves into individuals within ten minutes.
    const wheelDepth =
      ahead !== undefined && bunch.shelterDepth > 0
        ? bunch.shelterDepth * (1 - ahead.gapS / TUNING.draft.maxGapS)
        : 0;
    const rawDepth = wheelDepth + (bunch.groupSize - 1) * TUNING.draft.rotationShare;

    if (rawDepth > 0) {
      const awareness = lerp(
        TUNING.draft.minAwarenessFraction,
        1,
        racer.traits.draftAwareness,
      );
      // Saturating in depth, so the second wheel is worth far more than the
      // twentieth. In a crosswind the shelter runs out at the edge of the road
      // instead, however many riders are nominally ahead.
      const depth = toggles.wind ? echelonDepth(rawDepth, nodeIndex, ctx) : rawDepth;
      const shelter = depth / (depth + TUNING.draft.shelterHalfDepth);
      powerMs *= 1 + TUNING.draft.maxGainFraction * vehicle.draftBenefit * awareness * shelter;
    }

    if (
      ahead !== undefined &&
      ahead.gapS <= TUNING.draft.dirtyAirGapS &&
      !(committedToPass && TUNING.traffic.clearsDirtyAirWhilePassing)
    ) {
      // Sitting in the wake costs grip, which is why a downforce class cannot
      // simply follow another one through a corner — and why a racer has to
      // commit to going around rather than just waiting behind.
      dirtyAirGripLoss =
        TUNING.draft.dirtyAirGripLoss * (1 - ahead.gapS / TUNING.draft.dirtyAirGapS);
    }
  }

  // Descents are the only way to legitimately exceed the class top speed, and
  // even then only by the gradient model's ceiling.
  powerMs = Math.min(powerMs, topSpeedMs * TUNING.gradient.maxDescentMultiplier);
  powerMs = Math.max(powerMs, 0);

  // --- 1. Target speed: the grip-limited term ---------------------------
  const gripScale = (toggles.weather ? weatherGripScale(ctx.conditions, weatherShield) : 1) *
    (1 - dirtyAirGripLoss);
  // The braking profile already folds in cornering radius, surface grip and
  // junction caps, and already looks ahead far enough to stop for all of them.
  //
  // `nominalCornerMs` is this racer's *own* clean limit — grip, conditions and
  // their skill at finding it. Risk tolerance is then how far past that limit
  // they are willing to go, which is why the incident model measures overdrive
  // against the nominal figure and not against the risk-inflated one.
  const skillCornerScale = lerp(TUNING.cornering.minCornerSkillScale, 1, racer.skill);
  const nominalCornerMs =
    (profile.brakingLimitMs[nodeIndex] as number) * gripScale * skillCornerScale;
  const riskScale = toggles.personality
    ? 1 + (racer.traits.riskTolerance - 0.5) * 2 * TUNING.cornering.riskAmplitude
    : 1;
  const cornerMs = nominalCornerMs * riskScale;

  // The pace this racer would ride if nobody were setting one for them. Not
  // "clean air" — the shelter they are getting is already in it.
  const ownPaceMs = Math.min(powerMs, cornerMs);
  let targetMs = ownPaceMs;

  // --- 3b. The bunch -----------------------------------------------------
  // A group has a pace, and it is not usually yours. Only the costly direction
  // is a speed: a group faster than you drags you above your own limit here,
  // while a group slower than you saves you further down, in `deliveredEffort`,
  // as reservoir you did not spend. See `holdGroupPace`.
  //
  // Applies to the racer on the front as much as to anyone else — a rider
  // leading a bunch is riding the bunch's pace, not their own.
  if (toggles.bunch && bunch.groupSize > 1) {
    targetMs = holdGroupPace(racer, ownPaceMs, bunch.groupPaceMs, ctx);
  }

  // --- 4. Traffic --------------------------------------------------------
  if (toggles.traffic && ahead !== undefined) {
    targetMs = resolveTraffic(racer, ahead, targetMs, ownPaceMs, nodeIndex, progress, ctx);
  }

  // How much of their pace the racer is actually getting to use, and the reason
  // the ratio is deliberately not capped at 1 in either direction. Held up
  // behind someone slower, a racer is not working as hard as their effort
  // number says and should not burn stamina as if they were. Hanging on to a
  // group riding faster than them, they are working *harder* than it says — and
  // since the drain scales with the square of that ratio, a rider who spends an
  // hour clinging to a bunch above their level empties themselves and comes off.
  // That is the entire mechanism by which a peloton drops people, and it is this
  // one line rather than a rule anywhere else.
  const deliveredEffort = ownPaceMs > 0 ? effort * (targetMs / ownPaceMs) : effort;

  // --- 5. Incidents ------------------------------------------------------
  if (toggles.incidents) {
    // "Effort above the grip limit" is exactly how far the racer's target sits
    // past what the surface would nominally give them.
    const overDrive =
      nominalCornerMs > 0 ? Math.max(0, targetMs / nominalCornerMs - 1) : 0;
    rollForMistake(racer, overDrive, wetness, ctx, false);
  }
  if (toggles.mechanicalFailures) rollForMechanical(racer, ctx);
  if (racer.status !== 'racing') return;

  // --- 6. Integrate ------------------------------------------------------
  integrate(racer, targetMs, ctx);
  updateLateralOffset(racer, ahead, ctx);
  if (toggles.endurance) drainReservoir(racer, deliveredEffort, ctx);
};

// ---------------------------------------------------------------------------
// Step 3: effort
// ---------------------------------------------------------------------------

const computeEffort = (racer: RacerRuntime, ctx: TickContext, progress: number): number => {
  const { setup, toggles } = ctx;
  const sustainable = TUNING.effort.sustainableEffort[setup.vehicle.enduranceModel];
  let effort = sustainable * lerp(TUNING.effort.minSkillScale, 1, racer.skill);

  if (toggles.personality) {
    effort *= racer.modifiers.paceCeiling;

    // Pacing: -1 goes out hot and fades, +1 negative-splits.
    const swing = (racer.traits.pacing - 0.5) * 2;
    effort *= 1 + TUNING.effort.pacingAmplitude * swing * (2 * progress - 1);

    // Consistency sets the width of a slowly-drifting noise term. Smoothing it
    // matters: raw 20Hz noise would average out to nothing over a lap and
    // consistency would stop being a trait at all.
    const noiseWidth = TUNING.effort.maxNoiseFraction * (1 - racer.traits.consistency);
    const smoothing = TICK_SECONDS / TUNING.effort.noiseSmoothingS;
    const sample = racer.rng.normalClamped(0, noiseWidth, 3);
    racer.noise += (sample - racer.noise) * smoothing;
    effort *= 1 + racer.noise;

    // The Showboat: comfortably clear, and enjoying it too much.
    if (racer.modifiers.comfortableLeadEasing > 0 && racer.position === 1) {
      const chased = ctx.ordering[1];
      if (chased !== undefined) {
        const leadS = (racer.distanceM - chased.distanceM) / Math.max(racer.speedMs, 1);
        if (leadS > TUNING.showboat.comfortableLeadS) {
          effort *= 1 - TUNING.showboat.maxEasing * racer.modifiers.comfortableLeadEasing;
        }
      }
    }
  }

  // A committed attack is a dig above whatever the pacing curve had planned.
  // Deliberately a modest number: the expensive part of going clear is not the
  // effort, it is leaving the shelter, and that cost applies itself the moment
  // the racer is on the front with nobody left to hide behind.
  if (ctx.elapsedS < racer.attackingUntilS) effort *= 1 + TUNING.tactics.attackEffortBoost;

  if (ctx.elapsedS < racer.rattledUntilS) {
    // Composure is what gets you back on the pace after a moment.
    effort *= 1 - TUNING.incidents.rattledEffortLoss * (1 - racer.traits.composure);
  }

  if (toggles.endurance) effort *= reservoirEffortScale(racer.reservoir);

  // Note: effort is deliberately NOT capped when stuck in traffic. Capping it
  // here was self-locking — it erased the faster racer's pace advantage, which
  // is the very thing that decides whether they get to attempt a pass, so a
  // quicker racer could sit behind a slower one for an entire race without ever
  // registering that they were quicker. The cost of being held up is accounted
  // for at the other end instead, by draining less of the reservoir when
  // traffic is what is limiting the speed.
  return Math.max(effort, 0);
};

const reservoirEffortScale = (reservoir: number): number => {
  if (reservoir >= TUNING.endurance.fadeThreshold) return 1;
  const remaining = clamp01(reservoir / TUNING.endurance.fadeThreshold);
  return lerp(TUNING.endurance.emptyEffortMultiplier, 1, remaining);
};

const drainReservoir = (racer: RacerRuntime, effort: number, ctx: TickContext): void => {
  const model = ctx.setup.vehicle.enduranceModel;
  const base = TUNING.endurance.drainPerSecond[model];
  if (base === 0) return;

  const sustainable = TUNING.effort.sustainableEffort[model];
  const ratio = sustainable > 0 ? effort / sustainable : 1;
  // Squared, written as a multiplication: going 10% over sustainable costs 21%
  // more. This is the mechanism that punishes a Front-Runner.
  let drain = base * ratio * ratio;

  if (model === 'stamina' && ctx.conditions.temperatureC > TUNING.endurance.heatStressAboveC) {
    const excess = ctx.conditions.temperatureC - TUNING.endurance.heatStressAboveC;
    drain *= 1 + TUNING.endurance.heatDrainPerDegree * excess;
  }

  racer.reservoir = Math.max(0, racer.reservoir - drain * TICK_SECONDS);
};

// ---------------------------------------------------------------------------
// Step 2: environment
// ---------------------------------------------------------------------------

const gradientMultiplier = (
  gradient: number,
  vehicle: RaceSetup['vehicle'],
): number => {
  const grade = clamp(gradient, -TUNING.gradient.maxAbsGrade, TUNING.gradient.maxAbsGrade);
  if (grade > 0) {
    return 1 / (1 + vehicle.gradientSensitivity * grade * TUNING.gradient.climbScale);
  }
  const gain = 1 + TUNING.gradient.descentGain * -grade * vehicle.descentBenefit;
  return Math.min(gain, TUNING.gradient.maxDescentMultiplier);
};

const weatherGripScale = (conditions: WeatherConditions, weatherShield: number): number => {
  const wetness = clamp01(conditions.precipitationMmPerHour / TUNING.weather.fullWetMmPerHour);
  const wetLoss = TUNING.weather.wetGripLoss * wetness * weatherShield;

  const belowIdeal = Math.max(0, TUNING.weather.idealTemperatureC - conditions.temperatureC);
  const coldLoss =
    Math.min(TUNING.weather.maxColdGripLoss, belowIdeal * TUNING.weather.coldGripLossPerDeg) *
    weatherShield;

  return Math.max(0.2, 1 - wetLoss - coldLoss);
};

// ---------------------------------------------------------------------------
// Step 3b: the bunch
// ---------------------------------------------------------------------------

/**
 * The pace a racer actually rides at, given the group they are in: hanging on.
 *
 * Called for every member of a group of two or more, the racer on the front
 * included. `groupPaceMs` is an average over the group rather than the leader's
 * own speed, so there is no member for whom the number is trivially their own —
 * see `bunch.ts` for why it has to be an average.
 *
 * Only the *costly* half of group riding lives here, and that asymmetry is
 * deliberate. Damping a racer down toward a slower group's average was tried and
 * removed: it reads well and it is wrong twice over. It stops a follower ever
 * being quicker than the rider in front, so nothing in the field ever closes a
 * gap and a peloton ratchets apart into individuals; and it double-counts, since
 * the traffic model already refuses to let a racer ride through the one ahead of
 * them. The saving from sitting in a slow group is real, but it is not a speed —
 * it is the reduced effort of being held to someone else's pace, which
 * `deliveredEffort` already books by draining less of the reservoir.
 */
const holdGroupPace = (
  racer: RacerRuntime,
  ownPaceMs: number,
  groupPaceMs: number,
  ctx: TickContext,
): number => {
  if (groupPaceMs <= ownPaceMs) return ownPaceMs;

  // The group is going faster than you can. You hold the wheel anyway, but only
  // so far past your own limit — and less of that the emptier you are, which is
  // what makes a long day in a fast bunch end with you off the back rather than
  // with you holding it forever.
  const fuel = ctx.toggles.endurance ? racer.reservoir : 1;
  const headroom = TUNING.bunch.hangOnHeadroom * lerp(TUNING.bunch.hangOnEmptyScale, 1, fuel);
  const ceilingMs = ownPaceMs * (1 + headroom);
  return groupPaceMs < ceilingMs ? groupPaceMs : ceilingMs;
};

/**
 * Shelter depth after the crosswind has had its say.
 *
 * A bunch sheltering itself in still air is a column; in a crosswind the usable
 * air moves diagonally across the road and runs out at the gutter. Only as many
 * riders as the road is wide get anything, and the rider immediately past the
 * end of that echelon is in the gutter — riding alone, however many wheels are
 * nominally ahead of them. Behind that a second echelon forms, and so on down
 * the road.
 *
 * That is what the remainder expresses: a racer's depth is counted from the
 * start of *their* echelon rather than from the front of the field. Rather than
 * modelling lateral position — the sim is 1D along the route and must stay that
 * way — the wind is allowed to reach in and reset the depth that counts.
 *
 * Simply capping the depth was tried first and is almost a no-op, which is worth
 * recording because it looks so reasonable. The shelter curve saturates, so
 * holding a rider at eight wheels instead of eleven moves their tow by well
 * under a percent, and a full crosswind cost a twenty-rider bunch less time than
 * the seed-to-seed noise. Being caught out behind the split has to actually
 * hurt, or the echelon is decoration.
 *
 * The effect is interpolated in with the strength of the crosswind rather than
 * switched on, so a wind getting up progressively strings a field out instead of
 * guillotining it.
 */
const echelonDepth = (depth: number, nodeIndex: number, ctx: TickContext): number => {
  // The same two precomputed heading components as the headwind dot product,
  // crossed rather than dotted. Sign is irrelevant — a crosswind from either
  // side does the same thing.
  const cross =
    ctx.windEast * (ctx.profile.headingNorth[nodeIndex] as number) -
    ctx.windNorth * (ctx.profile.headingEast[nodeIndex] as number);
  const crossMs = cross < 0 ? -cross : cross;

  const severity = clamp01(
    (crossMs - TUNING.draft.echelonOnsetMs) /
      Math.max(TUNING.draft.echelonFullMs - TUNING.draft.echelonOnsetMs, 1e-6),
  );
  if (severity <= 0) return depth;

  const capacity = Math.max(
    1,
    (ctx.profile.widthInVehicles[nodeIndex] as number) * TUNING.draft.echelonRidersPerWidth,
  );
  if (depth <= capacity) return depth;

  // Depth within this racer's own echelon. `%` on doubles is exactly specified,
  // so this stays as reproducible as the rest of the tick.
  const inEchelon = depth % capacity;
  return depth + (inEchelon - depth) * severity;
};

/**
 * Deciding to go.
 *
 * Reads the course sweep through `profile.attackAppeal`, so a racer is far more
 * likely to commit at the foot of a climb or on the approach to a pinch point
 * than on an open straight — which is the difference between attacks happening
 * and attacks mattering. Personality decides who: `aggression` throughout,
 * `ambition` only once the race is late enough for a low-percentage move to be
 * worth anything, exactly as the traffic model reads them.
 */
const considerAttack = (
  racer: RacerRuntime,
  bunch: BunchState,
  nodeIndex: number,
  progress: number,
  ctx: TickContext,
): void => {
  if (ctx.elapsedS < racer.attackingUntilS || ctx.elapsedS < racer.attackReadyAtS) return;
  // A racer alone on the road, or already on the front of their group, is
  // doing the only thing available to them. There is nothing to attack from.
  if (bunch.onFront || bunch.groupSize < 2) return;
  if (ctx.toggles.endurance && racer.reservoir < TUNING.tactics.minReservoir) return;

  const traits = racer.traits;
  const lateness = clamp01(
    (progress - TUNING.traffic.ambitionEngagesAtProgress) /
      Math.max(1 - TUNING.traffic.ambitionEngagesAtProgress, 1e-6),
  );
  const eagerness = clamp01(traits.aggression * 0.5 + traits.ambition * lateness * 0.5);

  const chance =
    TUNING.tactics.baseAttackPerTick *
    lerp(TUNING.tactics.minAttackMultiplier, TUNING.tactics.maxAttackMultiplier, eagerness) *
    (1 + TUNING.tactics.selectionAppealBonus * (ctx.profile.attackAppeal[nodeIndex] as number));

  if (!racer.rng.bool(chance)) return;

  racer.attackingUntilS = ctx.elapsedS + TUNING.tactics.attackDurationS;
  racer.attackReadyAtS = racer.attackingUntilS + TUNING.tactics.cooldownS;
};

// ---------------------------------------------------------------------------
// Step 4: traffic
// ---------------------------------------------------------------------------

const resolveTraffic = (
  racer: RacerRuntime,
  ahead: Traffic,
  targetMs: number,
  ownPaceMs: number,
  nodeIndex: number,
  progress: number,
  ctx: TickContext,
): number => {
  // Track the pace advantage even outside the closing distance, so a racer who
  // arrives on the gearbox of the car ahead already knows whether they are
  // genuinely quicker or just briefly better placed on the lap.
  //
  // Measured against `ownPaceMs` rather than against the target, because the
  // question is whether this racer is quicker — and a racer content to sit in
  // has just damped their own target toward the group's. Reading the damped
  // number would mean a patient rider could never register that they had the
  // legs to go, which is precisely backwards: sitting in is a choice made *by*
  // someone who knows they are faster.
  const smoothing = TICK_SECONDS / TUNING.traffic.paceAdvantageSmoothingS;
  racer.paceAdvantageMs += (ownPaceMs - ahead.racer.speedMs - racer.paceAdvantageMs) * smoothing;

  if (ahead.gapM > TUNING.traffic.closingDistanceM) return targetMs;

  if (
    ctx.elapsedS >= racer.passingUntilS &&
    racer.paceAdvantageMs > TUNING.traffic.minSpeedDeltaMs
  ) {
    attemptPass(racer, ahead, racer.paceAdvantageMs, nodeIndex, progress, ctx);
  }

  // Re-read the flag: a pass won on this very tick is committed from now. A
  // committed racer is not held to the speed of the racer ahead; the advantage
  // that gets them by is the clean air they moved into, applied above.
  if (ctx.elapsedS < racer.passingUntilS) return targetMs;

  // Inside the minimum following distance and not committed to a move, you are
  // simply stuck behind them — this is the dirty-air stalemate that makes
  // narrow trails and street circuits processional.
  if (ahead.gapM < TUNING.traffic.minFollowDistanceM) {
    return Math.min(targetMs, ahead.racer.speedMs);
  }
  return targetMs;
};

const attemptPass = (
  racer: RacerRuntime,
  ahead: Traffic,
  speedDeltaMs: number,
  nodeIndex: number,
  progress: number,
  ctx: TickContext,
): void => {
  const traits = racer.traits;

  // Ambition is specifically a late-race trait: a low-percentage lunge at
  // one-third distance is not ambition, it is impatience, which is aggression.
  const lateness = clamp01(
    (progress - TUNING.traffic.ambitionEngagesAtProgress) /
      Math.max(1 - TUNING.traffic.ambitionEngagesAtProgress, 1e-6),
  );
  const eagerness = clamp01(traits.aggression * 0.75 + traits.ambition * lateness * 0.25);
  const attemptChance =
    TUNING.traffic.baseAttemptPerTick * lerp(0.25, TUNING.traffic.maxAttemptMultiplier, eagerness);

  if (!racer.rng.bool(attemptChance)) return;

  // Room to go alongside. Below two vehicle widths there is physically nowhere
  // to put the car, and the odds collapse — single-track passing should be a
  // genuine event.
  const lanes = ctx.profile.widthInVehicles[nodeIndex] as number;
  const widthTerm = clamp(
    (lanes - 1) / Math.max(TUNING.traffic.widthForCleanPass - 1, 1e-6),
    0,
    1,
  );

  const craftTerm =
    (traits.racecraft - ahead.racer.traits.racecraft) * TUNING.traffic.racecraftSwing;
  // A real pace advantage makes the move easy; a tenth makes it a wrestle.
  const deltaTerm =
    clamp01(speedDeltaMs / TUNING.traffic.decisiveAdvantageMs) *
    TUNING.traffic.decisiveAdvantageBonus;

  const successChance = clamp(
    (TUNING.traffic.baseSuccessChance + craftTerm + deltaTerm) * widthTerm,
    0.02,
    0.95,
  );

  if (racer.rng.bool(successChance)) {
    racer.passingUntilS = ctx.elapsedS + TUNING.traffic.passWindowS;
    // Pick a side once and commit to it, so the marker does not oscillate.
    racer.passingSide = racer.rng.bool(0.5) ? 1 : -1;
    // The overtake event itself is emitted when the positions actually swap,
    // in `race.ts` — that is the ground truth, and it also catches passes that
    // happen without an attempt roll because one racer is simply quicker.
    return;
  }

  const timeLostS = TUNING.traffic.failedPassCostS;
  racer.timeDebtS += timeLostS;
  ctx.emit({
    type: 'failed-pass',
    tick: ctx.tick,
    atS: ctx.elapsedS,
    racerId: racer.spec.id,
    defenderId: ahead.racer.spec.id,
    distanceM: racer.distanceM,
    timeLostS,
  });

  if (racer.rng.bool(TUNING.traffic.failedPassMistakeChance)) {
    // A badly failed pass is how a Charger ends up in the scenery.
    rollForMistake(racer, 1, 0, ctx, true);
  }
};

// ---------------------------------------------------------------------------
// Step 5: incidents
// ---------------------------------------------------------------------------

/**
 * `forced` skips the hazard roll — the caller has already decided a mistake is
 * happening and only wants the outcome resolved.
 */
const rollForMistake = (
  racer: RacerRuntime,
  overDrive: number,
  wetness: number,
  ctx: TickContext,
  forced: boolean,
): void => {
  const traits = racer.traits;

  // The Choker: composure collapses specifically while leading.
  const composure =
    racer.position === 1
      ? traits.composure *
        (1 - TUNING.choker.maxComposureLoss * racer.modifiers.leadingComposurePenalty)
      : traits.composure;

  if (!forced) {
    const rattled = ctx.elapsedS < racer.rattledUntilS;
    const hazard =
      TUNING.incidents.basePerTick *
      (1 + TUNING.incidents.overDriveScale * overDrive) *
      (1 + TUNING.incidents.composureScale * (1 - composure)) *
      (1 + (TUNING.incidents.wetScale - 1) * wetness) *
      (1 - TUNING.incidents.skillMitigation * racer.skill) *
      (rattled ? TUNING.incidents.rattledHazardMultiplier : 1);
    if (!racer.rng.bool(hazard)) return;
  }

  const roll = racer.rng.next();
  const weights = TUNING.incidents.outcomeWeights;

  if (roll < weights.crash) {
    // A crash-severity moment. Whether it ends the race is a separate roll,
    // against this class's `crashProneness` scaled to race duration: a car
    // usually retires, a cyclist usually remounts, a runner almost always gets
    // up. This is what stops a slow, hours-long race from being decided purely
    // by who failed to finish.
    if (racer.rng.bool(ctx.crashDnfChance)) {
      racer.status = 'dnf-crash';
      racer.finalDistanceM = racer.distanceM;
      racer.speedMs = 0;
      ctx.emit({
        type: 'crash',
        tick: ctx.tick,
        atS: ctx.elapsedS,
        racerId: racer.spec.id,
        distanceM: racer.distanceM,
        lap: racer.lap,
      });
      return;
    }
    // Survived: a fall and remount, or a spin through the run-off. A big loss,
    // logged as a spin, but the racer continues.
    const recovery = TUNING.incidents.crashRecoveryCostS;
    registerMoment(racer, 'spin', racer.rng.range(recovery[0], recovery[1]), composure, forced, ctx);
    return;
  }

  const isSpin = roll < weights.crash + weights.spin;
  const range = isSpin ? TUNING.incidents.spinCostS : TUNING.incidents.lockupCostS;
  registerMoment(
    racer,
    isSpin ? 'spin' : 'lockup',
    racer.rng.range(range[0], range[1]),
    composure,
    forced,
    ctx,
  );
};

/**
 * Book a non-terminal mistake: the time loss as debt, a rattled window whose
 * length is set by composure — which is what makes mistakes compound for a
 * Rookie and not for a Veteran — and the event itself.
 */
const registerMoment = (
  racer: RacerRuntime,
  kind: MistakeKind,
  timeLostS: number,
  composure: number,
  forced: boolean,
  ctx: TickContext,
): void => {
  racer.timeDebtS += timeLostS;
  racer.rattledUntilS = ctx.elapsedS + TUNING.incidents.rattledDurationS * (1 - composure);

  ctx.emit({
    type: 'mistake',
    tick: ctx.tick,
    atS: ctx.elapsedS,
    racerId: racer.spec.id,
    kind,
    timeLostS,
    distanceM: racer.distanceM,
    causedByPassAttempt: forced,
  });
};

const rollForMechanical = (racer: RacerRuntime, ctx: TickContext): void => {
  if (!racer.rng.bool(ctx.mechanicalHazardPerTick)) return;
  racer.status = 'dnf-mechanical';
  racer.finalDistanceM = racer.distanceM;
  racer.speedMs = 0;
  ctx.emit({
    type: 'mechanical',
    tick: ctx.tick,
    atS: ctx.elapsedS,
    racerId: racer.spec.id,
    distanceM: racer.distanceM,
    lap: racer.lap,
  });
};

// ---------------------------------------------------------------------------
// Step 6: integrate
// ---------------------------------------------------------------------------

const integrate = (racer: RacerRuntime, targetMs: number, ctx: TickContext): void => {
  const vehicle = ctx.setup.vehicle;
  const currentMs = racer.speedMs;

  if (targetMs > currentMs) {
    const availableMs2 = vehicle.accelCurve(currentMs * 3.6);
    racer.speedMs = Math.min(targetMs, currentMs + availableMs2 * TICK_SECONDS);
  } else {
    racer.speedMs = Math.max(targetMs, currentMs - vehicle.brakingMs2 * TICK_SECONDS);
  }
  if (racer.speedMs < 0) racer.speedMs = 0;

  // Time losses are worked off by running slowly rather than by teleporting the
  // racer backwards: while in debt they run at (1 - paydown) of their pace, and
  // the debt falls by `paydown` seconds for every second of racing. The
  // accounting is exact and the map shows a racer who has visibly had a moment.
  let effectiveMs = racer.speedMs;
  if (racer.timeDebtS > 0) {
    const paydown = TUNING.incidents.debtPaydownFraction;
    const paid = Math.min(racer.timeDebtS, paydown * TICK_SECONDS);
    // If the remaining debt is smaller than a full tick's payment, only slow
    // down for the fraction of the tick it actually takes to clear it.
    const fractionSlowed = paid / (paydown * TICK_SECONDS);
    effectiveMs = racer.speedMs * (1 - paydown * fractionSlowed);
    racer.timeDebtS -= paid;
  }

  racer.distanceM += effectiveMs * TICK_SECONDS;
  // What the timing tower and the map should show is the speed they are
  // actually making good, not the speed they wish they were doing.
  racer.speedMs = effectiveMs;
};

const updateLateralOffset = (
  racer: RacerRuntime,
  ahead: Traffic | undefined,
  ctx: TickContext,
): void => {
  const passing = ctx.elapsedS < racer.passingUntilS;
  let goalM = 0;

  if (passing) {
    goalM = racer.passingSide * TUNING.traffic.passingOffsetM;
  } else if (
    ahead !== undefined &&
    ahead.gapM < TUNING.traffic.closingDistanceM &&
    ctx.toggles.traffic
  ) {
    // Queued traffic fans out slightly so a train reads as several racers
    // rather than one marker.
    goalM = (racer.position % 2 === 0 ? 1 : -1) * TUNING.traffic.queueOffsetM;
    racer.passingSide = 0;
  } else {
    racer.passingSide = 0;
  }

  const step = TUNING.traffic.lateralReturnMs * TICK_SECONDS;
  const delta = goalM - racer.lateralOffsetM;
  racer.lateralOffsetM += clamp(delta, -step, step);
};

export type { Traffic };
