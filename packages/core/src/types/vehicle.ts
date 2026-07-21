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
