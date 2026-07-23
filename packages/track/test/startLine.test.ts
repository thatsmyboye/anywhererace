import { describe, expect, it } from 'vitest';
import type { LatLng } from '@anywhererace/core';
import {
  createMockElevationProvider,
  createMockRoutingProvider,
  destinationPoint,
  haversineMeters,
} from '@anywhererace/core';
import { buildTrack } from '../src/build';
import { nearestPointOnPolyline, pointAlongPolyline } from '../src/position';

const ORIGIN: LatLng = { lat: 51.5, lng: -0.12 };

const blockWaypoints = (sizeM = 400): LatLng[] => [
  ORIGIN,
  destinationPoint(ORIGIN, 90, sizeM),
  destinationPoint(destinationPoint(ORIGIN, 0, sizeM), 90, sizeM),
  destinationPoint(ORIGIN, 0, sizeM),
];

const build = (startLineM?: number) =>
  buildTrack({
    id: 't1',
    name: 'Block circuit',
    mode: 'circuit',
    routingProfile: 'motor',
    waypoints: blockWaypoints(),
    routing: createMockRoutingProvider({ seed: 'start-line' }),
    elevation: createMockElevationProvider({ seed: 'start-line' }),
    ...(startLineM === undefined ? {} : { startLineM }),
  });

describe('walking along a polyline', () => {
  const line: LatLng[] = [
    ORIGIN,
    destinationPoint(ORIGIN, 90, 100),
    destinationPoint(destinationPoint(ORIGIN, 90, 100), 0, 100),
  ];

  it('finds a point at a distance, not at a vertex', () => {
    const at = pointAlongPolyline(line, 150) as LatLng;
    expect(haversineMeters(line[0] as LatLng, at)).toBeGreaterThan(100);
    // 150m along an L of two 100m arms is 50m up the second one.
    expect(haversineMeters(line[1] as LatLng, at)).toBeCloseTo(50, 0);
  });

  it('clamps rather than wrapping — the caller knows if it is a loop', () => {
    expect(pointAlongPolyline(line, -50)).toEqual(line[0]);
    expect(pointAlongPolyline(line, 10_000)).toEqual(line[2]);
  });
});

describe('snapping a dropped marker back onto the route', () => {
  const line: LatLng[] = [ORIGIN, destinationPoint(ORIGIN, 90, 200)];

  it('projects a point beside the line onto it', () => {
    // 100m along, then 40m off to the side.
    const beside = destinationPoint(destinationPoint(ORIGIN, 90, 100), 0, 40);
    const snapped = nearestPointOnPolyline(line, beside);

    expect(snapped?.distanceM).toBeCloseTo(100, 0);
    expect(snapped?.offsetM).toBeCloseTo(40, 0);
  });

  it('clamps to the ends rather than running off them', () => {
    const past = destinationPoint(ORIGIN, 90, 500);
    expect(nearestPointOnPolyline(line, past)?.distanceM).toBeCloseTo(200, 0);

    const before = destinationPoint(ORIGIN, 270, 50);
    expect(nearestPointOnPolyline(line, before)?.distanceM).toBeCloseTo(0, 0);
  });

  it('picks the nearest arm of a shape that doubles back', () => {
    // A hairpin: the far arm passes close to the near one, and the projection
    // has to choose by distance rather than by whichever segment comes first.
    const out = destinationPoint(ORIGIN, 90, 200);
    const hairpin: LatLng[] = [ORIGIN, out, destinationPoint(out, 0, 20), destinationPoint(ORIGIN, 0, 20)];
    const nearReturnArm = destinationPoint(destinationPoint(ORIGIN, 90, 100), 0, 18);

    const snapped = nearestPointOnPolyline(hairpin, nearReturnArm);
    // The return arm starts at 220m along, so a point beside its middle is
    // well past the outward leg's 200m.
    expect(snapped?.distanceM).toBeGreaterThan(220);
    expect(snapped?.offsetM).toBeLessThan(5);
  });

  it('copes with a degenerate line rather than throwing', () => {
    expect(nearestPointOnPolyline([], ORIGIN)).toBeUndefined();
    expect(nearestPointOnPolyline([ORIGIN], ORIGIN)?.distanceM).toBe(0);
  });
});

describe('placing the start line on a baked circuit', () => {
  it('defaults to the first waypoint, as it always did', async () => {
    const result = await build();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.startLine).toBe(0);
  });

  it('puts the line where it was asked for', async () => {
    const plain = await build();
    if (!plain.ok) return;
    const third = plain.value.lengthMeters / 3;

    const result = await build(third);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.startLine).toBeCloseTo(third, 6);
  });

  it('keeps the finish one lap ahead, so a lap is still a lap', async () => {
    const plain = await build();
    if (!plain.ok) return;
    const result = await build(plain.value.lengthMeters / 3);
    if (!result.ok) return;
    // The sim reads the gap between the lines as the race distance; leaving
    // the finish pinned to the end of the route would silently shorten it.
    expect(result.value.finishLine - result.value.startLine).toBeCloseTo(
      result.value.lengthMeters,
      6,
    );
  });

  it('rotates the sectors with the line, so sector one starts at it', async () => {
    const plain = await build();
    if (!plain.ok) return;
    const length = plain.value.lengthMeters;
    const offset = length / 3;

    const moved = await build(offset);
    if (!moved.ok) return;

    const relative = moved.value.sectors
      .map((s) => ((s - moved.value.startLine) % length + length) % length)
      .sort((a, b) => a - b);
    const expected = plain.value.sectors.slice().sort((a, b) => a - b);

    expect(relative).toHaveLength(expected.length);
    relative.forEach((value, index) => {
      expect(value).toBeCloseTo(expected[index] as number, 6);
    });
  });

  it('wraps a line asked for past the end of the lap', async () => {
    const plain = await build();
    if (!plain.ok) return;
    const length = plain.value.lengthMeters;

    const result = await build(length + 50);
    if (!result.ok) return;
    // A circuit is a loop; a distance past the end of it is a distance into
    // the next lap, not an error.
    expect(result.value.startLine).toBeCloseTo(50, 6);
  });

  it('ignores a start line on a point-to-point', async () => {
    // Start and finish *are* the ends of the route there. Moving them would be
    // trimming it, which dragging the end waypoints already does.
    const result = await buildTrack({
      id: 't2',
      name: 'A to B',
      mode: 'point-to-point',
      routingProfile: 'motor',
      waypoints: blockWaypoints().slice(0, 3),
      routing: createMockRoutingProvider({ seed: 'start-line' }),
      elevation: createMockElevationProvider({ seed: 'start-line' }),
      startLineM: 250,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.startLine).toBe(0);
    expect(result.value.finishLine).toBeCloseTo(result.value.lengthMeters, 6);
  });
});
