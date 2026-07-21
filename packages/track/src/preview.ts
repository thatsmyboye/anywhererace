import type { ElevationProvider, LatLng, Result, TrackMode } from '@anywhererace/core';
import { cumulativeDistances, interpolateLatLng, ok } from '@anywhererace/core';
import { BAKE } from './constants';
import { computeCurvatureRadii, countCorners } from './curvature';
import { resamplePolyline } from './resample';

/**
 * A cheap read on a route, for the builder to show while the user is still
 * drawing.
 *
 * This deliberately does *not* bake. A full bake samples the DEM at every 5m
 * node — six requests for a three-kilometre track — and the builder would fire
 * that on every waypoint drag. The public elevation service allows a thousand
 * calls a day, so that is a budget gone in an afternoon of editing.
 *
 * Instead: curvature is pure geometry and needs no DEM at all, and the
 * elevation profile is sampled every 50m and interpolated. One request covers a
 * five-kilometre track, and a profile drawn a hundred pixels wide cannot show
 * the difference anyway. The real bake, at 5m with real gradients, happens once
 * when the track is saved.
 */

/** Spacing for the preview elevation profile. */
const PROFILE_SPACING_M = 50;

export type ElevationSample = {
  distanceM: number;
  elevationM: number;
};

export type TrackPreview = {
  lengthMeters: number;
  /** Distinct corners, so a long sweeper counts once rather than forty times. */
  cornerCount: number;
  /** Tightest radius on the route, in meters. `Infinity` if it is all straight. */
  tightestRadiusM: number;
  profile: ElevationSample[];
  /** Total meters gained and lost. The number cyclists and runners care about. */
  climbM: number;
  descentM: number;
};

export const previewGeometry = (
  polyline: readonly LatLng[],
  mode: TrackMode,
): Pick<TrackPreview, 'lengthMeters' | 'cornerCount' | 'tightestRadiusM'> => {
  if (polyline.length < 2) {
    return { lengthMeters: 0, cornerCount: 0, tightestRadiusM: Infinity };
  }

  const resampled = resamplePolyline(polyline, BAKE.nodeSpacingM, mode);
  const radii = computeCurvatureRadii(resampled.points, resampled.spacingM, mode);
  const finite = radii.filter((radius) => Number.isFinite(radius));

  return {
    lengthMeters: resampled.totalLengthM,
    cornerCount: countCorners(radii),
    tightestRadiusM: finite.length === 0 ? Infinity : Math.min(...finite),
  };
};

/** The points a preview profile needs elevation for. One request, usually. */
export const profileSamplePoints = (polyline: readonly LatLng[]): LatLng[] => {
  if (polyline.length < 2) return polyline.slice();

  const distances = cumulativeDistances(polyline);
  const total = distances[distances.length - 1] as number;
  const count = Math.max(2, Math.min(100, Math.ceil(total / PROFILE_SPACING_M)));
  const spacing = total / (count - 1);

  const points: LatLng[] = [];
  let cursor = 1;
  for (let i = 0; i < count; i++) {
    const target = i * spacing;
    while (cursor < distances.length - 1 && (distances[cursor] as number) < target) cursor += 1;
    const before = distances[cursor - 1] as number;
    const after = distances[cursor] as number;
    const span = after - before;
    const t = span <= 0 ? 0 : (target - before) / span;
    points.push(
      interpolateLatLng(polyline[cursor - 1] as LatLng, polyline[cursor] as LatLng, Math.min(1, Math.max(0, t))),
    );
  }
  return points;
};

export const buildPreview = async (
  polyline: readonly LatLng[],
  mode: TrackMode,
  elevation: ElevationProvider,
): Promise<Result<TrackPreview, never>> => {
  const geometry = previewGeometry(polyline, mode);
  if (polyline.length < 2) {
    return ok({ ...geometry, profile: [], climbM: 0, descentM: 0 });
  }

  const points = profileSamplePoints(polyline);
  const looked = await elevation.lookup(points);

  // An elevation outage costs the profile, never the whole preview — the user
  // is still drawing, and a missing chart is far better than a dead builder.
  const elevations = looked.ok ? looked.value : [];
  if (elevations.length !== points.length) {
    return ok({ ...geometry, profile: [], climbM: 0, descentM: 0 });
  }

  const spacing = geometry.lengthMeters / Math.max(1, points.length - 1);
  const profile: ElevationSample[] = elevations.map((elevationM, index) => ({
    distanceM: index * spacing,
    elevationM,
  }));

  let climbM = 0;
  let descentM = 0;
  for (let i = 1; i < profile.length; i++) {
    const delta = (profile[i]?.elevationM ?? 0) - (profile[i - 1]?.elevationM ?? 0);
    if (delta > 0) climbM += delta;
    else descentM -= delta;
  }

  return ok({ ...geometry, profile, climbM, descentM });
};
