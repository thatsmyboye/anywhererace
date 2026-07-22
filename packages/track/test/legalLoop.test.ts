import { describe, expect, it, vi } from 'vitest';
import { destinationPoint, err, haversineMeters, ok } from '@anywhererace/core';
import type { LatLng, RouteLeg, RoutingProvider } from '@anywhererace/core';
import { findNearestLegalLoop } from '../src/legalLoop';

/**
 * The router is a stub, so a "one-way street" here is just a rule about which
 * legs are allowed. That is the right level: the search does not care why a leg
 * will not route, only that it will not.
 */

const SQUARE: LatLng[] = [
  { lat: 51.5, lng: -0.1 },
  { lat: 51.5, lng: -0.099 },
  { lat: 51.501, lng: -0.099 },
  { lat: 51.501, lng: -0.1 },
];

const EMPTY_LEG: RouteLeg = { polyline: [], lengthMeters: 0, annotations: [], junctions: [] };

/** Routes every leg except where `blocked` says otherwise. */
const router = (blocked: (from: LatLng, to: LatLng) => boolean): RoutingProvider => ({
  id: 'stub',
  routeLeg: vi.fn(async ({ from, to }) =>
    blocked(from, to)
      ? err({ kind: 'illegal-direction' as const, message: 'One way the other way.' })
      : ok(EMPTY_LEG),
  ),
});

/** A leg is blocked while its `from` end sits within `radiusM` of `cursed`. */
const cursedCorner = (cursed: LatLng, radiusM: number) => (from: LatLng): boolean =>
  haversineMeters(from, cursed) < radiusM;

describe('finding the nearest legal loop', () => {
  const base = {
    waypoints: SQUARE,
    mode: 'circuit' as const,
    profile: 'motor' as const,
  };

  it('refuses to search when nothing is broken', async () => {
    const result = await findNearestLegalLoop({
      ...base,
      routing: router(() => false),
      failedFromIndices: [],
    });
    expect(!result.ok && result.error.kind).toBe('nothing-to-fix');
  });

  it('nudges the offending corner until the loop closes', async () => {
    // The closing leg out of waypoint 3 is illegal while it sits where it is.
    const result = await findNearestLegalLoop({
      ...base,
      routing: router(cursedCorner(SQUARE[3] as LatLng, 30)),
      failedFromIndices: [3],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.waypointIndex).toBe(3);
    expect(result.value.remainingBreaks).toBe(0);
  });

  it('takes the smallest move that works, not the first one it tries', async () => {
    // Nothing within 30m helps, so the 20m ring must be exhausted before the
    // 45m one is accepted. A search that returned the first success from an
    // arbitrary order would relocate the corner much further than it needs to.
    const result = await findNearestLegalLoop({
      ...base,
      routing: router(cursedCorner(SQUARE[3] as LatLng, 30)),
      failedFromIndices: [3],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.movedByMeters).toBeGreaterThan(30);
    expect(result.value.movedByMeters).toBeLessThan(50);
  });

  it('will move either end of the broken leg', async () => {
    // Waypoint 3 is immovable — everywhere near it is cursed — but the leg also
    // ends at waypoint 0, and moving that closes the loop just as well.
    const result = await findNearestLegalLoop({
      ...base,
      routing: router((from, to) => {
        const nearOldEnd = haversineMeters(to, SQUARE[0] as LatLng) < 10;
        const fromThree = haversineMeters(from, SQUARE[3] as LatLng) < 300;
        return fromThree && nearOldEnd;
      }),
      failedFromIndices: [3],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.waypointIndex).toBe(0);
  });

  it('says it searched and found nothing, rather than nothing at all', async () => {
    const result = await findNearestLegalLoop({
      ...base,
      routing: router(cursedCorner(SQUARE[3] as LatLng, 100_000)),
      failedFromIndices: [3],
    });
    expect(!result.ok && result.error.kind).toBe('exhausted');
  });

  it('never reports an outage as an impossible loop', async () => {
    // The whole point of the distinction. "No legal loop exists" is a claim
    // about the road; a router that stopped answering supports no such claim.
    const result = await findNearestLegalLoop({
      ...base,
      routing: {
        id: 'down',
        routeLeg: vi.fn(async () =>
          err({ kind: 'provider-unavailable' as const, message: 'Gateway timeout.' }),
        ),
      },
      failedFromIndices: [3],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('provider-unavailable');
    expect(result.error.kind).not.toBe('exhausted');
  });

  it('reports breaks the move cannot reach', async () => {
    // Two independent breaks: one at waypoint 3's closing leg, one at leg 1.
    // Moving waypoint 3 cannot fix leg 1, and pretending otherwise would send
    // the user to a save that fails.
    const result = await findNearestLegalLoop({
      ...base,
      routing: router((from) => haversineMeters(from, SQUARE[3] as LatLng) < 30),
      failedFromIndices: [3, 1],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.remainingBreaks).toBe(1);
  });

  it('stays inside its request budget', async () => {
    const routing = router(() => true);
    await findNearestLegalLoop({
      ...base,
      routing,
      failedFromIndices: [3],
      search: { maxRequests: 12 },
    });
    // Bounded because the router is free, shared and rate-limited.
    expect(routing.routeLeg).toHaveBeenCalledTimes(12);
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await findNearestLegalLoop({
      ...base,
      routing: router(() => true),
      failedFromIndices: [3],
      signal: controller.signal,
    });
    expect(!result.ok && result.error.kind).toBe('aborted');
  });

  it('reports progress as it goes', async () => {
    const onProgress = vi.fn();
    await findNearestLegalLoop({
      ...base,
      routing: router(() => true),
      failedFromIndices: [3],
      search: { maxRequests: 8 },
      onProgress,
    });
    expect(onProgress).toHaveBeenCalled();
  });

  it('does not ask the router the same question twice', async () => {
    // Rings around neighbouring waypoints share legs constantly.
    const routing = router(() => true);
    await findNearestLegalLoop({
      ...base,
      routing,
      failedFromIndices: [3],
      search: { radiiM: [25], bearings: 4, maxRequests: 100 },
    });

    const calls = (routing.routeLeg as ReturnType<typeof vi.fn>).mock.calls as unknown as [
      { from: LatLng; to: LatLng },
    ][];
    const keys = calls.map(
      ([request]) =>
        `${request.from.lat.toFixed(6)},${request.from.lng.toFixed(6)}|${request.to.lat.toFixed(6)},${request.to.lng.toFixed(6)}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the search geometry', () => {
  it('offsets a waypoint by the radius it asked for', () => {
    const origin = SQUARE[0] as LatLng;
    expect(haversineMeters(origin, destinationPoint(origin, 90, 45))).toBeCloseTo(45, 3);
  });
});
