import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import type { LatLng, LatLngBounds } from '@anywhererace/core';
import { interpolateLatLng } from '@anywhererace/core';
import { insertIndexForLeg, midpointOfPolyline } from '@anywhererace/track';
import { THEME } from '../../palette';
import type { BuilderLeg } from '../../useTrackBuilder';

/**
 * The drawing surface.
 *
 * Waypoints are DOM markers here, unlike the racers in the race view. That is a
 * deliberate inversion: there are at most a few dozen of them, they never move
 * on their own, and they need to be draggable — which MapLibre gives for free
 * on a `Marker` and would otherwise mean hand-rolling hit-testing and pointer
 * capture against a GL layer. The forty-markers-at-60fps argument does not
 * apply to something the user drags one at a time.
 *
 * The route itself is a GL line layer, split into routed and failed segments so
 * a leg that cannot be driven is visible at a glance rather than simply absent.
 */

const ROUTE_SOURCE = 'builder-route';
const FAILED_SOURCE = 'builder-failed';

/**
 * Somewhere to point the camera, after the map already exists.
 *
 * Separate from `initialCenter` because they answer different questions:
 * `initialCenter` is where the map opens, and changing it rebuilds the map,
 * which would throw away the user's pan and zoom. This just moves the camera.
 * A fresh object means "go there now", so selecting the same place twice moves
 * the map twice — which is what a user who has since panned away expects.
 */
export type MapFocus = {
  center: LatLng;
  /** Used when there are no bounds to frame. */
  zoom: number;
  /** Preferred when present: framing the extent beats guessing a zoom. */
  bounds?: LatLngBounds | undefined;
};

export type BuilderMapProps = {
  waypoints: readonly LatLng[];
  legs: readonly BuilderLeg[];
  styleUrl: string;
  attribution: string;
  /** Where to open the map when there is nothing drawn yet. */
  initialCenter: LatLng;
  initialZoom: number;
  /** Move the camera here. Nothing drawn is affected. */
  focus?: MapFocus | undefined;
  onAddWaypoint: (point: LatLng) => void;
  /** Put a new waypoint at `index`, splitting the leg it was dragged out of. */
  onInsertWaypoint: (index: number, point: LatLng) => void;
  onMoveWaypoint: (index: number, point: LatLng) => void;
  onRemoveWaypoint: (index: number) => void;
};

/**
 * Never frame a place closer than this, however small its bounds. A hamlet's
 * bounding box can be two hundred meters across, and landing at zoom 18 puts
 * the user inside a single junction with no idea which way the town runs.
 */
const MAX_FOCUS_ZOOM = 15;

