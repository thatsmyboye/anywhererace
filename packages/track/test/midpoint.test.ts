import { describe, expect, it } from 'vitest';
import { haversineMeters } from '@anywhererace/core';
import type { LatLng } from '@anywhererace/core';
import { midpointOfPolyline } from '../src/position';

describe('the middle of a polyline', () => {
  it('measures by distance, not by vertex count', () => {
    // The classic OSM shape: a cluster of vertices at one end and a long
    // straight run to the other. The middle *vertex* is nowhere near halfway,
    // which would drop the builder's insert handle in the wrong place.
    const points: LatLng[] = [
      { lat: 51.5, lng: -0.1 },
      { lat: 51.5, lng: -0.09999 },
      { lat: 51.5, lng: -0.09998 },
      { lat: 51.5, lng: -0.09997 },
      { lat: 51.5, lng: -0.09 },
    ];
    const middle = midpointOfPolyline(points) as LatLng;

    const total = haversineMeters(points[0] as LatLng, points[4] as LatLng);
    expect(haversineMeters(points[0] as LatLng, middle)).toBeCloseTo(total / 2, 1);
  });

  it('splits a simple two-point line in half', () => {
    const a: LatLng = { lat: 51.5, lng: -0.1 };
    const b: LatLng = { lat: 51.5, lng: -0.09 };
    const middle = midpointOfPolyline([a, b]) as LatLng;
    expect(haversineMeters(a, middle)).toBeCloseTo(haversineMeters(middle, b), 3);
  });

  it('follows the shape around a corner', () => {
    // An L. The midpoint by distance is on one of the arms, never on the
    // diagonal between the ends.
    const points: LatLng[] = [
      { lat: 51.5, lng: -0.1 },
      { lat: 51.5, lng: -0.09 },
      { lat: 51.51, lng: -0.09 },
    ];
    const middle = midpointOfPolyline(points) as LatLng;
    const onFirstArm = Math.abs(middle.lat - 51.5) < 1e-9;
    const onSecondArm = Math.abs(middle.lng - -0.09) < 1e-9;
    expect(onFirstArm || onSecondArm).toBe(true);
  });

  it('copes with degenerate input rather than throwing', () => {
    expect(midpointOfPolyline([])).toBeUndefined();
    const only: LatLng = { lat: 1, lng: 2 };
    expect(midpointOfPolyline([only])).toEqual(only);
    // Every vertex in the same place: no length to halve.
    expect(midpointOfPolyline([only, only, only])).toEqual(only);
  });
});
