import { describe, expect, it } from 'vitest';
import type { LatLng } from '@anywhererace/core';
import {
  createMockElevationProvider,
  createMockRoutingProvider,
  destinationPoint,
  haversineMeters,
} from '@anywhererace/core';
import { buildTrack } from '../src/build';
import { explainConflict, isVehicleAllowed, vehiclesForProfile } from '../src/compatibility';
import { getVehicleClass } from '@anywhererace/sim';

const ORIGIN: LatLng = { lat: 51.5, lng: -0.12 };

/** Four corners of a block, which is the shape a user actually draws. */
const blockWaypoints = (sizeM = 400): LatLng[] => {
  const northEast = destinationPoint(destinationPoint(ORIGIN, 0, sizeM), 90, sizeM);
  return [
    ORIGIN,
    destinationPoint(ORIGIN, 90, sizeM),
    northEast,
    destinationPoint(ORIGIN, 0, sizeM),
  ];
};

const providers = () => ({
  routing: createMockRoutingProvider({ seed: 'build-test' }),
  elevation: createMockElevationProvider({ seed: 'build-test' }),
});

describe('buildTrack', () => {
  it('builds a closed circuit from four waypoints', async () => {
    const result = await buildTrack({
      id: 't1',
      name: 'Block circuit',
      mode: 'circuit',
      routingProfile: 'motor',
      waypoints: blockWaypoints(),
      ...providers(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const track = result.value;
    expect(track.nodes.length).toBeGreaterThan(100);
    expect(track.lengthMeters).toBeGreaterThan(1500);
    expect(track.startLine).toBe(0);
    expect(track.sectors).toHaveLength(2);
    // The polyline is pinned alongside the waypoints so an old shared link
    // replays the road layout it was created on.
    expect(track.polyline.length).toBeGreaterThan(10);
    expect(track.waypoints).toHaveLength(4);
  });

  it('closes the loop back to the first waypoint', async () => {
    const result = await buildTrack({
      id: 't2',
      name: 'Closure',
      mode: 'circuit',
      routingProfile: 'motor',
      waypoints: blockWaypoints(),
      ...providers(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const first = result.value.polyline[0] as LatLng;
    const last = result.value.polyline[result.value.polyline.length - 1] as LatLng;
    expect(haversineMeters(first, last)).toBeLessThan(1);
  });

  it('builds a point-to-point route without a closing leg', async () => {
    const waypoints = blockWaypoints();
    const asLoop = await buildTrack({
      id: 't3',
      name: 'Loop',
      mode: 'circuit',
      routingProfile: 'motor',
      waypoints,
      ...providers(),
    });
    const asLine = await buildTrack({
      id: 't4',
      name: 'Line',
      mode: 'point-to-point',
      routingProfile: 'motor',
      waypoints,
      ...providers(),
    });

    expect(asLoop.ok && asLine.ok).toBe(true);
    if (!asLoop.ok || !asLine.ok) return;
    expect(asLine.value.lengthMeters).toBeLessThan(asLoop.value.lengthMeters);
  });

  it('names the offending leg when a leg cannot be routed', async () => {
    const waypoints = blockWaypoints();
    const blocked = waypoints[2] as LatLng;
    const result = await buildTrack({
      id: 't5',
      name: 'Broken',
      mode: 'circuit',
      routingProfile: 'motor',
      waypoints,
      routing: createMockRoutingProvider({ seed: 'x', unroutable: [blocked] }),
      elevation: createMockElevationProvider(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('leg-failed');
    // Leg 2 is the one ending at waypoint index 2. The builder has to be able
    // to point at the specific corner, not fail vaguely at save time.
    expect(result.error.legIndex).toBe(1);
    expect(result.error.at).toEqual(blocked);
  });

  it('says trail gaps are normal rather than implying something broke', async () => {
    const waypoints = blockWaypoints();
    const result = await buildTrack({
      id: 't6',
      name: 'Trail',
      mode: 'point-to-point',
      routingProfile: 'pedestrian',
      waypoints,
      routing: createMockRoutingProvider({ seed: 'x', unroutable: [waypoints[1] as LatLng] }),
      elevation: createMockElevationProvider(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/gaps and dead ends/i);
  });

  it('rejects a track with fewer than two waypoints', async () => {
    const result = await buildTrack({
      id: 't7',
      name: 'Point',
      mode: 'point-to-point',
      routingProfile: 'motor',
      waypoints: [ORIGIN],
      ...providers(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('too-few-waypoints');
  });

  it('reports an elevation outage as its own failure, not a routing one', async () => {
    const failing = {
      id: 'failing-dem',
      maxBatchSize: 100,
      lookup: async () =>
        ({ ok: false, error: { kind: 'provider-unavailable' as const, message: 'down' } }) as const,
    };
    const result = await buildTrack({
      id: 't8',
      name: 'No DEM',
      mode: 'point-to-point',
      routingProfile: 'motor',
      waypoints: blockWaypoints(),
      routing: createMockRoutingProvider({ seed: 'x' }),
      elevation: failing,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('elevation-failed');
  });

  it('gives every node real elevation from the DEM', async () => {
    const result = await buildTrack({
      id: 't9',
      name: 'Hilly',
      mode: 'circuit',
      routingProfile: 'bicycle',
      waypoints: blockWaypoints(1200),
      routing: createMockRoutingProvider({ seed: 'hills' }),
      elevation: createMockElevationProvider({ seed: 'hills', reliefM: 60 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const elevations = result.value.nodes.map((n) => n.elevation);
    expect(Math.max(...elevations) - Math.min(...elevations)).toBeGreaterThan(0.5);
    // And the gradients derived from it are real but not absurd.
    const gradients = result.value.nodes.map((n) => Math.abs(n.gradient));
    expect(Math.max(...gradients)).toBeGreaterThan(0);
    expect(Math.max(...gradients)).toBeLessThanOrEqual(0.35);
  });

  it('is deterministic: the same waypoints build the same track twice', async () => {
    const build = () =>
      buildTrack({
        id: 't10',
        name: 'Repeat',
        mode: 'circuit',
        routingProfile: 'motor',
        waypoints: blockWaypoints(),
        ...providers(),
      });

    const [a, b] = await Promise.all([build(), build()]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.value.lengthMeters).toBe(a.value.lengthMeters);
    expect(b.value.nodes).toEqual(a.value.nodes);
  });
});

describe('profile and vehicle compatibility', () => {
  it('allows every class on a motor route', () => {
    expect(vehiclesForProfile('motor')).toHaveLength(11);
  });

  it('keeps cars off bicycle and pedestrian routes', () => {
    const car = getVehicleClass('city-car');
    const runner = getVehicleClass('runner');
    expect(car && isVehicleAllowed(car, 'bicycle')).toBe(false);
    expect(car && isVehicleAllowed(car, 'pedestrian')).toBe(false);
    expect(runner && isVehicleAllowed(runner, 'pedestrian')).toBe(true);
  });

  it('explains a conflict and names the profile that would fix it', async () => {
    const built = await buildTrack({
      id: 't11',
      name: 'Towpath',
      mode: 'point-to-point',
      routingProfile: 'pedestrian',
      waypoints: blockWaypoints(),
      ...providers(),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const supercar = getVehicleClass('supercar');
    expect(supercar).toBeDefined();
    if (!supercar) return;

    const conflict = explainConflict(supercar, built.value);
    expect(conflict).toBeDefined();
    expect(conflict?.suggestedProfile).toBe('motor');
    // The user has to be warned that re-routing changes the track's shape and
    // creates a new version rather than editing the one they saved.
    expect(conflict?.message).toMatch(/new version/i);
  });

  it('reports no conflict when the class is allowed', async () => {
    const built = await buildTrack({
      id: 't12',
      name: 'Street circuit',
      mode: 'circuit',
      routingProfile: 'motor',
      waypoints: blockWaypoints(),
      ...providers(),
    });
    if (!built.ok) return;
    const gt = getVehicleClass('gt-racer');
    expect(gt && explainConflict(gt, built.value)).toBeUndefined();
  });
});
