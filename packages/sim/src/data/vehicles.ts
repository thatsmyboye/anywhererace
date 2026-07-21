import type { EnduranceModel, SurfaceType, VehicleCategory, VehicleClassId } from '@anywhererace/core';

/**
 * Vehicle classes are data. The physics reads these numbers and contains no
 * per-vehicle special cases — if a class needs to behave differently, it needs
 * a different number here, not a branch in the tick.
 *
 * NOTE: CLAUDE.md places this file at `packages/sim/data/vehicles.ts`; it lives
 * under `src/` so it is inside the package's compilation root.
 *
 * Three fields extend the struct sketched in CLAUDE.md. Each is here because
 * the tick genuinely could not be written without it:
 *
 *   descentBenefit — `gradientSensitivity` cannot serve double duty. A runner
 *     and a cyclist both suffer badly going up; only one of them gets anything
 *     back coming down.
 *   draftBenefit  — `dragArea` alone gets slipstream backwards, because the
 *     benefit depends on what fraction of a class's resistance is aerodynamic,
 *     not on its absolute frontal area.
 *   widthMeters   — pass resolution needs to compare vehicle width against
 *     `TrackNode.widthMeters`. This is what makes single-track passing hard.
 */
export type VehicleClass = {
  id: VehicleClassId;
  label: string;
  category: VehicleCategory;

  /** Flat, still-air, full-effort maximum. Race pace is a fraction of this. */
  topSpeedKph: number;
  /** Acceleration available at a given speed, m/s^2. */
  accelCurve: (speedKph: number) => number;
  /** Peak deceleration, m/s^2. */
  brakingMs2: number;
  /** Lateral grip in g; drives `sqrt(grip * g * radius)` cornering. */
  lateralGripG: number;

  massKg: number;
  /** CdA in m^2. Drives wind sensitivity. */
  dragArea: number;
  /** Physical width, meters. Compared against track width for overtaking. */
  widthMeters: number;

  /** How much hills hurt. High for bikes and runners. */
  gradientSensitivity: number;
  /** 0-1: how much of a descent is converted into speed. */
  descentBenefit: number;
  /** 0-1: how much of the maximum slipstream this class realizes. */
  draftBenefit: number;

  /** 0-1 speed multiplier per surface. */
  surfacePenalty: Record<SurfaceType, number>;
  enduranceModel: EnduranceModel;
  /** 0-1 probability of finishing a nominal race without a mechanical. */
  reliability: number;
};

/**
 * Acceleration curve generator: full `peakMs2` from a standstill, falling to
 * zero at top speed. The square term (written as a multiplication, never
 * `Math.pow`, which ECMAScript leaves implementation-approximated) makes the
 * fall-off gentle at first and steep near the top, which is how both engines
 * and legs actually behave.
 */
const accelCurve =
  (peakMs2: number, topSpeedKph: number) =>
  (speedKph: number): number => {
    const ratio = speedKph <= 0 ? 0 : speedKph / topSpeedKph;
    if (ratio >= 1) return 0;
    return peakMs2 * (1 - ratio * ratio);
  };

/**
 * Surface multiplier sets. Grouped by what is actually touching the ground,
 * because that — not the vehicle's price — is what decides whether gravel is
 * an inconvenience or the end of the race.
 */
