import { describe, expect, it } from 'vitest';
import type { SurfaceType, TrackMode, TrackNode } from '@anywhererace/core';
import {
  createMockElevationProvider,
  createMockRoutingProvider,
  destinationPoint,
} from '@anywhererace/core';
import type { LatLng } from '@anywhererace/core';
import { buildTrack } from '../src/build';
import { SEPARATION } from '../src/constants';
import { sweepForSeparation } from '../src/separation';

/**
 * The separation sweep is a read on the *road*, so these tests build roads with
 * exactly one interesting feature on them and assert the sweep finds that
 * feature and nothing else. The thresholds are the contract: a 2% drag is not a
 * climb, a 3% one for two hundred meters is.
 */

const SPACING_M = 5;
const ORIGIN: LatLng = { lat: 51.5, lng: -0.12 };

type NodeOverrides = Partial<Omit<TrackNode, 'distance' | 'lat' | 'lng'>>;

/** A road of `lengthM`, uniform unless `shape` says otherwise for a given node. */
const makeNodes = (
  lengthM: number,
  shape: (distanceM: number) => NodeOverrides = () => ({}),
): TrackNode[] => {
  const count = Math.round(lengthM / SPACING_M) + 1;
  const nodes: TrackNode[] = [];
  for (let i = 0; i < count; i++) {
    const distance = i * SPACING_M;
    const point = destinationPoint(ORIGIN, 90, distance);
    nodes.push({
      distance,
      lat: point.lat,
      lng: point.lng,
      bearing: 90,
      curvatureRadius: Infinity,
      gradient: 0,
      surface: 'asphalt',
      surfaceConfidence: 'tagged',
      widthMeters: 8,
      junctionPenalty: 1,
      elevation: 100,
      ...shape(distance),
    });
  }
  return nodes;
};

const sweep = (nodes: TrackNode[], mode: TrackMode = 'point-to-point') =>
  sweepForSeparation({
    nodes,
    mode,
    spacingM: SPACING_M,
    // A circuit's last node is one spacing short of the line, because the lap
    // closes back onto node 0 rather than repeating it.
    totalLengthM:
      (nodes[nodes.length - 1] as TrackNode).distance + (mode === 'circuit' ? SPACING_M : 0),
  });

/** Distance-along-route falls inside a point's span. */
const covers = (point: { startM: number; endM: number }, distanceM: number): boolean =>
  distanceM >= point.startM && distanceM <= point.endM;

