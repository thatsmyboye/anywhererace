import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Track } from '@anywhererace/core';
import type { SegmentHeat } from '@anywhererace/sim';
import { positionOnTrack, trackBounds, trackToGeoJSON } from '@anywhererace/track';
import { heatGeoJSON } from '../heatGeometry';
import { buildMarkerImages, markerImageId } from '../markers';
import { THEME } from '../palette';
import type { FrameBuffer, RacerView } from '../useRaceClient';

/**
 * The map, and the racers on it.
 *
 * Racers are drawn by a single GL symbol layer fed from one GeoJSON source,
 * updated once per animation frame. The alternative — a DOM marker per racer —
 * is explicitly ruled out by CLAUDE.md and would not survive forty racers at
 * 60fps.
 *
 * The other half of the job is interpolation. The simulation ticks at 20Hz and
 * the worker throttles frames to 10Hz; rendering at that rate would look like a
 * slideshow. Positions are therefore interpolated between the last two frames
 * on every animation frame, which is why the frame buffer is a ref rather than
 * React state.
 */

const TRACK_SOURCE = 'race-track';
const RACER_SOURCE = 'race-racers';
const START_SOURCE = 'race-start-line';
const HEAT_SOURCE = 'race-heat';

export type RaceMapProps = {
  track: Track;
  racers: readonly RacerView[];
  frameRef: React.RefObject<FrameBuffer>;
  /** MapLibre style URL. */
  styleUrl: string;
  attribution: string;
  /**
   * Where one racer gained and lost against the field, drawn over the route.
   * Undefined leaves the track its plain colour.
   */
  heat?: SegmentHeat | undefined;
};

export const RaceMap = ({
  track,
  racers,
  frameRef,
  styleUrl,
  attribution,
  heat,
}: RaceMapProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | undefined>(undefined);
  const racersRef = useRef(racers);
  racersRef.current = racers;

  // --- map lifecycle -------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const map = new maplibregl.Map({
      container,
      style: styleUrl,
      bounds: trackBounds(track),
      fitBoundsOptions: { padding: 80 },
      attributionControl: false,
      // The race is the content; tilting and rotating only makes a 1D race
      // harder to read.
      pitchWithRotate: false,
      dragRotate: false,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: attribution }));
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    mapRef.current = map;

    map.on('load', () => {
      addTrackLayers(map, track);
      addRacerLayers(map, racersRef.current);
    });

    return () => {
      map.remove();
      mapRef.current = undefined;
    };
  }, [track, styleUrl, attribution]);

  // --- racer images, rebuilt when the field changes -------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map === undefined || racers.length === 0) return;
    if (!map.isStyleLoaded()) {
      map.once('load', () => addRacerLayers(map, racers));
      return;
    }
    addRacerLayers(map, racers);
  }, [racers]);

  // --- the heat overlay ----------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map === undefined) return;

    const apply = (): void => {
      const source = map.getSource<GeoJSONSource>(HEAT_SOURCE);
      if (source === undefined) return;
      source.setData(heatGeoJSON(track, heat));
    };

    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [track, heat]);

  // --- the render loop -----------------------------------------------------
  useEffect(() => {
    let handle = 0;
    // Once interpolation for a frame has run out, there is nothing new to draw
    // until the next frame arrives. Without this the map keeps rebuilding an
    // identical GeoJSON collection sixty times a second while the race is
    // paused or finished, which is pure battery drain on a laptop.
    let settledForTick = -1;

    const render = () => {
      handle = requestAnimationFrame(render);
      const map = mapRef.current;
      const buffer = frameRef.current;
      if (map === undefined || buffer?.current === undefined) return;
      if (settledForTick === buffer.current.tick) return;

      const source = map.getSource<GeoJSONSource>(RACER_SOURCE);
      if (source === undefined) return;

      const { features, settled } = buildRacerFeatures(track, racersRef.current, buffer);
      source.setData(features);
      if (settled) settledForTick = buffer.current.tick;
    };

    handle = requestAnimationFrame(render);
    return () => cancelAnimationFrame(handle);
  }, [track, frameRef]);

  // Sized with height/width rather than `absolute inset-0`: MapLibre's own
  // stylesheet sets `.maplibregl-map { position: relative }` on whatever
  // element it is given, at equal specificity and imported later, so the
  // absolute positioning loses and the container silently collapses to nothing.
  return <div ref={containerRef} className="h-full w-full" />;
};

// ---------------------------------------------------------------------------

