import type { Rng, Track } from '@anywhererace/core';
import { clamp01, createRng, err, kphToMs, ok } from '@anywhererace/core';
import type { Result } from '@anywhererace/core';
import type { VehicleClass } from './data/vehicles';
import { getVehicleClass } from './data/vehicles';
import type { Personality, SituationalModifiers, Traits } from './traits';
import { getArchetype, rollTraits } from './traits';
import { TUNING } from './tuning';
import type { LapRecord, RaceConfig, RaceInput, RacerSpec, RacerStatus, SimError } from './types';

/**
 * How a racer responded to being dropped.
 *
 * `none` covers both "still in a group" and "riding alone having never been in
 * one", which are the same thing as far as behavior goes: nothing to react to.
 */
export type DroppedResponse = 'none' | 'chase' | 'sit-up' | 'wait';

/** Mutable per-racer state. Lives for one race and is never shared between races. */
export type RacerRuntime = {
  readonly spec: RacerSpec;
  readonly traits: Traits;
  readonly modifiers: SituationalModifiers;
  readonly skill: number;
  /** This racer's own RNG sub-stream. Forked from the race seed by racer id. */
  readonly rng: Rng;

  /** Meters past the start line. Negative on the grid, before the green flag. */
  distanceM: number;
  speedMs: number;
  lateralOffsetM: number;
  lap: number;
  status: RacerStatus;
  position: number;

  /** 0-1 endurance reservoir: stamina, fuel, or battery. */
  reservoir: number;
  /** Smoothed pace noise, in fractional speed units. */
  noise: number;
  /** Seconds of time loss still to be worked off. */
  timeDebtS: number;
  /**
   * Smoothed pace advantage over the racer ahead, m/s. Smoothed because the
   * instantaneous difference mostly reflects where each racer happens to be on
   * the lap, not which of them is quicker.
   */
  paceAdvantageMs: number;
  /** Elapsed time until which the racer is rattled after a mistake. */
  rattledUntilS: number;
  /** Elapsed time until which a won pass is allowed to complete. */
  passingUntilS: number;
  /** Side the racer is passing on: +1 right, -1 left, 0 not passing. */
  passingSide: number;
  /** Elapsed time until which this racer is pressing a committed attack. */
  attackingUntilS: number;
  /** Elapsed time before which they will not commit to another one. */
  attackReadyAtS: number;

  /**
   * When this racer took the front of their group, or -1 when they are not on
   * it. A turn on the front is a stretch of time, so it needs a start.
   */
  pullStartedS: number;
  /**
   * Elapsed time by which a swing off the front must be over, or 0 when not
   * swinging. A deadline rather than a flag because the swing normally ends on a
   * condition — being several wheels back into the group — and something has to
   * stop a rider easing forever if that condition never arrives.
   */
  swingOffUntilS: number;

  /**
   * What this racer decided to do about losing the wheel, and until when.
   * Rolled once at the moment contact goes; see `TUNING.bunch.dropped`.
   */
  droppedResponse: DroppedResponse;
  droppedUntilS: number;
  /**
   * Size of the group they were in last tick. The only way to notice the
   * *transition* — being dropped is an event, and `BunchState` only ever
   * describes the present.
   */
  lastGroupSize: number;

  lapStartS: number;
  sectorStartS: number;
  currentSector: number;
  laps: LapRecord[];
  currentSectors: { sector: number; timeS: number }[];
  bestLapS: number | undefined;
  bestSectorS: number[];

  finishTimeS: number | undefined;
  /** Total distance covered when classified, for ranking DNFs. */
  finalDistanceM: number | undefined;
};

export type RaceSetup = {
  readonly track: Track;
  readonly config: RaceConfig;
  readonly vehicle: VehicleClass;
  readonly racers: RacerRuntime[];
  /** Class top speed in m/s. Derived once so the tick never converts units. */
  readonly topSpeedMs: number;
  /**
   * How much a headwind or tailwind moves this class, as m/s of speed change
   * per m/s of wind along the direction of travel. Derived from CdA over mass:
   * roughly 0.7 for a runner, 0.38 for a cyclist, 0.06 for a city car.
   */
  readonly windSensitivity: number;
  /** Total race distance in meters from the start line to the finish. */
  readonly raceDistanceM: number;
  readonly lapLengthM: number;
  readonly totalLaps: number;
  /** Sector boundaries as distances into a lap, ascending, excluding 0. */
  readonly sectorBoundariesM: number[];
  /** Rough expected duration, used to scale the mechanical-failure hazard. */
  readonly expectedDurationS: number;
  readonly raceRng: Rng;
};

