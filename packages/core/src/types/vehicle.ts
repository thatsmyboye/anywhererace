/**
 * The category vocabulary is shared: the sim uses it to group behavior, and the
 * UI uses it to decide which classes a track's routing profile permits. The
 * per-class numbers themselves live in `packages/sim/data/vehicles.ts`.
 */
export type VehicleCategory =
  | 'foot'
  | 'micromobility'
  | 'road'
  | 'performance'
  | 'motorsport';

export const VEHICLE_CATEGORIES: readonly VehicleCategory[] = [
  'foot',
  'micromobility',
  'road',
  'performance',
  'motorsport',
];

/** How a class runs out of go. Drives which reservoir the tick drains. */
export type EnduranceModel = 'none' | 'stamina' | 'fuel' | 'battery';

/**
 * How a race of this class *reads*, which is a different question from how it
 * is simulated.
 *
 * Both formats run the identical tick — this changes nothing about physics,
 * incidents, or results. What it changes is how the race is narrated. In a
 * bunch race the field spends most of its distance packed together swapping
 * positions continuously, so reporting every pass is reporting noise: forty
 * riders in a peloton generate hundreds of position changes that mean nothing,
 * and they bury the handful that do. A cycling race is told in *groups* — who
 * attacked, who bridged, what split, what came back together.
 *
 * Derived from the vehicle class rather than chosen by the user because v1 runs
 * one class for the whole field, so the class already determines the answer and
 * a separate setting could only ever contradict it.
 */
export type RaceFormat =
  /** Told as a bunch race: groups, not individual passes. */
  | 'cycling'
  /** Told pass by pass, the way a motor race or a foot race is. */
  | 'standard';
