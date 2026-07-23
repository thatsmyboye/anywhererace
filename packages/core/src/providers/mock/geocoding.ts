import { err, ok } from '../../result';
import type { Result } from '../../result';
import { MIN_QUERY_LENGTH } from '../geocoding';
import type {
  GeocodingError,
  GeocodingProvider,
  GeocodingSearchOptions,
  Place,
} from '../geocoding';

/**
 * A tiny fixed gazetteer, for tests.
 *
 * Unlike the other mocks this one is **not** wired in as a production fallback,
 * and that is the whole point of the difference. A synthetic DEM still gives
 * you hills to race over and a synthetic route still gives you a road; a
 * synthetic gazetteer would put "Lisbon" somewhere Lisbon is not, under a name
 * the user trusts. When the real service is down the app says search is
 * unavailable and leaves the map where it is.
 *
 * The entries are real places with real coordinates, chosen to cover every
 * `PlaceKind` and to include two of the same name — Springfield is the case a
 * result list exists to disambiguate.
 */

const GAZETTEER: readonly Place[] = [
  {
    id: 'mock-portugal',
    name: 'Portugal',
    context: '',
    kind: 'country',
    center: { lat: 39.6, lng: -8.0 },
    bounds: { south: 36.96, north: 42.15, west: -9.53, east: -6.19 },
  },
  {
    id: 'mock-lisbon',
    name: 'Lisbon',
    context: 'Portugal',
    kind: 'city',
    center: { lat: 38.7223, lng: -9.1393 },
    bounds: { south: 38.69, north: 38.8, west: -9.23, east: -9.09 },
  },
  {
    id: 'mock-somerset',
    name: 'Somerset',
    context: 'England, United Kingdom',
    kind: 'region',
    center: { lat: 51.1, lng: -3.0 },
    bounds: { south: 50.83, north: 51.35, west: -3.84, east: -2.25 },
  },
  {
    id: 'mock-bath',
    name: 'Bath',
    context: 'Somerset, England, United Kingdom',
    kind: 'town',
    center: { lat: 51.3811, lng: -2.359 },
    bounds: { south: 51.34, north: 51.42, west: -2.42, east: -2.3 },
  },
  {
    id: 'mock-springfield-il',
    name: 'Springfield',
    context: 'Illinois, United States',
    kind: 'city',
    center: { lat: 39.7817, lng: -89.6501 },
  },
  {
    id: 'mock-springfield-ma',
    name: 'Springfield',
    context: 'Massachusetts, United States',
    kind: 'city',
    center: { lat: 42.1015, lng: -72.5898 },
  },
  {
    id: 'mock-shoreditch',
    name: 'Shoreditch',
    context: 'London, England, United Kingdom',
    kind: 'district',
    center: { lat: 51.5265, lng: -0.0785 },
  },
  {
    id: 'mock-hallstatt',
    name: 'Hallstatt',
    context: 'Upper Austria, Austria',
    kind: 'village',
    center: { lat: 47.5622, lng: 13.6493 },
  },
];

export type MockGeocodingOptions = {
  /** Extra entries, or a different world entirely if `replace` is set. */
  places?: readonly Place[];
  replace?: boolean;
  /** Makes every lookup fail, for exercising the unavailable path. */
  failWith?: GeocodingError;
};

export const createMockGeocodingProvider = (
  options: MockGeocodingOptions = {},
): GeocodingProvider => {
  const places = options.replace === true
    ? (options.places ?? [])
    : [...GAZETTEER, ...(options.places ?? [])];

  return {
    id: 'mock-geocoding',

    async search(
      query: string,
      searchOptions: GeocodingSearchOptions = {},
    ): Promise<Result<Place[], GeocodingError>> {
      if (options.failWith !== undefined) return err(options.failWith);

      const trimmed = query.trim();
      if (trimmed.length < MIN_QUERY_LENGTH) {
        return err({
          kind: 'query-too-short',
          message: `Type at least ${MIN_QUERY_LENGTH} characters.`,
        });
      }

      const needle = trimmed.toLowerCase();
      const matches = places.filter(
        (place) =>
          place.name.toLowerCase().startsWith(needle) ||
          place.name.toLowerCase().includes(needle),
      );

      return ok(matches.slice(0, searchOptions.limit ?? 6));
    },
  };
};
