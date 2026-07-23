import { describe, expect, it } from 'vitest';
import type { TrackNode } from '@anywhererace/core';
import type { SegmentHeat } from '@anywhererace/sim';
import { heatGeoJSON } from '../src/heatGeometry';
import { THEME } from '../src/palette';

/** A straight lap of 5m-spaced nodes, which is what the baker produces. */
const nodes = (lengthM: number): TrackNode[] => {
  const out: TrackNode[] = [];
  for (let d = 0; d <= lengthM; d += 5) {
    out.push({
      distance: d,
      lat: 51 + d / 100_000,
      lng: -0.1,
      bearing: 0,
      curvatureRadius: Infinity,
      gradient: 0,
      surface: 'asphalt',
      surfaceConfidence: 'tagged',
      widthMeters: 6,
      junctionPenalty: 1,
      elevation: 10,
    });
  }
  return out;
};

const track = { nodes: nodes(300) };

const heat = (bands: { startM: number; endM: number; deltaS: number }[]): SegmentHeat => ({
  racerId: 'a',
  bands,
  peakS: Math.max(...bands.map((band) => Math.abs(band.deltaS))),
});

describe('the heat overlay geometry', () => {
  it('draws one feature per band', () => {
    const data = heatGeoJSON(
      track,
      heat([
        { startM: 0, endM: 100, deltaS: -1 },
        { startM: 100, endM: 200, deltaS: 1 },
      ]),
    );
    expect(data.features).toHaveLength(2);
  });

  it('leaves no gap between neighbouring bands', () => {
    // The boundary node belongs to both, so the ribbon is continuous. Without
    // this the overlay renders as a dashed line and reads as a bug.
    const data = heatGeoJSON(
      track,
      heat([
        { startM: 0, endM: 100, deltaS: -1 },
        { startM: 100, endM: 200, deltaS: 1 },
      ]),
    );
    const first = data.features[0]?.geometry.coordinates;
    const second = data.features[1]?.geometry.coordinates;
    expect(first?.[first.length - 1]).toEqual(second?.[0]);
  });

  it('colours a gain green and a loss red', () => {
    const data = heatGeoJSON(
      track,
      heat([
        { startM: 0, endM: 100, deltaS: -1 },
        { startM: 100, endM: 200, deltaS: 2 },
      ]),
    );
    expect(data.features[0]?.properties.color).toBe(THEME.positive);
    expect(data.features[1]?.properties.color).toBe(THEME.danger);
  });

  it('scales opacity to the race, not to an absolute number of seconds', () => {
    const data = heatGeoJSON(
      track,
      heat([
        { startM: 0, endM: 100, deltaS: 0 },
        { startM: 100, endM: 200, deltaS: 4 },
      ]),
    );
    const flat = data.features[0]?.properties.opacity ?? 0;
    const worst = data.features[1]?.properties.opacity ?? 0;
    expect(worst).toBeGreaterThan(flat);
    // Even a band level with the field is drawn: it says the road decided
    // nothing there, which is worth seeing.
    expect(flat).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('draws nothing when there is nothing to say', () => {
    expect(heatGeoJSON(track, undefined).features).toEqual([]);
    expect(heatGeoJSON(track, { racerId: 'a', bands: [], peakS: 0 }).features).toEqual([]);
    // Every band exactly at the field's pace: one racer, or a retirement before
    // any band was completed. A ramp with no range is not a heat map.
    expect(
      heatGeoJSON(track, {
        racerId: 'a',
        bands: [{ startM: 0, endM: 100, deltaS: 0 }],
        peakS: 0,
      }).features,
    ).toEqual([]);
  });

  it('skips a band the track has no geometry for', () => {
    // A band past the end of the nodes cannot be drawn, and must not produce a
    // one-point LineString that MapLibre would reject.
    const data = heatGeoJSON(track, heat([{ startM: 900, endM: 1000, deltaS: 3 }]));
    expect(data.features).toEqual([]);
  });
});
