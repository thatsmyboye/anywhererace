import type { TileProvider } from './tiles';
import { createMockTileProvider } from './mock/tiles';

/**
 * MapTiler vector tiles.
 *
 * Needs an API key, which is supplied at build time through an environment
 * variable and is never committed. When no key is configured this falls back to
 * the blank basemap rather than rendering a broken map or, worse, firing off
 * requests that 403 — so a fresh clone runs with no setup at all and the
 * developer gets a clear message telling them what they are missing.
 *
 * The key is not a secret in the usual sense — anything shipped to a browser is
 * public — but it is rate-limited and billable, so it should be restricted by
 * HTTP referrer in the MapTiler dashboard to the domains that are meant to use
 * it.
 */

export type MapTilerOptions = {
  /** The MapTiler API key, or undefined when none is configured. */
  apiKey: string | undefined;
  /**
   * Which MapTiler style to load. `dataviz-dark` is the default because the
   * app is dark-themed and its muted palette leaves racer colours as the only
   * saturated thing on screen.
   */
  style?: string;
};

const DEFAULT_STYLE = 'dataviz-dark';

export const createMapTilerProvider = (options: MapTilerOptions): TileProvider => {
  const { apiKey, style = DEFAULT_STYLE } = options;

  if (apiKey === undefined || apiKey.trim() === '') {
    return createMockTileProvider();
  }

  return {
    id: 'maptiler',
    styleUrl: () =>
      `https://api.maptiler.com/maps/${encodeURIComponent(style)}/style.json?key=${encodeURIComponent(apiKey)}`,
    attribution:
      '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noreferrer">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">&copy; OpenStreetMap contributors</a>',
    requiresApiKey: true,
  };
};

/** Whether a real basemap is configured, so the UI can say so if not. */
export const hasBasemapKey = (apiKey: string | undefined): boolean =>
  apiKey !== undefined && apiKey.trim() !== '';