const MIN_FIELD = 2;
const MAX_FIELD = 40;
/** Below this a "lap" is meaningless and the node profile is degenerate. */
const MIN_TRACK_LENGTH_M = 50;

export const prepareRace = (input: RaceInput): Result<RaceSetup, SimError> => {
  const { track, config } = input;

  if (track.nodes.length === 0) {
    return err({ kind: 'empty-track', message: 'Track has no baked nodes. Bake it first.' });
  }
  if (track.lengthMeters < MIN_TRACK_LENGTH_M) {
    return err({
      kind: 'track-too-short',
      message: `Track is ${track.lengthMeters.toFixed(0)}m; the minimum is ${MIN_TRACK_LENGTH_M}m.`,
    });
  }

  const vehicle = getVehicleClass(config.vehicleClassId);
  if (vehicle === undefined) {
    return err({
      kind: 'unknown-vehicle-class',
      message: `No vehicle class "${config.vehicleClassId}".`,
      subject: config.vehicleClassId,
    });
  }

  if (config.racers.length < MIN_FIELD || config.racers.length > MAX_FIELD) {
    return err({
      kind: 'invalid-field-size',
      message: `Field size must be between ${MIN_FIELD} and ${MAX_FIELD}; got ${config.racers.length}.`,
    });
  }
  if (config.fieldSize !== config.racers.length) {
    return err({
      kind: 'invalid-field-size',
      message: `fieldSize is ${config.fieldSize} but ${config.racers.length} racers were supplied.`,
    });
  }

  const totalLaps = track.mode === 'circuit' ? config.laps : 1;
  if (track.mode === 'circuit' && (!Number.isInteger(config.laps) || config.laps < 1)) {
    return err({
      kind: 'invalid-laps',
      message: `Circuit races need at least one whole lap; got ${config.laps}.`,
    });
  }

  const seen = new Set<string>();
  for (const racer of config.racers) {
    if (seen.has(racer.id)) {
      return err({
        kind: 'duplicate-racer-id',
        message: `Two racers share the id "${racer.id}".`,
        subject: racer.id,
      });
    }
    seen.add(racer.id);

    if (!(racer.skill >= 0 && racer.skill <= 1)) {
      return err({
        kind: 'invalid-skill',
        message: `Racer "${racer.name}" has skill ${racer.skill}; it must be within 0-1.`,
        subject: racer.id,
      });
    }
    if (typeof racer.personality === 'string' && getArchetype(racer.personality) === undefined) {
      return err({
        kind: 'unknown-personality',
        message: `No personality archetype "${racer.personality}".`,
        subject: racer.id,
      });
    }
    if (config.gridOrder === 'manual' && racer.gridSlot === undefined) {
      return err({
        kind: 'missing-grid-slot',
        message: `Grid order is manual but racer "${racer.name}" has no gridSlot.`,
        subject: racer.id,
      });
    }
  }

  const raceRng = createRng(config.seed);
  const gridOrder = orderGrid(config, raceRng.fork('grid'));

  const racers = gridOrder.map((spec, slot) => createRuntime(spec, slot, raceRng));

  const lapLengthM = track.lengthMeters;
  const raceDistanceM =
    track.mode === 'circuit'
      ? lapLengthM * totalLaps
      : distanceBetweenLines(track);

  return ok({
    track,
    config,
    vehicle,
    racers,
    topSpeedMs: kphToMs(vehicle.topSpeedKph),
    windSensitivity: Math.min(
      TUNING.weather.maxWindSensitivity,
      (vehicle.dragArea / vehicle.massKg) * TUNING.weather.windSensitivityScale,
    ),
    raceDistanceM,
    lapLengthM,
    totalLaps,
    sectorBoundariesM: sectorBoundaries(track),
    expectedDurationS: estimateDurationS(raceDistanceM, vehicle),
    raceRng,
  });
};

