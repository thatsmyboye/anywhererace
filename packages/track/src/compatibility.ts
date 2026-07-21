import type { RoutingProfile, Track } from '@anywhererace/core';
import { PROFILE_ALLOWED_CATEGORIES } from '@anywhererace/core';
import type { VehicleClass } from '@anywhererace/sim';
import { VEHICLE_CLASSES } from '@anywhererace/sim';

/**
 * Profile is chosen at track-build time; vehicle is chosen at race-setup time.
 * They can conflict, and the UI needs to be able to say so precisely rather
 * than just greying out half the list.
 */

export type ProfileConflict = {
  vehicle: VehicleClass;
  trackProfile: RoutingProfile;
  message: string;
  /** The profile the track would need to be re-routed under to allow this class. */
  suggestedProfile: RoutingProfile;
};

export const vehiclesForProfile = (profile: RoutingProfile): VehicleClass[] => {
  const allowed = PROFILE_ALLOWED_CATEGORIES[profile];
  return VEHICLE_CLASSES.filter((vehicle) => allowed.includes(vehicle.category));
};

export const isVehicleAllowed = (vehicle: VehicleClass, profile: RoutingProfile): boolean =>
  PROFILE_ALLOWED_CATEGORIES[profile].includes(vehicle.category);

/**
 * Explain a conflict, and name the profile that would resolve it.
 *
 * Re-routing under a different profile changes the track's length and shape, so
 * the caller must warn clearly and treat the result as a new track version
 * rather than editing the original in place.
 */
export const explainConflict = (
  vehicle: VehicleClass,
  track: Track,
): ProfileConflict | undefined => {
  if (isVehicleAllowed(vehicle, track.routingProfile)) return undefined;

  const suggestedProfile: RoutingProfile =
    vehicle.category === 'foot'
      ? 'pedestrian'
      : vehicle.category === 'micromobility'
        ? 'bicycle'
        : 'motor';

  const reason =
    track.routingProfile === 'pedestrian'
      ? 'this route uses footpaths and steps'
      : track.routingProfile === 'bicycle'
        ? 'this route may run against traffic on contraflow bike lanes'
        : 'this route is built for motor traffic';

  return {
    vehicle,
    trackProfile: track.routingProfile,
    message: `${vehicle.label} can't race "${track.name}" because ${reason}. Re-routing under the ${suggestedProfile} profile will change the track's length and shape, and creates a new version of it.`,
    suggestedProfile,
  };
};
