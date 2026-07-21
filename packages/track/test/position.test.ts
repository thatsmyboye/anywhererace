import { describe, expect, it } from 'vitest';
import { haversineMeters } from '@anywhererace/core';
import { positionOnTrack, startLinePosition, trackBounds, trackToGeoJSON } from '../src/position';
import { makeSyntheticTrack } from '../../sim/test/fixtures';

const STRAIGHT = makeSyntheticTrack({ lengthM: 1000, bearing: 90 });
const CIRCUIT = makeSyntheticTrack({ lengthM: 1000, mode: 'circuit', bearing: 90 });

describe('positionOnTrack', () => {
  it('walks the route at the requested distance', () => {
    const start = positionOnTrack(STRAIGHT, 0);
    for (const distance of [100, 500, 999]) {
      const at = positionOnTrack(STRAIGHT, distance);
      expect(haversineMeters(start, at)).toBeCloseTo(distance, 1);
    }
  });

  it('interpolates between nodes rather than snapping to them', () => {
    // Nodes are 5m apart; a racer at 2.5m must not render at 0m. At 250kph a
    // racer crosses a node every 70ms, and snapping would visibly stair-step.
    const a = positionOnTrack(STRAIGHT, 2.5);
    const b = positionOnTrack(STRAIGHT, 0);
    const c = positionOnTrack(STRAIGHT, 5);
    expect(haversineMeters(b, a)).toBeCloseTo(2.5, 1);
    expect(haversineMeters(a, c)).toBeCloseTo(2.5, 1);
  });

  it('reports the direction of travel as the bearing', () => {
    expect(positionOnTrack(STRAIGHT, 300).bearing).toBeCloseTo(90, 3);
  });

  it('wraps around a circuit', () => {
    const first = positionOnTrack(CIRCUIT, 250);
    const secondLap = positionOnTrack(CIRCUIT, 1250);
    const thirdLap = positionOnTrack(CIRCUIT, 2250);
    expect(haversineMeters(first, secondLap)).toBeLessThan(0.5);
    expect(haversineMeters(first, thirdLap)).toBeLessThan(0.5);
  });

  it('places a racer sitting on the grid behind the start line', () => {
    // Grid slots are at negative race distances before the green flag. On a
    // circuit that wraps to the far end of the lap, so it is compared against
    // the equivalent positive distance rather than against the line itself —
    // the synthetic fixture is a straight line flagged as a circuit, so its
    // two ends are not geometrically adjacent.
    const onGrid = positionOnTrack(CIRCUIT, -16);
    const equivalent = positionOnTrack(CIRCUIT, CIRCUIT.lengthMeters - 16);
    expect(haversineMeters(onGrid, equivalent)).toBeLessThan(0.01);
  });

  it('places a racer behind the start line on a point-to-point route', () => {
    // No wrapping here: a negative distance clamps to the start.
    const start = positionOnTrack(STRAIGHT, 0);
    expect(haversineMeters(start, positionOnTrack(STRAIGHT, -16))).toBeLessThan(0.01);
  });

  it('clamps rather than wrapping on a point-to-point route', () => {
    const end = positionOnTrack(STRAIGHT, 1000);
    const past = positionOnTrack(STRAIGHT, 5000);
    expect(haversineMeters(end, past)).toBeLessThan(0.5);
  });

  it('offsets to the right of the direction of travel for a positive offset', () => {
    const center = positionOnTrack(STRAIGHT, 500, 0);
    const right = positionOnTrack(STRAIGHT, 500, 3);
    const left = positionOnTrack(STRAIGHT, 500, -3);

    expect(haversineMeters(center, right)).toBeCloseTo(3, 1);
    expect(haversineMeters(center, left)).toBeCloseTo(3, 1);
    // Travelling due east, right of travel is south.
    expect(right.lat).toBeLessThan(center.lat);
    expect(left.lat).toBeGreaterThan(center.lat);
  });

  it('keeps the bearing unchanged when offset laterally', () => {
    expect(positionOnTrack(STRAIGHT, 500, 4).bearing).toBeCloseTo(
      positionOnTrack(STRAIGHT, 500, 0).bearing,
      6,
    );
  });

  it('interpolates bearing the short way around north', () => {
    // A racer crossing due north must not spin through a full circle.
    const track = makeSyntheticTrack({ lengthM: 200, bearing: 90 });
    const nodes = track.nodes;
    const a = nodes[10];
    const b = nodes[11];
    if (a === undefined || b === undefined) throw new Error('fixture too short');
    a.bearing = 350;
    b.bearing = 10;

    const midway = positionOnTrack(track, a.distance + 2.5).bearing;
    // Through north (0), not back through south (180).
    expect(Math.min(midway, 360 - midway)).toBeLessThan(5);
  });

  it('returns a usable position for a track with no baked nodes', () => {
    const bare = { ...STRAIGHT, nodes: [] };
    const position = positionOnTrack(bare, 100);
    expect(Number.isFinite(position.lat)).toBe(true);
    expect(Number.isFinite(position.lng)).toBe(true);
  });
});

describe('trackToGeoJSON', () => {
  it('produces a LineString in lng,lat order', () => {
    const feature = trackToGeoJSON(STRAIGHT);
    expect(feature.geometry.type).toBe('LineString');
    const first = feature.geometry.coordinates[0];
    // GeoJSON is lng-first; getting this backwards puts the track in the sea.
    expect(first?.[0]).toBeCloseTo(STRAIGHT.nodes[0]?.lng ?? 0, 9);
    expect(first?.[1]).toBeCloseTo(STRAIGHT.nodes[0]?.lat ?? 0, 9);
  });

  it('closes the loop on a circuit', () => {
    // The node array omits the duplicate closing node, which would otherwise
    // leave a visible gap at the start line.
    const feature = trackToGeoJSON(CIRCUIT);
    const coordinates = feature.geometry.coordinates;
    expect(coordinates[0]).toEqual(coordinates[coordinates.length - 1]);
  });

  it('leaves a point-to-point route open', () => {
    const coordinates = trackToGeoJSON(STRAIGHT).geometry.coordinates;
    expect(coordinates[0]).not.toEqual(coordinates[coordinates.length - 1]);
  });
});

describe('trackBounds', () => {
  it('contains every node', () => {
    const [[west, south], [east, north]] = trackBounds(STRAIGHT);
    for (const node of STRAIGHT.nodes) {
      expect(node.lng).toBeGreaterThanOrEqual(west);
      expect(node.lng).toBeLessThanOrEqual(east);
      expect(node.lat).toBeGreaterThanOrEqual(south);
      expect(node.lat).toBeLessThanOrEqual(north);
    }
  });
});

describe('startLinePosition', () => {
  it('sits at the start line with the direction of travel', () => {
    const line = startLinePosition(CIRCUIT);
    expect(haversineMeters(line, positionOnTrack(CIRCUIT, 0))).toBeLessThan(0.01);
    expect(line.bearing).toBeCloseTo(90, 3);
  });
});
