import type { TileProvider } from '../tiles';

/**
 * A blank-canvas style. The map renders track geometry and racers over a plain
 * background with no network requests at all, which keeps tests and offline
 * development honest.
 */
export const createMockTileProvider = (): TileProvider => ({
  id: 'mock-tiles',
  styleUrl: () => 'data:application/json,' + encodeURIComponent(JSON.stringify(BLANK_STYLE)),
  attribution: 'Mock tiles (no basemap)',
  requiresApiKey: false,
});

const BLANK_STYLE = {
  version: 8,
  name: 'AnywhereRace blank',
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#12161c' },
    },
  ],
};