export const BuilderMap = ({
  waypoints,
  legs,
  styleUrl,
  attribution,
  initialCenter,
  initialZoom,
  focus,
  onAddWaypoint,
  onInsertWaypoint,
  onMoveWaypoint,
  onRemoveWaypoint,
}: BuilderMapProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | undefined>(undefined);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const handleMarkersRef = useRef<maplibregl.Marker[]>([]);

  // Handlers are read through refs so the map is built once and never rebuilt
  // just because a callback identity changed.
  const handlers = useRef({
    onAddWaypoint,
    onInsertWaypoint,
    onMoveWaypoint,
    onRemoveWaypoint,
  });
  handlers.current = { onAddWaypoint, onInsertWaypoint, onMoveWaypoint, onRemoveWaypoint };

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const map = new maplibregl.Map({
      container,
      style: styleUrl,
      center: [initialCenter.lng, initialCenter.lat],
      zoom: initialZoom,
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: false,
    });
    map.addControl(
      new maplibregl.AttributionControl({ compact: true, customAttribution: attribution }),
    );
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    mapRef.current = map;

    map.on('load', () => {
      addRouteLayers(map);
    });

    const onClick = (event: MapMouseEvent): void => {
      handlers.current.onAddWaypoint({ lat: event.lngLat.lat, lng: event.lngLat.lng });
    };
    map.on('click', onClick);
    // A crosshair says "click to place" far better than any tooltip.
    map.getCanvas().style.cursor = 'crosshair';

    return () => {
      map.off('click', onClick);
      map.remove();
      mapRef.current = undefined;
    };
    // Style and attribution come from a provider chosen once at startup.
  }, [styleUrl, attribution, initialCenter.lat, initialCenter.lng, initialZoom]);

  // --- camera --------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map === undefined || focus === undefined) return;

    if (focus.bounds !== undefined) {
      const { south, west, north, east } = focus.bounds;
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: 48, maxZoom: MAX_FOCUS_ZOOM },
      );
      return;
    }
    map.flyTo({ center: [focus.center.lng, focus.center.lat], zoom: focus.zoom });
  }, [focus]);

  // --- waypoint markers ----------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map === undefined) return;

    for (const marker of markersRef.current) marker.remove();
    markersRef.current = waypoints.map((point, index) => {
      const element = waypointElement(index, index === 0, waypoints.length);
      const marker = new maplibregl.Marker({ element, draggable: true })
        .setLngLat([point.lng, point.lat])
        .addTo(map);

      marker.on('dragend', () => {
        const { lat, lng } = marker.getLngLat();
        handlers.current.onMoveWaypoint(index, { lat, lng });
      });

      element.addEventListener('click', (event) => {
        // Without this the click falls through to the map and immediately adds
        // a new waypoint where the one just deleted used to be.
        event.stopPropagation();
        handlers.current.onRemoveWaypoint(index);
      });

      return marker;
    });

    return () => {
      for (const marker of markersRef.current) marker.remove();
      markersRef.current = [];
    };
  }, [waypoints]);

  // --- insert handles ------------------------------------------------------
  /**
   * One ghost handle at the middle of every leg. Dragging it off the line puts
   * a new waypoint there and splits the leg in two, which is the standard
   * gesture for editing the middle of a route and the reason a long route no
   * longer has to be cleared and redrawn to change one corner of it.
   *
   * Keyed off `legs` rather than `waypoints` because the handle belongs on the
   * *road*, not on the straight line between two pins — on anything but a
   * dead-straight leg those are nowhere near each other.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (map === undefined) return;

    for (const marker of handleMarkersRef.current) marker.remove();
    handleMarkersRef.current = legs.flatMap((leg) => {
      const at = handlePosition(leg);
      if (at === undefined) return [];

      const insertIndex = insertIndexForLeg(leg, waypoints.length);

      const element = insertHandleElement(leg.status.state === 'failed');
      const marker = new maplibregl.Marker({ element, draggable: true })
        .setLngLat([at.lng, at.lat])
        .addTo(map);

      // A click on the handle lands after `dragend` in most browsers, so a drag
      // would otherwise insert twice — once where it was dropped and once back
      // at the midpoint it started from.
      let draggedAtMs = 0;
      marker.on('dragend', () => {
        draggedAtMs = Date.now();
        const { lat, lng } = marker.getLngLat();
        handlers.current.onInsertWaypoint(insertIndex, { lat, lng });
      });
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        if (Date.now() - draggedAtMs < 250) return;
        // Clicking without dragging pins the route where it already runs,
        // which is how you stop a later edit from rerouting this stretch.
        handlers.current.onInsertWaypoint(insertIndex, at);
      });

      return [marker];
    });

    return () => {
      for (const marker of handleMarkersRef.current) marker.remove();
      handleMarkersRef.current = [];
    };
  }, [legs, waypoints.length]);

  // --- route geometry ------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map === undefined) return;

    const apply = (): void => {
      const routed = map.getSource<GeoJSONSource>(ROUTE_SOURCE);
      const failed = map.getSource<GeoJSONSource>(FAILED_SOURCE);
      if (routed === undefined || failed === undefined) return;
      routed.setData(routedGeoJSON(legs));
      failed.setData(failedGeoJSON(legs));
    };

    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [legs]);

  return <div ref={containerRef} className="h-full w-full" />;
};

// ---------------------------------------------------------------------------

const addRouteLayers = (map: MapLibreMap): void => {
  const empty = { type: 'FeatureCollection', features: [] } as const;
  if (map.getSource(ROUTE_SOURCE) === undefined) {
    map.addSource(ROUTE_SOURCE, { type: 'geojson', data: empty });
    map.addLayer({
      id: `${ROUTE_SOURCE}-casing`,
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': THEME.trackCasing, 'line-width': 9, 'line-opacity': 0.9 },
    });
    map.addLayer({
      id: `${ROUTE_SOURCE}-line`,
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': THEME.accent, 'line-width': 5 },
    });
  }

  if (map.getSource(FAILED_SOURCE) === undefined) {
    map.addSource(FAILED_SOURCE, { type: 'geojson', data: empty });
    // A dashed red straight line between the two waypoints: it is not a route,
    // and it must not look like one.
    map.addLayer({
      id: `${FAILED_SOURCE}-line`,
      type: 'line',
      source: FAILED_SOURCE,
      layout: { 'line-cap': 'butt' },
      paint: {
        'line-color': THEME.danger,
        'line-width': 3,
        'line-dasharray': [2, 2],
        'line-opacity': 0.9,
      },
    });
  }
};

type FeatureCollection = {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    geometry: { type: 'LineString'; coordinates: [number, number][] };
    properties: Record<string, string | number>;
  }[];
};

const routedGeoJSON = (legs: readonly BuilderLeg[]): FeatureCollection => ({
  type: 'FeatureCollection',
  features: legs.flatMap((leg) =>
    leg.status.state === 'ok'
      ? [
          {
            type: 'Feature' as const,
            geometry: {
              type: 'LineString' as const,
              coordinates: leg.status.leg.polyline.map(
                (point): [number, number] => [point.lng, point.lat],
              ),
            },
            properties: { fromIndex: leg.fromIndex },
          },
        ]
      : [],
  ),
});

const failedGeoJSON = (legs: readonly BuilderLeg[]): FeatureCollection => ({
  type: 'FeatureCollection',
  features: legs.flatMap((leg) =>
    leg.status.state === 'failed'
      ? [
          {
            type: 'Feature' as const,
            geometry: {
              type: 'LineString' as const,
              coordinates: [
                [leg.from.lng, leg.from.lat],
                [leg.to.lng, leg.to.lat],
              ],
            },
            properties: { fromIndex: leg.fromIndex },
          },
        ]
      : [],
  ),
});

/**
 * Where a leg's insert handle goes.
 *
 * On the routed road where there is one. A leg that failed to route has no
 * geometry, and its straight dashed line is the only thing on screen to grab —
 * which is exactly when inserting a waypoint is most useful, since a waypoint
 * dropped part way along is how a user routes around whatever is blocking it.
 */
