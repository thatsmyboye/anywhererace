import type { LatLngBounds } from '../geo';
import { err, ok } from '../result';
import type { Result } from '../result';
import { MIN_QUERY_LENGTH } from './geocoding';
import type {
  GeocodingError,
  GeocodingProvider,
  GeocodingSearchOptions,
  Place,
  PlaceKind,
} from './geocoding';

/**
 * Nominatim, the OSM gazetteer, for "take me to Lisbon".
 *
 * Free and keyless, like everything else here, and bound by a usage policy the
 * app has to respect rather than merely know about: at most one request per
 * second, and no bulk querying. The caller debounces — see `useMapSearch` — and
 * every request carries an abort signal, so a fast typist produces one lookup
 * rather than one per keystroke. A browser cannot set `User-Agent`, so the
 * identification the policy asks for is the `Referer` the browser sends
 * automatically.
 *
 * There is no fallback behind this and there should not be. A synthetic router
 * still draws a road you can race; a synthetic gazetteer would send you to a
 * place that does not exist, under a name that does. When Nominatim is down the
 * honest answer is to say search is unavailable and let the user pan.
 */

export type NominatimOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * Passed as `accept-language`. Defaults to the browser's, so a French user
   * searching "Londres" finds London.
   */
  language?: string;
  fetchImpl?: typeof fetch;
};

const DEFAULTS = {
  baseUrl: 'https://nominatim.openstreetmap.org',
  timeoutMs: 8_000,
  /**
   * Over-fetch, because the filter below throws a lot away. Searching a common
   * name returns streets and businesses ahead of the town they are named after,
   * and asking for five would routinely yield none.
   */
  fetchLimit: 20,
  resultLimit: 6,
} as const;

/**
 * OSM `addresstype` values worth offering, mapped to our coarse kinds.
 *
 * An allowlist rather than a blocklist: OSM has hundreds of feature types and
 * new ones appear, so the failure mode of a blocklist is a mountain range
 * turning up in a place search one day. Everything absent here is dropped —
 * including `road`, `house_number` and every POI category, which is the point.
 */
const KIND_BY_ADDRESS_TYPE: Record<string, PlaceKind> = {
  country: 'country',
  state: 'region',
  province: 'region',
  region: 'region',
  state_district: 'region',
  county: 'region',
  city: 'city',
  municipality: 'city',
  borough: 'city',
  town: 'town',
  village: 'village',
  hamlet: 'village',
  isolated_dwelling: 'village',
  suburb: 'district',
  city_district: 'district',
  district: 'district',
  quarter: 'district',
  neighbourhood: 'district',
};