describe('the separation sweep', () => {
  it('finds nothing on a flat, wide, straight road', () => {
    // Short enough not to trip the exposed-stretch threshold: this is the
    // "analyzed, and there is nothing here" case, which has to stay
    // distinguishable from not having looked.
    expect(sweep(makeNodes(800))).toEqual([]);
  });

  describe('climbs', () => {
    it('finds a sustained climb and reports its gradient and length', () => {
      const nodes = makeNodes(1600, (d) => (d >= 400 && d < 1000 ? { gradient: 0.06 } : {}));
      const climbs = sweep(nodes).filter((p) => p.kind === 'climb');

      expect(climbs).toHaveLength(1);
      const climb = climbs[0] as (typeof climbs)[number];
      expect(covers(climb, 700)).toBe(true);
      expect(climb.detail).toContain('6.0%');
      // 600m at 6% is 36 vertical meters.
      expect(climb.detail).toContain('36m');
    });

    it('ignores a drag shallower than the climb threshold', () => {
      const shallow = SEPARATION.minClimbGradient - 0.01;
      const nodes = makeNodes(3000, (d) => (d >= 200 ? { gradient: shallow } : {}));
      expect(sweep(nodes).filter((p) => p.kind === 'climb')).toEqual([]);
    });

    it('ignores a steep ramp that is over too quickly', () => {
      const short = SEPARATION.minClimbLengthM - 50;
      const nodes = makeNodes(1000, (d) => (d >= 200 && d < 200 + short ? { gradient: 0.1 } : {}));
      expect(sweep(nodes).filter((p) => p.kind === 'climb')).toEqual([]);
    });

    it('ranks a steeper climb above a shallower one of the same length', () => {
      const steep = sweep(makeNodes(1200, (d) => (d >= 200 && d < 700 ? { gradient: 0.1 } : {})));
      const gentle = sweep(makeNodes(1200, (d) => (d >= 200 && d < 700 ? { gradient: 0.04 } : {})));

      const severityOf = (points: ReturnType<typeof sweep>) =>
        (points.find((p) => p.kind === 'climb') as { severity: number }).severity;
      expect(severityOf(steep)).toBeGreaterThan(severityOf(gentle));
    });

    it('reports a climb straddling a circuit start line as one climb, not two', () => {
      // The lap runs 0-2000m with the climb from 1800m round through 400m.
      const nodes = makeNodes(2000, (d) => (d >= 1800 || d < 400 ? { gradient: 0.06 } : {}));
      // Drop the duplicated closing node so the loop wraps cleanly.
      nodes.pop();

      const climbs = sweep(nodes, 'circuit').filter((p) => p.kind === 'climb');

      expect(climbs).toHaveLength(1);
      const climb = climbs[0] as (typeof climbs)[number];
      expect(climb.startM).toBeCloseTo(1800, 0);
      // Past the lap length rather than behind its own start.
      expect(climb.endM).toBeGreaterThan(climb.startM);
      expect(climb.endM).toBeCloseTo(2395, 0);
    });
  });

  describe('narrows', () => {
    it('finds a pinch point and reports how narrow it gets', () => {
      const nodes = makeNodes(1000, (d) => (d >= 300 && d < 600 ? { widthMeters: 2.5 } : {}));
      const narrows = sweep(nodes).filter((p) => p.kind === 'narrows');

      expect(narrows).toHaveLength(1);
      expect((narrows[0] as { detail: string }).detail).toContain('2.5m wide');
    });

    it('ignores a pinch too short to matter', () => {
      const short = SEPARATION.minNarrowLengthM - 20;
      const nodes = makeNodes(800, (d) => (d >= 300 && d < 300 + short ? { widthMeters: 2 } : {}));
      expect(sweep(nodes).filter((p) => p.kind === 'narrows')).toEqual([]);
    });
  });

  describe('technical sections', () => {
    it('finds repeated corners but not a single one', () => {
      const oneCorner = makeNodes(1200, (d) =>
        d >= 500 && d < 540 ? { curvatureRadius: 30 } : {},
      );
      expect(sweep(oneCorner).filter((p) => p.kind === 'technical')).toEqual([]);

      // Six corners inside 300m: the concertina.
      const many = makeNodes(1200, (d) =>
        d >= 400 && d < 700 && Math.floor(d / 50) % 2 === 0 ? { curvatureRadius: 30 } : {},
      );
      const technical = sweep(many).filter((p) => p.kind === 'technical');
      expect(technical).toHaveLength(1);
      expect((technical[0] as { detail: string }).detail).toMatch(/\d+ corners and junctions/);
    });

    it('counts a junction-heavy stretch even where the road is straight', () => {
      const nodes = makeNodes(1200, (d) =>
        d >= 300 && d < 700 && Math.floor(d / 60) % 2 === 0 ? { junctionPenalty: 0.25 } : {},
      );
      expect(sweep(nodes).filter((p) => p.kind === 'technical').length).toBeGreaterThan(0);
    });
  });

  describe('surfaces', () => {
    it('finds a cobbled sector', () => {
      const nodes = makeNodes(1200, (d) =>
        d >= 400 && d < 800 ? { surface: 'cobble' as SurfaceType } : {},
      );
      const rough = sweep(nodes).filter((p) => p.kind === 'surface');

      expect(rough).toHaveLength(1);
      expect((rough[0] as { detail: string }).detail).toContain('cobble');
    });

    it('says "assumed" when the surface was inferred rather than tagged', () => {
      const nodes = makeNodes(1200, (d) =>
        d >= 400 && d < 800
          ? { surface: 'gravel' as SurfaceType, surfaceConfidence: 'inferred' as const }
          : {},
      );
      const rough = sweep(nodes).filter((p) => p.kind === 'surface');
      expect((rough[0] as { detail: string }).detail).toContain('assumed gravel');
    });

    it('ranks cobbles above dirt over the same distance', () => {
      const severityFor = (surface: SurfaceType) => {
        const nodes = makeNodes(1200, (d) => (d >= 400 && d < 800 ? { surface } : {}));
        return (sweep(nodes).find((p) => p.kind === 'surface') as { severity: number }).severity;
      };
      expect(severityFor('cobble')).toBeGreaterThan(severityFor('dirt'));
    });

    it('does not flag a course that is entirely one rough surface', () => {
      // Every node qualifying is the course, not a sector of it.
      const nodes = makeNodes(1200, () => ({ surface: 'gravel' as SurfaceType }));
      expect(sweep(nodes).filter((p) => p.kind === 'surface')).toEqual([]);
    });
  });

  describe('exposed stretches', () => {
    it('flags a long constant-bearing road, and says it depends on the wind', () => {
      const nodes = makeNodes(4000, (d) => (d >= 2000 ? { bearing: 180 } : {}));
      const exposed = sweep(nodes).filter((p) => p.kind === 'exposed');

      expect(exposed).toHaveLength(2);
      for (const point of exposed) {
        expect(point.detail).toContain('crosswind');
        // Capped below the unconditional kinds: it only separates if it blows.
        expect(point.severity).toBeLessThanOrEqual(SEPARATION.maxExposedSeverity);
      }
    });

    it('does not flag a road that keeps turning', () => {
      // Ten degrees every 200m: never breaks a node-local test, but ends up
      // pointing somewhere else entirely.
      const nodes = makeNodes(4000, (d) => ({ bearing: 90 + Math.floor(d / 200) * 10 }));
      expect(sweep(nodes).filter((p) => p.kind === 'exposed')).toEqual([]);
    });
  });

  describe('the shape of the result', () => {
    it('returns points in the order they are ridden', () => {
      const nodes = makeNodes(3000, (d) => {
        if (d >= 300 && d < 700) return { surface: 'cobble' as SurfaceType };
        if (d >= 1200 && d < 1900) return { gradient: 0.07 };
        if (d >= 2200 && d < 2600) return { widthMeters: 2 };
        return {};
      });

      const points = sweep(nodes);
      expect(points.length).toBeGreaterThanOrEqual(3);
      const starts = points.map((p) => p.startM);
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
    });

    it('keeps only the strongest candidates on a course full of them', () => {
      // A climb every 200m for 20km: far more qualifying stretches than a
      // reader could use.
      const nodes = makeNodes(20000, (d) => (Math.floor(d / 200) % 2 === 0 ? { gradient: 0.08 } : {}));
      expect(sweep(nodes).length).toBeLessThanOrEqual(SEPARATION.maxPoints);
    });

    it('every span is non-empty and inside the route', () => {
      const nodes = makeNodes(3000, (d) => (d >= 500 && d < 1400 ? { gradient: 0.05 } : {}));
      for (const point of sweep(nodes)) {
        expect(point.endM).toBeGreaterThan(point.startM);
        expect(point.startM).toBeGreaterThanOrEqual(0);
        expect(point.severity).toBeGreaterThanOrEqual(0);
        expect(point.severity).toBeLessThanOrEqual(1);
      }
    });
  });
});

describe('course creation', () => {
  it('sweeps every track it bakes', async () => {
    const result = await buildTrack({
      id: 'swept',
      name: 'Swept course',
      mode: 'point-to-point',
      routingProfile: 'bicycle',
      waypoints: [ORIGIN, destinationPoint(ORIGIN, 90, 3000)],
      routing: createMockRoutingProvider({ seed: 'sweep-test' }),
      elevation: createMockElevationProvider({ seed: 'sweep-test' }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Present, and an array: "analyzed and found nothing" has to be
    // distinguishable from "never analyzed", which is what `undefined` means.
    expect(Array.isArray(result.value.separationPoints)).toBe(true);
  });
});