const handlePosition = (leg: BuilderLeg): LatLng | undefined =>
  leg.status.state === 'ok'
    ? midpointOfPolyline(leg.status.leg.polyline)
    : interpolateLatLng(leg.from, leg.to, 0.5);

/**
 * A ghost handle at the middle of a leg. Deliberately smaller and dimmer than
 * a waypoint: it is not part of the route the user drew, it is somewhere they
 * *could* put one, and it must not be mistaken for a corner that already
 * exists.
 */
const insertHandleElement = (onFailedLeg: boolean): HTMLElement => {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = '+';
  element.title = 'Drag to add a waypoint here and split this leg';
  element.setAttribute('aria-label', 'Add a waypoint in the middle of this leg');
  element.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'width:16px',
    'height:16px',
    'border-radius:50%',
    'font:700 12px/1 system-ui,sans-serif',
    'cursor:grab',
    `background:${onFailedLeg ? THEME.danger : THEME.text}`,
    `color:${THEME.background}`,
    `border:2px solid ${THEME.background}`,
    'opacity:0.55',
    'padding:0',
  ].join(';');
  element.addEventListener('mouseenter', () => {
    element.style.opacity = '1';
  });
  element.addEventListener('mouseleave', () => {
    element.style.opacity = '0.55';
  });
  return element;
};

/**
 * A waypoint marker. Built by hand rather than with MapLibre's default pin so
 * the start is distinguishable and the number matches the side panel's list.
 */
const waypointElement = (index: number, isStart: boolean, total: number): HTMLElement => {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = String(index + 1);
  element.title = `Waypoint ${index + 1} of ${total} — click to remove, drag to move`;
  element.setAttribute('aria-label', `Waypoint ${index + 1}. Click to remove.`);
  element.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'width:24px',
    'height:24px',
    'border-radius:50%',
    'font:700 12px/1 system-ui,sans-serif',
    'cursor:pointer',
    `background:${isStart ? THEME.positive : THEME.text}`,
    `color:${THEME.background}`,
    `border:2px solid ${THEME.background}`,
    'box-shadow:0 1px 4px rgba(0,0,0,.6)',
    'padding:0',
  ].join(';');
  return element;
};