/**
 * Point-to-point races run from the start line to the finish line as baked.
 * Falling back to the full route length keeps a track that was saved before
 * lines were placed racable rather than zero-length.
 */
const distanceBetweenLines = (track: Track): number => {
  const span = track.finishLine - track.startLine;
  return span > 0 ? span : track.lengthMeters;
};

/** Sector boundaries expressed as distances into a lap from the start line. */
const sectorBoundaries = (track: Track): number[] => {
  const lap = track.lengthMeters;
  return track.sectors
    .map((distance) => {
      let offset = (distance - track.startLine) % lap;
      if (offset < 0) offset += lap;
      return offset;
    })
    .filter((offset) => offset > 0)
    .sort((a, b) => a - b);
};

/**
 * Rough race duration, used only to scale the per-tick mechanical hazard so
 * that a five-lap sprint is not as likely to break a car as a fifty-lap enduro.
 * Deliberately crude — it does not need to be accurate, only proportional.
 */
const estimateDurationS = (raceDistanceM: number, vehicle: VehicleClass): number => {
  const sustainable = TUNING.effort.sustainableEffort[vehicle.enduranceModel];
  // The 0.8 accounts for corners, junctions and traffic, none of which are
  // known at this point.
  const assumedSpeedMs = kphToMs(vehicle.topSpeedKph) * sustainable * 0.8;
  return raceDistanceM / assumedSpeedMs;
};

const orderGrid = (config: RaceConfig, rng: Rng): RacerSpec[] => {
  const racers = config.racers;
  switch (config.gridOrder) {
    case 'random':
      return rng.shuffled(racers);
    case 'by-skill':
      return racers.slice().sort((a, b) => b.skill - a.skill || compareIds(a, b));
    case 'reverse-skill':
      return racers.slice().sort((a, b) => a.skill - b.skill || compareIds(a, b));
    case 'manual':
      return racers
        .slice()
        .sort((a, b) => (a.gridSlot ?? 0) - (b.gridSlot ?? 0) || compareIds(a, b));
  }
};

/**
 * Tie-break on racer id, always. Without it, two racers with identical skill
 * would be ordered by whatever `Array.prototype.sort` happened to do, and the
 * grid — and therefore the race — would stop being reproducible.
 */
const compareIds = (a: RacerSpec, b: RacerSpec): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const createRuntime = (spec: RacerSpec, slot: number, raceRng: Rng): RacerRuntime => {
  // Forked by racer id, not by grid slot: adding a racer to the field must not
  // shift anybody else's stream.
  const rng = raceRng.fork(`racer:${spec.id}`);

  const personality: Personality =
    typeof spec.personality === 'string'
      ? // Validated in prepareRace, so the lookup cannot miss here.
        (getArchetype(spec.personality) as Personality)
      : spec.personality;

  const row = Math.floor(slot / TUNING.grid.slotsPerRow);
  const column = slot % TUNING.grid.slotsPerRow;
  // Pole sits on the line; everyone else is staggered back and to the side.
  const startDistanceM = -(row * TUNING.grid.slotSpacingM);
  const startLateralM =
    (column - (TUNING.grid.slotsPerRow - 1) / 2) * TUNING.grid.lateralStaggerM;

  return {
    spec,
    traits: rollTraits(personality, rng.fork('traits')),
    modifiers: personality.modifiers,
    skill: clamp01(spec.skill),
    rng: rng.fork('race'),

    distanceM: startDistanceM,
    speedMs: 0,
    lateralOffsetM: startLateralM,
    lap: 0,
    status: 'racing',
    position: slot + 1,

    reservoir: 1,
    noise: 0,
    timeDebtS: 0,
    paceAdvantageMs: 0,
    rattledUntilS: 0,
    passingUntilS: 0,
    passingSide: 0,
    attackingUntilS: 0,
    attackReadyAtS: 0,
    pullStartedS: -1,
    swingOffUntilS: 0,
    droppedResponse: 'none',
    droppedUntilS: 0,
    lastGroupSize: 1,

    lapStartS: 0,
    sectorStartS: 0,
    currentSector: 0,
    laps: [],
    currentSectors: [],
    bestLapS: undefined,
    bestSectorS: [],

    finishTimeS: undefined,
    finalDistanceM: undefined,
  };
};
