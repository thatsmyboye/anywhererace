import type { LatLngBounds } from '../geo';
import type { Result } from '../result';
import type { LatLng } from '../types/track';

/**
 * Place lookup, for pointing the map at somewhere before you start drawing.
 *
 * Deliberately coarse. This answers "take me to Lisbon", not "take me to 14
 * Rua Garrett" — the user is about to draw a course by hand, so what they need
 * is the right few square kilometers on screen, and a search that also returned
 * streets, cafes and mountains would bury the one result they wanted. Providers
 * are expected to filter to settlements and administrative areas; anything
 * finer is noise here.
 *
 * Nothing downstream depends on this. A track records the waypoints the user
 * placed, never the place they searched for, so a course is not tied to a
 * gazetteer entry that might be renamed or deleted later.
 */
export interface GeocodingProvider {
  readonly id: string;
  search(
    query: string,
    options?: GeocodingSearchOptions,
  ): Promise<Result<Place[], GeocodingError>>;
}

export type GeocodingSearchOptions = {
  /** How many results to return. Providers may return fewer. */
  limit?: number;
  /** Cancels an in-flight lookup when the query moves on under it. */
  signal?: AbortSignal;
};

/**
 * What kind of place this is, coarse enough to be worth showing beside a
 * result. It exists to disambiguate the half-dozen Springfields, not to be
 * modelled on any particular country's administrative hierarchy.
 */
export type PlaceKind = 'country' | 'region' | 'city' | 'town' | 'village' | 'district';

export type Place = {
  /** Stable within one provider. Used as a list key, nothing more. */
  id: string;
  /** The place's own name: "Bath". */
  name: string;
  /** Where it is, for telling two of the same name apart. May be empty. */
  context: string;
  kind: PlaceKind;
  center: LatLng;
  /**
   * The place's extent, when the provider knows it.
   *
   * Worth having rather than guessing a zoom from `kind`: a country and a city
   * differ by six zoom levels, but so do Russia and Monaco. Framing the bounds
   * puts the whole place on screen whatever size it is. Absent means fall back
   * to a zoom picked from `kind`.
   */
  bounds?: LatLngBounds;
};

export type GeocodingErrorKind =
  | 'provider-unavailable'
  | 'rate-limited'
  /** The query was too short to be worth sending. Not an error worth showing. */
  | 'query-too-short';

export type GeocodingError = {
  kind: GeocodingErrorKind;
  message: string;
};

/** Below this a query matches half the planet and the lookup is not worth making. */
export const MIN_QUERY_LENGTH = 2;

/**
 * A default zoom per kind, for providers that report no bounds.
 *
 * These are chosen to put the *whole* place roughly on screen on a laptop, on
 * the reasoning that a user who searched for a town wants to see the town and
 * pick a corner of it, not to land in the middle of one street.
 */
export const ZOOM_FOR_KIND: Record<PlaceKind, number> = {
  country: 5,
  region: 8,
  city: 11,
  town: 13,
  village: 14,
  district: 14,
};