export const createNominatimProvider = (options: NominatimOptions = {}): GeocodingProvider => {
  const baseUrl = options.baseUrl ?? DEFAULTS.baseUrl;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const language = options.language ?? globalThis.navigator?.language;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  return {
    id: 'nominatim',

    async search(
      query: string,
      searchOptions: GeocodingSearchOptions = {},
    ): Promise<Result<Place[], GeocodingError>> {
      const trimmed = query.trim();
      if (trimmed.length < MIN_QUERY_LENGTH) {
        return err({
          kind: 'query-too-short',
          message: `Type at least ${MIN_QUERY_LENGTH} characters.`,
        });
      }

      const params = new URLSearchParams({
        q: trimmed,
        format: 'jsonv2',
        limit: String(DEFAULTS.fetchLimit),
        // Drops POIs, natural features and man-made objects server-side. The
        // allowlist below still has to run — `address` includes streets and
        // house numbers — but this removes the bulk of what we do not want.
        layer: 'address',
        // Only for the postcode, which is then removed from the context line by
        // value. Pattern-matching it out is not possible across countries:
        // nothing distinguishes "BA1 1AP" from a place name without knowing
        // where you are, and a heuristic would eventually delete a real county.
        addressdetails: '1',
      });
      if (language !== undefined) params.set('accept-language', language);

      // Two reasons a lookup ends early: the caller moved on (a new keystroke),
      // or the service is not answering. Both abort the same fetch, and the
      // caller's signal has to win so a superseded search stays silent.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onCallerAbort = (): void => controller.abort();
      searchOptions.signal?.addEventListener('abort', onCallerAbort);

      try {
        const response = await doFetch(`${baseUrl}/search?${params.toString()}`, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });

        if (response.status === 429) {
          return err({
            kind: 'rate-limited',
            message: 'Place search is being rate-limited. Wait a moment and try again.',
          });
        }
        if (!response.ok) {
          return err({
            kind: 'provider-unavailable',
            message: `Place search returned ${response.status}.`,
          });
        }

        const payload: unknown = await response.json();
        if (!Array.isArray(payload)) {
          return err({
            kind: 'provider-unavailable',
            message: 'Place search returned something that was not a list of places.',
          });
        }

        return ok(toPlaces(payload as NominatimResult[]));
      } catch (error: unknown) {
        // A caller-cancelled search is not a failure the user should hear
        // about; it is a search they already replaced. Reported as unavailable
        // because the caller discards it either way.
        return err({
          kind: 'provider-unavailable',
          message:
            error instanceof Error && error.name === 'AbortError'
              ? 'Place search did not respond in time.'
              : `Could not reach place search: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        clearTimeout(timer);
        searchOptions.signal?.removeEventListener('abort', onCallerAbort);
      }
    },
  };
};

const toPlaces = (results: readonly NominatimResult[]): Place[] => {
  const places: Place[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    const kind = KIND_BY_ADDRESS_TYPE[result.addresstype ?? ''];
    if (kind === undefined) continue;

    const lat = Number(result.lat);
    const lng = Number(result.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const name = result.name ?? firstPart(result.display_name);
    if (name === undefined || name === '') continue;

    // A place with an administrative boundary *and* a centre node comes back
    // twice, at the same name and nearly the same point. One row is enough.
    const key = `${kind}:${name}:${lat.toFixed(2)},${lng.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const bounds = toBounds(result.boundingbox);
    places.push({
      id: String(result.place_id ?? key),
      name,
      context: contextOf(result.display_name, name, result.address?.postcode),
      kind,
      center: { lat, lng },
      ...(bounds === undefined ? {} : { bounds }),
    });

    if (places.length >= DEFAULTS.resultLimit) break;
  }

  return places;
};

/** `["51.33","51.42","-2.41","-2.29"]` — south, north, west, east, as strings. */
const toBounds = (box: readonly string[] | undefined): LatLngBounds | undefined => {
  if (box === undefined || box.length < 4) return undefined;
  const [south, north, west, east] = [box[0], box[1], box[2], box[3]].map(Number);
  if (south === undefined || north === undefined || west === undefined || east === undefined) {
    return undefined;
  }
  if (![south, north, west, east].every(Number.isFinite)) return undefined;
  return { south, north, west, east };
};

const firstPart = (displayName: string | undefined): string | undefined =>
  displayName?.split(',')[0]?.trim();

/**
 * Everything after the name, minus the postcode.
 *
 * `display_name` leads with the place itself and ends with the country, with a
 * postcode often wedged in near the end. Repeating the name beside the name is
 * redundant, and the postcode of an entire city is meaningless — what is left
 * is the county and country, which is exactly what tells two Baths apart. The
 * postcode is removed by comparing against the structured `address.postcode`
 * rather than by pattern, because no pattern separates "BA1 1AP" from a place
 * name without already knowing the country.
 */
const contextOf = (
  displayName: string | undefined,
  name: string,
  postcode: string | undefined,
): string => {
  if (displayName === undefined) return '';
  const parts = displayName.split(',').map((part) => part.trim());
  if (parts[0] === name) parts.shift();
  return parts.filter((part) => part !== '' && part !== postcode).join(', ');
};

type NominatimResult = {
  place_id?: number;
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  addresstype?: string;
  boundingbox?: string[];
  address?: { postcode?: string };
};