const addTrackLayers = (map: MapLibreMap, track: Track): void => {
  if (map.getSource(TRACK_SOURCE) !== undefined) return;

  map.addSource(TRACK_SOURCE, { type: 'geojson', data: trackToGeoJSON(track) });

  // A dark casing under a lighter line, so the route reads over any basemap.
  map.addLayer({
    id: `${TRACK_SOURCE}-casing`,
    type: 'line',
    source: TRACK_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': THEME.trackCasing,
      'line-width': ['interpolate', ['linear'], ['zoom'], 12, 6, 18, 22],
      'line-opacity': 0.9,
    },
  });
  map.addLayer({
    id: `${TRACK_SOURCE}-line`,
    type: 'line',
    source: TRACK_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': THEME.trackLine,
      'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3, 18, 16],
    },
  });

  // Above the route line and below the racers: the overlay is about the road,
  // so it should colour the road, but it must never hide who is on it.
  map.addSource(HEAT_SOURCE, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: `${HEAT_SOURCE}-line`,
    type: 'line',
    source: HEAT_SOURCE,
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: {
      // Colour is computed per band rather than through an expression, because
      // the ramp is scaled to the race's own peak and MapLibre would need that
      // peak baked into the stops anyway.
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 12, 5, 18, 20],
      'line-opacity': ['get', 'opacity'],
    },
  });

  const start = positionOnTrack(track, 0);
  map.addSource(START_SOURCE, {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [start.lng, start.lat] },
      properties: { bearing: start.bearing },
    },
  });
  map.addLayer({
    id: `${START_SOURCE}-marker`,
    type: 'circle',
    source: START_SOURCE,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 18, 8],
      'circle-color': THEME.text,
      'circle-stroke-color': THEME.background,
      'circle-stroke-width': 2,
    },
  });
};

const addRacerLayers = (map: MapLibreMap, racers: readonly RacerView[]): void => {
  const images = buildMarkerImages(racers);
  if (images !== undefined) {
    for (const image of images) {
      if (map.hasImage(image.id)) map.removeImage(image.id);
      map.addImage(image.id, image.data, { pixelRatio: image.pixelRatio });
    }
  }

  if (map.getSource(RACER_SOURCE) === undefined) {
    map.addSource(RACER_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
  }

  if (map.getLayer(`${RACER_SOURCE}-symbols`) === undefined) {
    map.addLayer({
      id: `${RACER_SOURCE}-symbols`,
      type: 'symbol',
      source: RACER_SOURCE,
      layout: {
        'icon-image': ['get', 'icon'],
        // Racers overlap constantly in a pack; hiding the ones that collide
        // would make a bunch look like a single car.
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        // The name fades in past a zoom threshold, per CLAUDE.md.
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 1.4],
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: {
        'text-color': THEME.text,
        'text-halo-color': THEME.background,
        'text-halo-width': 1.5,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.5, 1],
      },
    });
  }

  // Fallback for when no canvas was available to generate icons: a plain
  // coloured circle still communicates position, just without the number.
  if (images === undefined && map.getLayer(`${RACER_SOURCE}-fallback`) === undefined) {
    map.addLayer({
      id: `${RACER_SOURCE}-fallback`,
      type: 'circle',
      source: RACER_SOURCE,
      paint: {
        'circle-radius': 7,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': THEME.background,
        'circle-stroke-width': 2,
      },
    });
  }
};

type RacerFeatureCollection = {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: Record<string, string | number | boolean>;
  }[];
};

/**
 * Positions for this animation frame, interpolated between the last two
 * simulation frames.
 *
 * `settled` reports that interpolation has reached the latest frame, so the
 * caller can stop redrawing until a new one arrives.
 */
const buildRacerFeatures = (
  track: Track,
  racers: readonly RacerView[],
  buffer: FrameBuffer,
): { features: RacerFeatureCollection; settled: boolean } => {
  const current = buffer.current;
  if (current === undefined) {
    return { features: { type: 'FeatureCollection', features: [] }, settled: true };
  }

  const previous = buffer.previous;
  const elapsed = performance.now() - buffer.currentAtMs;
  // Clamped to 1: if the next frame is late, hold at the latest known position
  // rather than extrapolating racers off down the road.
  const t = previous === undefined ? 1 : Math.min(1, elapsed / buffer.frameDurationMs);

  const previousById = new Map(previous?.racers.map((racer) => [racer.racerId, racer]) ?? []);
  const byId = new Map(racers.map((racer) => [racer.racerId, racer]));

  const features: RacerFeatureCollection['features'] = [];
  for (const racer of current.racers) {
    const view = byId.get(racer.racerId);
    if (view === undefined) continue;

    const before = previousById.get(racer.racerId);
    const distance =
      before === undefined
        ? racer.distanceAlongRoute
        : before.distanceAlongRoute + (racer.distanceAlongRoute - before.distanceAlongRoute) * t;
    const lateral =
      before === undefined
        ? racer.lateralOffset
        : before.lateralOffset + (racer.lateralOffset - before.lateralOffset) * t;

    const point = positionOnTrack(track, distance, lateral);
    const retired =
      racer.status === 'dnf-crash' ||
      racer.status === 'dnf-mechanical' ||
      racer.status === 'dnf-timeout';

    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
      properties: {
        icon: markerImageId(racer.racerId, retired),
        name: view.name,
        color: view.appearance.color,
        position: racer.position,
        bearing: point.bearing,
      },
    });
  }

  // Draw the leaders last so they sit on top of the pack they are lapping.
  features.sort((a, b) => Number(b.properties.position) - Number(a.properties.position));
  return { features: { type: 'FeatureCollection', features }, settled: t >= 1 };
};
