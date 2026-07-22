import type { LatLng, Track, TrackNode } from '@anywhererace/core';
import type { SegmentHeat } from '@anywhererace/sim';
import { THEME } from './palette';

/**
 * The heat overlay's geometry, as GeoJSON.
 *
 * Split out of `RaceMap` so it can be tested in Node: the map component imports
 * `maplibre-gl`, which wants a DOM, and a gap between two bands is exactly the
 * kind of off-by-one that renders as a plausible-looking dashed line rather
 * than as an obvious failure.
 */

export type HeatFeatureCollection = {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    geometry: { type: 'LineString'; coordinates: [number, number][] };
    properties: { color: string; opacity: number; deltaS: number };
  }[];
};

const EMPTY: HeatFeatureCollection = { type: 'FeatureCollection', features: [] };

/** Never invisible, never solid — see the comment on the opacity below. */
const MIN_OPACITY = 0.15;
const OPACITY_RANGE = 0.65;

export const heatGeoJSON = (
  track: Pick<Track, 'nodes'>,
  heat: SegmentHeat | undefined,
): HeatFeatureCollection => {
  // A peak of zero means every band was exactly the field's pace, which in
  // practice means there was no race to compare against — one racer, or a
  // retirement before the first complete band.
  if (heat === undefined || heat.bands.length === 0 || heat.peakS <= 0) return EMPTY;

  return {
    type: 'FeatureCollection',
    features: heat.bands.flatMap((band) => {
      const points = nodesBetween(track.nodes, band.startM, band.endM);
      if (points.length < 2) return [];

      // Scaled to this race's own worst band. An absolute scale would render a
      // close race blank and a processional one saturated end to end.
      const intensity = Math.min(1, Math.abs(band.deltaS) / heat.peakS);
      return [
        {
          type: 'Feature' as const,
          geometry: {
            type: 'LineString' as const,
            coordinates: points.map((point): [number, number] => [point.lng, point.lat]),
          },
          properties: {
            color: band.deltaS <= 0 ? THEME.positive : THEME.danger,
            // A band at the field's pace still has to read as part of the
            // route, and is information in its own right: it says the road
            // decided nothing here.
            opacity: MIN_OPACITY + OPACITY_RANGE * intensity,
            deltaS: band.deltaS,
          },
        },
      ];
    }),
  };
};

/**
 * The nodes covering one band, inclusive at both ends.
 *
 * Inclusive at the end as well as the start is what makes the overlay one
 * continuous ribbon: neighbouring bands share their boundary vertex, so there
 * is no unpainted node between them.
 */
const nodesBetween = (
  nodes: readonly TrackNode[],
  startM: number,
  endM: number,
): LatLng[] => {
  const points: LatLng[] = [];
  for (const node of nodes) {
    if (node.distance < startM) continue;
    if (node.distance > endM) break;
    points.push({ lat: node.lat, lng: node.lng });
  }
  return points;
};