const SURFACES = {
  feet: {
    asphalt: 1.0,
    concrete: 1.0,
    gravel: 0.95,
    dirt: 0.94,
    cobble: 0.93,
    trail: 0.9,
    sand: 0.7,
    grass: 0.92,
  },
  roadTires: {
    asphalt: 1.0,
    concrete: 0.99,
    gravel: 0.72,
    dirt: 0.65,
    cobble: 0.7,
    trail: 0.6,
    sand: 0.3,
    grass: 0.55,
  },
  smallWheels: {
    // Small-diameter wheels fall into everything. An e-scooter on cobbles is
    // barely a vehicle.
    asphalt: 1.0,
    concrete: 0.98,
    gravel: 0.55,
    dirt: 0.5,
    cobble: 0.55,
    trail: 0.45,
    sand: 0.2,
    grass: 0.45,
  },
  hybridTires: {
    asphalt: 1.0,
    concrete: 0.99,
    gravel: 0.8,
    dirt: 0.72,
    cobble: 0.78,
    trail: 0.68,
    sand: 0.35,
    grass: 0.62,
  },
  roadCarTires: {
    asphalt: 1.0,
    concrete: 0.99,
    gravel: 0.75,
    dirt: 0.68,
    cobble: 0.85,
    trail: 0.5,
    sand: 0.35,
    grass: 0.55,
  },
  performanceTires: {
    // Low profile, wide, and utterly lost the moment the tarmac stops.
    asphalt: 1.0,
    concrete: 0.99,
    gravel: 0.65,
    dirt: 0.55,
    cobble: 0.8,
    trail: 0.4,
    sand: 0.25,
    grass: 0.45,
  },
  rallyTires: {
    // The point of the rally car: gives up a little on tarmac, gives up almost
    // nothing anywhere else.
    asphalt: 0.97,
    concrete: 0.96,
    gravel: 0.95,
    dirt: 0.93,
    cobble: 0.92,
    trail: 0.8,
    sand: 0.7,
    grass: 0.85,
  },
  slicks: {
    asphalt: 1.0,
    concrete: 0.98,
    gravel: 0.45,
    dirt: 0.35,
    cobble: 0.7,
    trail: 0.25,
    sand: 0.15,
    grass: 0.3,
  },
} as const satisfies Record<string, Record<SurfaceType, number>>;

