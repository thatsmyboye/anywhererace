import type { EnduranceModel } from '@anywhererace/core';

/**
 * Every tuning constant in the simulation, in one place, each one explained.
 *
 * CLAUDE.md's rule: no magic numbers inline, and every constant carries the
 * reason it holds the value it does. If you are here to make a race "feel"
 * different, this file is the only place you should need to touch — and
 * changing anything here changes golden results, so bump SIM_VERSION.
 *
 * These values are a first calibration pass. They were chosen to satisfy the
 * sanity table in `test/sanity-ranges.test.ts` and to make the archetypes
 * narratively legible; they have not been tuned against real race footage.
 */

/** Simulation rate. Fixed, and decoupled from rendering. */
export const SIM_HZ = 20;
export const TICK_SECONDS = 1 / SIM_HZ;

export const TUNING = {
  effort: {
    /**
     * Fraction of a class's top speed it can hold indefinitely, by endurance
     * model. This is what separates a runner's 24kph sprint from their 18kph
     * race pace without needing a second speed field on every vehicle.
     */
    sustainableEffort: {
      none: 1.0,
      stamina: 0.76,
      fuel: 0.98,
      battery: 0.92,
    } satisfies Record<EnduranceModel, number>,

    /**
     * How much of a racer's pace comes from skill. A skill-0 racer runs at
     * `minSkillScale` of a skill-1 racer's pace.
     *
     * 12% across the full skill range is about 8 minutes over a 40km bike race.
     * It has to be this wide to keep skill the dominant term: personality is
     * supposed to shape the *shape* of the performance curve while skill scales
     * it, and the pacing swing alone is +/-6%. At a narrower setting the
     * lowest-skill racer in a field routinely beat the highest, which is
     * exactly backwards.
     */
    minSkillScale: 0.88,

    /**
     * Peak-to-trough swing of the pacing curve. pacing=0 starts 6% hot and
     * ends 6% down; pacing=1 does the reverse. Large enough that a Closer
     * visibly reels in a Front-Runner, small enough that pacing alone never
     * beats a large skill gap.
     */
    pacingAmplitude: 0.06,

    /**
     * Standard deviation of the per-tick pace noise at consistency=0, as a
     * fraction of target speed. At consistency=1 the noise is zero. 2.5% is
     * roughly the lap-to-lap spread of a nervous club driver.
     */
    maxNoiseFraction: 0.025,

    /**
     * Pace noise is drawn per tick but smoothed over this many seconds. Without
     * smoothing, 20Hz white noise averages out to nothing and consistency stops
     * mattering; this makes it drift over a corner-sized timescale instead.
     */
    noiseSmoothingS: 2.5,
  },

  gradient: {
    /**
     * Climb penalty: speed multiplier is `1 / (1 + sensitivity * grade * scale)`.
     * At scale=10 a road cyclist (sensitivity 1.3) on a 5% grade holds about
     * 61% of flat pace — 38kph becomes 23kph, which is where a strong rider
     * actually is on that grade.
     */
    climbScale: 10,

    /**
     * Descent gain: `1 + gain * |grade| * descentBenefit`. At gain=3 a cyclist
     * (benefit 0.9) picks up 13.5% on a 5% descent; a runner (benefit 0.15)
     * picks up 2%, which is about right — you cannot free-wheel on foot.
     */
    descentGain: 3.0,

    /** Ceiling on the descent bonus, so a cliff does not produce a rocket. */
    maxDescentMultiplier: 1.4,

    /** Grades beyond this are treated as walls; guards against bad DEM data. */
    maxAbsGrade: 0.35,
  },

  weather: {
    /** Rain rate (mm/h) at which the wet-grip penalty is fully applied. */
    fullWetMmPerHour: 4,

    /** Grip lost in full wet, before weatherSkill. Standing water is brutal. */
    wetGripLoss: 0.28,

    /** Straight-line speed lost in full wet from spray and visibility. */
    wetVisibilityLoss: 0.06,

    /** Extra visibility loss under full cloud, i.e. gloom. Deliberately tiny. */
    cloudVisibilityLoss: 0.01,

    /**
     * How much weatherSkill offsets wet penalties. At 0.6, a weatherSkill=1
     * racer keeps 60% of what a weatherSkill=0 racer loses — enough for a
     * Veteran to make the rain their race without making it a free win.
     */
    weatherSkillOffset: 0.6,

    /** Grip is best near this temperature; colder is worse. */
    idealTemperatureC: 22,

    /** Grip lost per degree below ideal, capped by `maxColdGripLoss`. */
    coldGripLossPerDeg: 0.004,
    maxColdGripLoss: 0.12,

    /**
     * Wind sensitivity: `dragArea / massKg * scale`, giving roughly 0.7 for a
     * runner, 0.38 for a cyclist and 0.05 for a city car. A 5m/s headwind then
     * costs the cyclist about 7kph and the car about 1kph, which matches the
     * intent that headwinds are a real tactical factor for the light classes.
     */
    windSensitivityScale: 100,

    /** Ceiling on wind sensitivity, so no class is stopped dead by a gust. */
    maxWindSensitivity: 0.8,
  },

  draft: {
    /** Time gap (seconds) inside which a slipstream exists at all. */
    maxGapS: 2.0,

    /** Time gap below which dirty air starts hurting a following racer. */
    dirtyAirGapS: 0.8,

    /**
     * Best-case slipstream gain as a fraction of target speed, before
     * per-class `draftBenefit` and `draftAwareness`. 8% is a strong tow.
     */
    maxGainFraction: 0.08,

    /**
     * Grip lost sitting in dirty air right behind another racer. Matters most
     * for the downforce classes, which is why it scales with lateralGripG.
     */
    dirtyAirGripLoss: 0.06,

    /**
     * Floor on how much of the slipstream a draftAwareness=0 racer gets. They
     * are not blind to it, they just sit in the wrong place.
     */
    minAwarenessFraction: 0.35,
  },

  cornering: {
    /**
     * riskTolerance swing on the cornering limit: the gap between a tidy line
     * and one that has the car sliding. Visible on the stopwatch, and paid for
     * through the incident model.
     *
     * Kept deliberately smaller than the skill span below. At ±6% bravery was
     * worth more corner speed than talent, and a low-skill Charger beat a
     * high-skill field on a twisty circuit as a matter of routine.
     */
    riskAmplitude: 0.03,

    /**
     * Skill's effect on cornering: a skill-0 racer finds only this fraction of
     * the grip a skill-1 racer does.
     *
     * Skill has to scale the *whole* performance curve, not just the
     * straight-line term. When it only scaled power, riskTolerance was worth an
     * 8% pace swing on a corner-limited track against skill's nothing, so on
     * anything twisty the bravest racer beat the best one regardless of skill.
     *
     * Note that this raises a racer's *own* limit rather than letting them
     * exceed it, so — unlike riskTolerance — it does not increase their
     * mistake rate. Being good is not the same as being brave.
     *
     * The 15% span has to comfortably exceed the risk swing above, or the
     * bravest racer beats the best one on anything with corners in it.
     */
    minCornerSkillScale: 0.85,

    /**
     * How far ahead to look for corners when deciding to brake, as a multiple
     * of the distance needed to scrub to a stop. 1.2 leaves margin for the
     * discrete 5m node spacing without braking absurdly early.
     */
    lookaheadFactor: 1.2,

    /** Hard ceiling on lookahead, so a fast class does not scan the whole lap. */
    maxLookaheadM: 600,

    /** Radii above this are treated as straight, avoiding Infinity arithmetic. */
    straightRadiusM: 2000,
  },

  traffic: {
    /** Distance behind a racer at which traffic logic engages at all. */
    closingDistanceM: 30,

    /**
     * A pass is only attempted if the attacker is at least this much faster.
     * Without it, cars nose-to-tail at identical pace would roll dice forever.
     */
    minSpeedDeltaMs: 0.4,

    /**
     * The pace advantage is smoothed over this long before it is allowed to
     * trigger or resolve a pass.
     *
     * This matters more than it looks. Two racers at different points on a lap
     * have wildly different instantaneous target speeds — one is on a straight,
     * the other is in a corner — so an unsmoothed delta lets a genuinely
     * slower racer roll for a pass every time the geometry flatters them. The
     * result was a congested race becoming a lottery in which finishing order
     * barely correlated with pace at all.
     */
    paceAdvantageSmoothingS: 3,

    /**
     * Pace advantage at which the success roll gets its full bonus. Real
     * fights are decided by fractions of a m/s, so this has to be small; at a
     * coarser setting the speed-delta term never does anything.
     */
    decisiveAdvantageMs: 2,
    decisiveAdvantageBonus: 0.25,

    /** Base per-tick chance of *attempting* a pass, before traits. */
    baseAttemptPerTick: 0.02,

    /** aggression and ambition multiply the attempt rate up to this factor. */
    maxAttemptMultiplier: 4.0,

    /**
     * Race progress past which `ambition` starts contributing to the attempt
     * rate. This is the whole point of the trait: a low-percentage move at
     * one-third distance is not ambition, it is stupidity.
     */
    ambitionEngagesAtProgress: 0.6,

    /** Closer than this to the racer ahead and you are stuck behind them. */
    minFollowDistanceM: 4,

    /**
     * How long a won pass gets to complete before traffic logic re-engages.
     *
     * This has to be long enough to actually clear the racer ahead. Closing
     * speeds in a real fight are well under 1 m/s, so a window of a few seconds
     * lets a racer win the roll, edge alongside, run out of time, and drop back
     * — forever. Twelve seconds is roughly the length of a real move.
     */
    passWindowS: 12,

    /**
     * A racer committed to a move has pulled offline, out of the wake of the
     * car ahead, so the dirty-air grip penalty stops applying to them while the
     * defender keeps giving them a tow. That asymmetry — not a speed bonus — is
     * what lets a pass complete.
     *
     * An earlier version granted a flat speed multiplier instead. It worked,
     * but it was a free advantage available to everybody *except* the leader,
     * who has nobody to pass: across 30 seeds the fastest racer in the field
     * finished second ten times and won zero. Anything that helps a racer must
     * come from something the leader could also have.
     */
    clearsDirtyAirWhilePassing: true,

    /**
     * Lateral offset a queued racer drifts to so a train of markers does not
     * render as one dot. Purely presentational, but it lives here because it
     * feeds `lateralOffset`, which the sim owns.
     */
    queueOffsetM: 0.6,

    /**
     * Width, in vehicle widths, needed for a clean side-by-side pass. Below
     * 2.0 there is physically no room and the attempt probability collapses —
     * which is what makes single-track trail passing dramatic.
     */
    widthForCleanPass: 2.2,

    /** Base success probability at equal racecraft and adequate width. */
    baseSuccessChance: 0.5,

    /** How far racecraft difference swings the success roll. */
    racecraftSwing: 0.4,

    /** Seconds lost by the attacker on a failed pass. */
    failedPassCostS: 0.6,

    /** Chance that a failed pass also triggers a mistake roll immediately. */
    failedPassMistakeChance: 0.18,

    /** Lateral offset (meters) a racer takes when running side by side. */
    passingOffsetM: 1.2,

    /** How fast lateral offset moves back to the racing line, m/s. */
    lateralReturnMs: 0.8,
  },

  /**
   * Reading the shape of the field: who is riding with whom.
   *
   * Observation only. Nothing here feeds back into a racer's speed, no roll is
   * made against any of it, and switching it off would not change a single
   * finishing time — which is why there is no debug toggle for it and why it
   * cannot move the determinism goldens. See `groups.ts`.
   */
  groups: {
    /**
     * Time gap at which two racers stop counting as being in the same group.
     *
     * Expressed in seconds of road rather than meters because that is how a
     * bike race is actually called ("the break is at eight seconds") and
     * because it stays meaningful across classes: eight seconds is eight
     * seconds whether the field is doing 40kph or 300.
     *
     * Set well above `draft.maxGapS` on purpose. Two seconds is the physical
     * limit of the slipstream; a group is a looser thing than that, and a rider
     * who has slipped to four seconds is off the wheel but has not yet been
     * dropped.
     */
    splitGapS: 12,

    /**
     * Time gap at which two racers in *different* groups become one group
     * again. Deliberately far tighter than `splitGapS`.
     *
     * This asymmetry is the single most important number here. With one
     * threshold, a field whose natural spacing sits anywhere near it flaps
     * across it forever: a rider at 12.1 seconds is a new group, at 11.9 they
     * are back, and a five-hour race emits over a thousand "moves" that are
     * really one rider holding station. Requiring them to actually close the
     * gap to rejoin means a break has to be genuinely made *and* genuinely
     * pulled back before either is reported. Measured on a 30-rider,
     * five-hour bunch race, adding this cut group moves from ~1600 to a
     * readable handful without losing a single real one.
     *
     * It is also what a commentator does. A gap is called once it opens and
     * stays called until it is properly closed, not un-called every time it
     * wobbles by a tenth.
     */
    mergeGapS: 5,

    /**
     * How often the field's shape is re-read, in seconds. There is no reason to
     * do this at 20Hz: a group taking shape is a thing that happens over tens
     * of seconds, and sampling at tick rate would only buy noise.
     */
    sampleIntervalS: 1,

    /**
     * Consecutive samples a new shape has to survive before it is believed.
     *
     * Hysteresis handles the flapping; this handles the transient. A rider
     * gapped through one corner and back on the exit has not attacked, and
     * twenty seconds is roughly when a commentator stops saying "he's got a
     * small gap" and starts saying "he's gone".
     */
    confirmSamples: 20,

    /**
     * Grace period after the start before any of this is reported.
     *
     * The grid is laid out over `grid.slotSpacingM` and everyone accelerates
     * from a standstill, so for the first seconds the field is arithmetically a
     * dozen "groups" that are really one bunch that has not got going yet.
     * Reporting the field coming together off the line as a series of catches
     * would be describing the start as if it were a race move.
     */
    settleS: 20,
  },

  incidents: {
    /**
     * Base per-tick mistake hazard at full effort, zero composure, dry. At
     * 20Hz over a one-hour race this yields on the order of one or two
     * incidents for a low-composure racer and near zero for a Veteran.
     */
    basePerTick: 0.000025,

    /**
     * How much exceeding the grip limit multiplies the hazard.
     *
     * This is what makes risk a trade rather than a free lunch. At a low
     * setting, running a few percent over the limit bought far more lap time
     * than it ever cost in incidents, so the optimal racer was simply the
     * bravest one and personality collapsed to a single dominant trait.
     */
    overDriveScale: 40,

    /** Multiplier at zero composure; composure=1 removes this entirely. */
    composureScale: 3.0,

    /** Multiplier in full wet. */
    wetScale: 2.5,

    /** Skill reduces the hazard by up to this fraction at skill=1. */
    skillMitigation: 0.5,

    /**
     * Outcome split once a mistake happens. Must sum to 1.
     *
     * `crash` is the fraction that are *crash-severity* — the big moment. It is
     * no longer the fraction that end the race: whether a crash-severity moment
     * is terminal is decided separately, per vehicle (`crashProneness`) and
     * normalized to race duration (`race.ts`), because a foot or bicycle
     * incident is usually survivable and a car one usually is not. A
     * crash-severity moment that is survived becomes a heavy time loss instead.
     */
    outcomeWeights: { lockup: 0.72, spin: 0.24, crash: 0.04 },

    /**
     * The nominal race duration the crash-out odds are quoted against, mirroring
     * `reliability.nominalRaceDurationS`. A crash-severity moment fires at a
     * per-tick rate, so without normalizing to this a multi-hour race would
     * accumulate far more terminal crashes than an hour-long one — which is
     * exactly what emptied the finishing order of long bicycle and foot races.
     */
    crashNominalDurationS: 3600,

    /** Time cost ranges, seconds. */
    lockupCostS: [0.3, 1.2] as const,
    spinCostS: [3.0, 9.0] as const,
    /**
     * A crash-severity moment that is survived: a fall and remount, a run-off, a
     * spin through the gravel. Costs much more than an ordinary spin, but the
     * racer continues — which is what a runner or cyclist almost always does.
     */
    crashRecoveryCostS: [12.0, 30.0] as const,

    /**
     * Time losses are booked as a debt and paid off by running slower, rather
     * than by teleporting a racer backwards. At 0.6 a racer serving a penalty
     * runs at 40% pace, so a 6-second spin costs 10 seconds of visibly
     * hobbled running — which is both exactly accountable and legible on the
     * map, where a car that has spun should look like it has spun.
     */
    debtPaydownFraction: 0.6,

    /**
     * After a mistake, a racer's effort is depressed and their mistake hazard
     * raised for this long, scaled down by composure. This is what makes
     * "mistakes compound" for a Rookie and not for a Veteran.
     */
    rattledDurationS: 25,
    rattledEffortLoss: 0.05,
    rattledHazardMultiplier: 2.0,
  },

  endurance: {
    /**
     * Reservoir drain per second at full effort, as a fraction of the tank,
     * by model. Stamina is sized so a runner fades noticeably in the last
     * quarter of an hour-long race; fuel and battery drain to roughly empty
     * over a nominal race distance.
     */
    drainPerSecond: {
      none: 0,
      stamina: 1 / 5400, // full tank ≈ 90 minutes at race effort
      fuel: 1 / 7200,
      battery: 1 / 4500, // batteries are the tightest constraint on purpose
    } satisfies Record<EnduranceModel, number>,

    /**
     * Drain scales with (effort / sustainable)^2 — going 10% over sustainable
     * costs about 21% more. This is what punishes a Front-Runner.
     */
    drainEffortExponent: 2,

    /** Below this reservoir fraction, effort starts being capped. */
    fadeThreshold: 0.25,

    /** Effort multiplier at a fully empty reservoir. */
    emptyEffortMultiplier: 0.72,

    /** Heat above this makes stamina classes drain faster. */
    heatStressAboveC: 24,
    heatDrainPerDegree: 0.02,
  },

  reliability: {
    /**
     * `reliability` is the probability of completing a *nominal* race without a
     * mechanical. This is the nominal duration it is quoted against; the
     * per-tick hazard is scaled from the actual expected race duration so a
     * 5-lap sprint is not as risky as a 50-lap enduro.
     */
    nominalRaceDurationS: 3600,
  },

  grid: {
    /** Spacing between grid slots along the route, in meters. */
    slotSpacingM: 8,

    /** Lateral stagger between adjacent grid slots, in meters. */
    lateralStaggerM: 1.5,

    /** How many slots per row before the row offset resets. */
    slotsPerRow: 2,
  },

  race: {
    /** Ticks after the leader finishes before we stop waiting for stragglers. */
    maxTicksAfterLeaderFinish: SIM_HZ * 60 * 20,

    /**
     * Absolute cap on race length. A misconfigured race (a 40km course for
     * e-scooters up a mountain) must terminate rather than hang the worker.
     */
    maxTicks: SIM_HZ * 60 * 60 * 6,

    /** Race is over for a racer once they cross this distance. */
    finishToleranceM: 0.001,
  },

  showboat: {
    /** Lead in seconds over the racer behind before showboating engages. */
    comfortableLeadS: 12,
    /** Maximum effort given up while showboating, at modifier 1. */
    maxEasing: 0.06,
  },

  choker: {
    /** Composure lost while running P1, scaled by leadingComposurePenalty. */
    maxComposureLoss: 0.6,
  },
} as const;

/**
 * Every part of the tick that can be switched off from the debug panel, so a
 * race that "felt wrong" can be bisected. All default on; turning any of them
 * off changes results and is not a valid way to produce a shareable race.
 */
export type DebugToggles = {
  gradient: boolean;
  surface: boolean;
  weather: boolean;
  wind: boolean;
  draft: boolean;
  endurance: boolean;
  personality: boolean;
  traffic: boolean;
  incidents: boolean;
  mechanicalFailures: boolean;
};

export const ALL_TOGGLES_ON: DebugToggles = {
  gradient: true,
  surface: true,
  weather: true,
  wind: true,
  draft: true,
  endurance: true,
  personality: true,
  traffic: true,
  incidents: true,
  mechanicalFailures: true,
};
