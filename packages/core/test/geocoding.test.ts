import { describe, expect, it, vi } from 'vitest';
import { createMockGeocodingProvider } from '../src/providers/mock/geocoding';
import { createNominatimProvider } from '../src/providers/nominatim';

/**
 * Nothing here touches the network. The Nominatim provider takes a `fetchImpl`,
 * and every case below hands it a canned response — including the ones that
 * matter most, which are the responses we want thrown away.
 */

const respondWith = (body: unknown, status = 200): typeof fetch =>
  vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;

const result = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  place_id: 1,
  lat: '51.3811',
  lon: '-2.3590',
  name: 'Bath',
  display_name: 'Bath, Somerset, England, BA1 1AP, United Kingdom',
  addresstype: 'town',
  boundingbox: ['51.34', '51.42', '-2.42', '-2.30'],
  address: { postcode: 'BA1 1AP' },
  ...over,
});

describe('the Nominatim place search', () => {
  it('turns a result into a place with its extent', async () => {
    const provider = createNominatimProvider({ fetchImpl: respondWith([result()]) });
    const found = await provider.search('bath');

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).toHaveLength(1);
    const place = found.value[0];
    expect(place?.name).toBe('Bath');
    expect(place?.kind).toBe('town');
    expect(place?.center).toEqual({ lat: 51.3811, lng: -2.359 });
    expect(place?.bounds).toEqual({ south: 51.34, north: 51.42, west: -2.42, east: -2.3 });
  });

  it('drops the name and the postcode from the context line', async () => {
    // The name is already shown beside it and a whole city's postcode means
    // nothing, but the county and country are what tell two Baths apart.
    const provider = createNominatimProvider({ fetchImpl: respondWith([result()]) });
    const found = await provider.search('bath');
    expect(found.ok && found.value[0]?.context).toBe('Somerset, England, United Kingdom');
  });

  it('keeps a place name that happens to look like a postcode', async () => {
    // The postcode is matched by value, not by shape, so a numeric district
    // name survives where a regex would have deleted it.
    const provider = createNominatimProvider({
      fetchImpl: respondWith([
        result({
          name: 'Nashi',
          display_name: 'Nashi, 1000, Sofia, Bulgaria',
          address: { postcode: undefined },
        }),
      ]),
    });
    const found = await provider.search('nashi');
    expect(found.ok && found.value[0]?.context).toBe('1000, Sofia, Bulgaria');
  });

  it('throws away streets, house numbers and landmarks', async () => {
    // This is the requirement: a place search that also returns roads would
    // bury the town the user is looking for under every street named after it.
    const provider = createNominatimProvider({
      fetchImpl: respondWith([
        result({ place_id: 2, addresstype: 'road', name: 'Bath Road' }),
        result({ place_id: 3, addresstype: 'house_number', name: '12' }),
        result({ place_id: 4, addresstype: 'peak', name: 'Bath Hill' }),
        result({ place_id: 5, addresstype: 'amenity', name: 'Bath Cafe' }),
        result(),
      ]),
    });
    const found = await provider.search('bath');

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.map((place) => place.name)).toEqual(['Bath']);
  });

  it('keeps countries, regions, towns and districts', async () => {
    const kinds = [
      ['country', 'country'],
      ['state', 'region'],
      ['county', 'region'],
      ['city', 'city'],
      ['town', 'town'],
      ['village', 'village'],
      ['suburb', 'district'],
    ] as const;

    for (const [addresstype, kind] of kinds) {
      const provider = createNominatimProvider({
        fetchImpl: respondWith([result({ addresstype })]),
      });
      const found = await provider.search('somewhere');
      expect(found.ok && found.value[0]?.kind).toBe(kind);
    }
  });

  it('collapses the boundary and the centre node of the same place', async () => {
    // OSM carries a city as both a relation and a place node; Nominatim
    // returns both, and two identical rows is not a choice worth offering.
    const provider = createNominatimProvider({
      fetchImpl: respondWith([
        result({ place_id: 10, lat: '51.3811', lon: '-2.3590' }),
        result({ place_id: 11, lat: '51.3813', lon: '-2.3592' }),
      ]),
    });
    const found = await provider.search('bath');
    expect(found.ok && found.value).toHaveLength(1);
  });

  it('survives a place with no bounding box', async () => {
    const provider = createNominatimProvider({
      fetchImpl: respondWith([result({ boundingbox: undefined })]),
    });
    const found = await provider.search('bath');
    expect(found.ok && found.value[0]?.bounds).toBeUndefined();
  });

  it('refuses a query too short to be worth sending', async () => {
    const fetchImpl = respondWith([]);
    const provider = createNominatimProvider({ fetchImpl });
    const found = await provider.search('b');

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error.kind).toBe('query-too-short');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports rate limiting as itself', async () => {
    const provider = createNominatimProvider({ fetchImpl: respondWith([], 429) });
    const found = await provider.search('bath');
    expect(!found.ok && found.error.kind).toBe('rate-limited');
  });

  it('reports an outage rather than inventing a place', async () => {
    const provider = createNominatimProvider({
      fetchImpl: vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    });
    const found = await provider.search('bath');
    expect(!found.ok && found.error.kind).toBe('provider-unavailable');
  });

  it('does not choke on a response that is not a list', async () => {
    const provider = createNominatimProvider({ fetchImpl: respondWith({ error: 'nope' }) });
    const found = await provider.search('bath');
    expect(!found.ok && found.error.kind).toBe('provider-unavailable');
  });
});

describe('the mock gazetteer', () => {
  it('finds a place by prefix', async () => {
    const found = await createMockGeocodingProvider().search('lis');
    expect(found.ok && found.value.map((place) => place.name)).toEqual(['Lisbon']);
  });

  it('returns both places of the same name, which is why a list exists', async () => {
    const found = await createMockGeocodingProvider().search('springfield');
    expect(found.ok && found.value).toHaveLength(2);
    expect(found.ok && found.value.map((place) => place.context)).toEqual([
      'Illinois, United States',
      'Massachusetts, United States',
    ]);
  });

  it('can be made to fail, for the unavailable path', async () => {
    const provider = createMockGeocodingProvider({
      failWith: { kind: 'provider-unavailable', message: 'nope' },
    });
    const found = await provider.search('lisbon');
    expect(found.ok).toBe(false);
  });
});