export const VEHICLE_CLASSES: readonly VehicleClass[] = [
  {
    id: 'runner',
    label: 'Runner',
    category: 'foot',
    topSpeedKph: 22,
    accelCurve: accelCurve(2.5, 22),
    brakingMs2: 4,
    lateralGripG: 0.6,
    massKg: 70,
    dragArea: 0.45,
    widthMeters: 0.6,
    gradientSensitivity: 1.15,
    descentBenefit: 0.15,
    draftBenefit: 0.25,
    surfacePenalty: SURFACES.feet,
    enduranceModel: 'stamina',
    // Not mechanical failure so much as a rolled ankle or a blown calf.
    reliability: 0.97,
  },
  {
    id: 'road-cyclist',
    label: 'Road cyclist',
    category: 'micromobility',
    topSpeedKph: 50,
    accelCurve: accelCurve(2.5, 50),
    brakingMs2: 5,
    lateralGripG: 0.7,
    massKg: 78,
    dragArea: 0.3,
    widthMeters: 0.65,
    gradientSensitivity: 1.3,
    descentBenefit: 0.9,
    // Drafting is the defining tactical fact of bike racing.
    draftBenefit: 1.0,
    surfacePenalty: SURFACES.roadTires,
    enduranceModel: 'stamina',
    reliability: 0.96,
  },
  {
    id: 'e-scooter',
    label: 'E-scooter',
    category: 'micromobility',
    topSpeedKph: 25,
    accelCurve: accelCurve(1.5, 25),
    brakingMs2: 3.5,
    lateralGripG: 0.5,
    massKg: 95,
    dragArea: 0.55,
    widthMeters: 0.6,
    // Highest in the set: a scooter meeting a hill is the whole drama of the class.
    gradientSensitivity: 1.6,
    descentBenefit: 0.5,
    draftBenefit: 0.2,
    surfacePenalty: SURFACES.smallWheels,
    enduranceModel: 'battery',
    reliability: 0.93,
  },
  {
    id: 'e-bike',
    label: 'E-bike',
    category: 'micromobility',
    topSpeedKph: 32,
    accelCurve: accelCurve(2.0, 32),
    brakingMs2: 4.5,
    lateralGripG: 0.6,
    massKg: 95,
    dragArea: 0.45,
    widthMeters: 0.65,
    gradientSensitivity: 0.9,
    descentBenefit: 0.7,
    draftBenefit: 0.5,
    surfacePenalty: SURFACES.hybridTires,
    enduranceModel: 'battery',
    reliability: 0.95,
  },
  {
    id: 'city-car',
    label: 'City car',
    category: 'road',
    topSpeedKph: 160,
    accelCurve: accelCurve(3.0, 160),
    brakingMs2: 8,
    lateralGripG: 0.85,
    massKg: 1250,
    dragArea: 0.72,
    widthMeters: 1.7,
    gradientSensitivity: 0.35,
    descentBenefit: 0.5,
    draftBenefit: 0.35,
    surfacePenalty: SURFACES.roadCarTires,
    enduranceModel: 'fuel',
    reliability: 0.97,
  },
  {
    id: 'hot-hatch',
    label: 'Hot hatch',
    category: 'road',
    topSpeedKph: 220,
    accelCurve: accelCurve(4.5, 220),
    brakingMs2: 9.5,
    lateralGripG: 0.95,
    massKg: 1350,
    dragArea: 0.68,
    widthMeters: 1.8,
    gradientSensitivity: 0.28,
    descentBenefit: 0.5,
    draftBenefit: 0.4,
    surfacePenalty: SURFACES.roadCarTires,
    enduranceModel: 'fuel',
    reliability: 0.96,
  },
  {
    id: 'sports-car',
    label: 'Sports car',
    category: 'performance',
    topSpeedKph: 260,
    accelCurve: accelCurve(6.0, 260),
    brakingMs2: 10.5,
    lateralGripG: 1.1,
    massKg: 1500,
    dragArea: 0.62,
    widthMeters: 1.9,
    gradientSensitivity: 0.22,
    descentBenefit: 0.5,
    draftBenefit: 0.45,
    surfacePenalty: SURFACES.performanceTires,
    enduranceModel: 'fuel',
    reliability: 0.95,
  },
  {
    id: 'supercar',
    label: 'Supercar',
    category: 'performance',
    topSpeedKph: 320,
    accelCurve: accelCurve(9.0, 320),
    brakingMs2: 11.5,
    lateralGripG: 1.25,
    massKg: 1600,
    dragArea: 0.6,
    widthMeters: 2.0,
    gradientSensitivity: 0.18,
    descentBenefit: 0.5,
    draftBenefit: 0.5,
    surfacePenalty: SURFACES.performanceTires,
    enduranceModel: 'fuel',
    reliability: 0.93,
  },
  {
    id: 'rally-car',
    label: 'Rally car',
    category: 'motorsport',
    topSpeedKph: 200,
    accelCurve: accelCurve(6.5, 200),
    brakingMs2: 9,
    lateralGripG: 1.0,
    massKg: 1230,
    dragArea: 0.75,
    widthMeters: 1.8,
    gradientSensitivity: 0.22,
    descentBenefit: 0.5,
    draftBenefit: 0.4,
    surfacePenalty: SURFACES.rallyTires,
    enduranceModel: 'fuel',
    // Lowest in the set. Rally cars break, and that is part of the appeal.
    reliability: 0.88,
  },
  {
    id: 'gt-racer',
    label: 'GT racer',
    category: 'motorsport',
    topSpeedKph: 290,
    accelCurve: accelCurve(8.0, 290),
    brakingMs2: 15,
    lateralGripG: 1.6,
    massKg: 1300,
    dragArea: 0.95,
    widthMeters: 2.0,
    gradientSensitivity: 0.18,
    descentBenefit: 0.5,
    draftBenefit: 0.7,
    surfacePenalty: SURFACES.slicks,
    enduranceModel: 'fuel',
    reliability: 0.94,
  },
  {
    id: 'open-wheel-racer',
    label: 'Open-wheel racer',
    category: 'motorsport',
    topSpeedKph: 330,
    accelCurve: accelCurve(12.0, 330),
    // Enormous braking is the point: this class should be won and lost under
    // braking, not on the straights.
    brakingMs2: 25,
    lateralGripG: 2.2,
    massKg: 798,
    dragArea: 1.35,
    widthMeters: 2.0,
    gradientSensitivity: 0.15,
    descentBenefit: 0.5,
    // Huge tow, and a correspondingly nasty amount of dirty air.
    draftBenefit: 0.9,
    surfacePenalty: SURFACES.slicks,
    enduranceModel: 'fuel',
    reliability: 0.9,
  },
];

const BY_ID = new Map(VEHICLE_CLASSES.map((v) => [v.id, v]));

export const getVehicleClass = (id: VehicleClassId): VehicleClass | undefined => BY_ID.get(id);
