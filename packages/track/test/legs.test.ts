import { describe, expect, it } from 'vitest';
import type { LatLng } from '@anywhererace/core';
import { insertIndexForLeg, legPairsFor } from '../src/legs';

const square: LatLng[] = [
  { lat: 51.5, lng: -0.1 },
  { lat: 51.5, lng: -0.099 },
  { lat: 51.501, lng: -0.099 },
  { lat: 51.501, lng: -0.1 },
];

describe('leg pairs', () => {
  it('closes the loop on a circuit', () => {
    const pairs = legPairsFor(square, 'circuit');
    expect(pairs).toHaveLength(4);
    expect(pairs[3]).toMatchObject({ fromIndex: 3, toIndex: 0 });
  });

  it('does not close a point-to-point', () => {
    expect(legPairsFor(square, 'point-to-point')).toHaveLength(3);
  });

  it('does not close a two-point circuit, which would be a there-and-back', () => {
    expect(legPairsFor(square.slice(0, 2), 'circuit')).toHaveLength(1);
  });
});

describe('inserting into a leg', () => {
  const insertInto = (waypoints: readonly LatLng[], legIndex: number, mode: 'circuit' | 'point-to-point') => {
    const leg = legPairsFor(waypoints, mode)[legIndex];
    if (leg === undefined) throw new Error('no such leg');
    const at = insertIndexForLeg(leg, waypoints.length);
    const next = waypoints.slice();
    next.splice(at, 0, { lat: 0, lng: 0 });
    return { at, next };
  };

  it('puts the new waypoint between the two ends of the leg', () => {
    const { at, next } = insertInto(square, 1, 'circuit');
    expect(at).toBe(2);
    // Old waypoints 1 and 2 now sit either side of the new one.
    expect(next[1]).toEqual(square[1]);
    expect(next[2]).toEqual({ lat: 0, lng: 0 });
    expect(next[3]).toEqual(square[2]);
  });

  it('puts a split of the closing leg at the end, not the start', () => {
    // The closing leg runs from the last waypoint back to the first. Inserting
    // at 0 there would move the start line rather than reopen the loop — a
    // different edit, and not the one the handle was grabbed for.
    const { at, next } = insertInto(square, 3, 'circuit');
    expect(at).toBe(4);
    expect(next[0]).toEqual(square[0]);
    expect(next[4]).toEqual({ lat: 0, lng: 0 });
  });

  it('keeps the loop the same length in legs, one longer in waypoints', () => {
    const { next } = insertInto(square, 3, 'circuit');
    expect(next).toHaveLength(5);
    expect(legPairsFor(next, 'circuit')).toHaveLength(5);
  });

  it('splits the first leg of a point-to-point without moving the start', () => {
    const { at, next } = insertInto(square, 0, 'point-to-point');
    expect(at).toBe(1);
    expect(next[0]).toEqual(square[0]);
    expect(next[next.length - 1]).toEqual(square[square.length - 1]);
  });
});
