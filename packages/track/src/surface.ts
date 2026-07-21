import type { SurfaceConfidence, SurfaceType } from '@anywhererace/core';
import { BAKE } from './constants';

/**
 * Surface inference from the OSM `highway` tag, used when no `surface` tag
 * exists. Roughly two-thirds of ways have no surface tag, so this path is the
 * common case, not the fallback — which is exactly why every node carries a
 * `surfaceConfidence` and the UI says "assumed" rather than pretending.
 *
 * PLACEHOLDER: this table is a reasonable first guess, not a calibrated one.
 * It should be checked against real OSM extracts for a few cities and a few
 * trail networks before launch.
 */
const HIGHWAY_SURFACE: Record<string, SurfaceType> = {
  motorway: 'asphalt',
  motorway_link: 'asphalt',
  trunk: 'asphalt',
  trunk_link: 'asphalt',
  primary: 'asphalt',
  primary_link: 'asphalt',
  secondary: 'asphalt',
  secondary_link: 'asphalt',
  tertiary: 'asphalt',
  tertiary_link: 'asphalt',
  unclassified: 'asphalt',
  residential: 'asphalt',
  living_street: 'asphalt',
  service: 'asphalt',
  cycleway: 'asphalt',
  pedestrian: 'concrete',
  // `highway=track` is an agricultural or forestry track. Without a
  // `tracktype` grade, gravel is the safest middle guess: grade1 tracks are
  // effectively paved and grade5 is mud, and gravel sits between them.
  track: 'gravel',
  path: 'trail',
  footway: 'trail',
  bridleway: 'trail',
  steps: 'trail',
};

/** Default surface when even the highway tag is missing or unrecognized. */
const FALLBACK_SURFACE: SurfaceType = 'asphalt';

export const inferSurface = (
  highway: string,
): { surface: SurfaceType; confidence: SurfaceConfidence } => ({
  surface: HIGHWAY_SURFACE[highway] ?? FALLBACK_SURFACE,
  confidence: 'inferred',
});

/**
 * `tracktype` refines `highway=track` when it is present. grade1 is a solid
 * surface; grade5 is soft ground with no consolidation at all.
 */
const TRACKTYPE_SURFACE: Record<string, SurfaceType> = {
  grade1: 'concrete',
  grade2: 'gravel',
  grade3: 'gravel',
  grade4: 'dirt',
  grade5: 'dirt',
};

export const surfaceFromTracktype = (tracktype: string): SurfaceType | undefined =>
  TRACKTYPE_SURFACE[tracktype];

/**
 * Default width when the way carries no width tag. Paths default narrow on
 * purpose — that is what makes single-track overtaking a real event rather
 * than a formality.
 */
export const defaultWidthFor = (surface: SurfaceType): number =>
  surface === 'trail' || surface === 'sand' ? BAKE.defaultTrailWidthM : BAKE.defaultWidthM;

/** Surfaces that only the `pedestrian` and `bicycle` profiles should produce. */
export const OFF_ROAD_SURFACES: readonly SurfaceType[] = ['gravel', 'dirt', 'trail', 'sand', 'grass'];

export const isOffRoad = (surface: SurfaceType): boolean => OFF_ROAD_SURFACES.includes(surface);
