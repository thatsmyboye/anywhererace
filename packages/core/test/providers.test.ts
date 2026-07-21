import { describe, expect, it, vi } from 'vitest';
import { decodePolyline, encodePolyline } from '../src/providers/polyline';
import { createValhallaProvider } from '../src/providers/valhalla';
import { createOpenTopoDataProvider } from '../src/providers/opentopodata';
import { withElevationFallback, withRoutingFallback, withWeatherFallback } from '../src/providers/fallback';
import { createOpenMeteoProvider } from '../src/providers/openmeteo';
import { createMockElevationProvider, createMockRoutingProvider, createMockWeatherProvider } from '../src/index';
import { haversineMeters } from '../src/geo';
import type { LatLng } from '../src/types/track';
import type { RouteLeg, RoutingError, RoutingProvider } from '../src/providers/routing';
import type { ElevationProvider } from '../src/providers/elevation';
import type { WeatherProvider } from '../src/providers/weather';
import { err, ok } from '../src/result';

/**
 * Adapter tests. Every one of these stubs `fetch` — nothing here touches the
 * network, which is what lets the suite run offline and stay fast.
 */

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

const LONDON: LatLng = { lat: 51.5074, lng: -0.1278 };

describe('encoded polylines', () => {
  it('round-trips at precision 6', () => {
    const points: LatLng[] = [
      { lat: 51.507_4, lng: -0.127_8 },
      { lat: 51.508_1, lng: -0.126_2 },
      { lat: 51.509_9, lng: -0.124_0 },
    ];
    const decoded = decodePolyline(encodePolyline(points, 6), 6);

    expect(decoded).toHaveLength(points.length);
    for (let i = 0; i < points.length; i++) {
      expect(decoded[i]?.lat).toBeCloseTo(points[i]?.lat ?? 0, 6);
      expect(decoded[i]?.lng).toBeCloseTo(points[i]?.lng ?? 0, 6);
    }
  });

  it('decodes the canonical precision-5 example', () => {
    // The example from Google's own specification.
    const decoded = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
    expect(decoded).toHaveLength(3);
    expect(decoded[0]?.lat).toBeCloseTo(38.5, 5);
    expect(decoded[0]?.lng).toBeCloseTo(-120.2, 5);
    expect(decoded[2]?.lat).toBeCloseTo(43.252, 5);
    expect(decoded[2]?.lng).toBeCloseTo(-126.453, 5);
  });

  it('treats precision as load-bearing', () => {
    // Decoding precision-6 data as precision-5 does not fail, it silently puts
    // the track ten degrees away. This is why precision is always explicit.
    const encoded = encodePolyline([LONDON], 6);
    const wrong = decodePolyline(encoded, 5)[0];
    expect(Math.abs((wrong?.lat ?? 0) - LONDON.lat)).toBeGreaterThan(100);
  });

  it('returns nothing for an empty string', () => {
    expect(decodePolyline('', 6)).toEqual([]);
  });
});

describe('Valhalla routing provider', () => {
  const shape = encodePolyline(
    [
      { lat: 51.5074, lng: -0.1278 },
      { lat: 51.5078, lng: -0.1262 },
      { lat: 51.5082, lng: -0.1240 },
      { lat: 51.5070, lng: -0.1230 },
    ],
    6,
  );

  const routeBody = { trip: { legs: [{ shape, maneuvers: [] }] } };

  it('decodes geometry and measures the leg', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody));
    const provider = createValhallaProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provider.routeLeg({
      from: LONDON,
      to: { lat: 51.507, lng: -0.123 },
      profile: 'motor',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.polyline).toHaveLength(4);
    expect(result.value.lengthMeters).toBeGreaterThan(0);
    expect(result.value.annotations.length).toBeGreaterThan(0);
  });

  it('sends the right costing for each profile', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody));
    const provider = createValhallaProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    for (const [profile, costing] of [
      ['motor', 'auto'],
      ['bicycle', 'bicycle'],
      ['pedestrian', 'pedestrian'],
    ] as const) {
      await provider.routeLeg({ from: LONDON, to: LONDON, profile });
      const body = JSON.parse(fetchImpl.mock.lastCall?.[1]?.body as string) as { costing: string };
      expect(body.costing).toBe(costing);
    }
  });

  it('does not ask for surface detail unless the caller wants it', async () => {
    // A second request per leg on every drag is how you lose access to a free
    // public service.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(routeBody));
    const provider = createValhallaProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await provider.routeLeg({ from: LONDON, to: LONDON, profile: 'motor' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    fetchImpl.mockClear();
    fetchImpl.mockResolvedValue(jsonResponse({ edges: [] }));
    fetchImpl.mockResolvedValueOnce(jsonResponse(routeBody));
    await provider.routeLeg({ from: LONDON, to: LONDON, profile: 'motor', detail: 'full' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.lastCall?.[0])).toContain('/trace_attributes');
  });

  it('maps per-edge surface onto the vocabulary when detail is requested', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(routeBody))
      .mockResolvedValueOnce(
        jsonResponse({
          edges: [
            { surface: 'gravel', road_class: 'service', begin_shape_index: 0, end_shape_index: 2 },
            { surface: 'paved', road_class: 'residential', begin_shape_index: 2, end_shape_index: 3 },
          ],
        }),
      );
    const provider = createValhallaProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provider.routeLeg({
      from: LONDON,
      to: LONDON,
      profile: 'motor',
      detail: 'full',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.annotations[0]?.surface).toBe('gravel');
    expect(result.value.annotations[0]?.surfaceConfidence).toBe('tagged');
    expect(result.value.annotations[1]?.surface).toBe('asphalt');
  });

  it('keeps the route when surface enrichment fails', async () => {
    // Losing the second request should cost detail, never the whole track.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(routeBody))
      .mockResolvedValueOnce(jsonResponse({}, 500));
    const provider = createValhallaProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provider.routeLeg({
      from: LONDON,
      to: LONDON,
      profile: 'motor',
      detail: 'full',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.polyline).toHaveLength(4);
  });

  it('reports an unroutable leg as no-route, not as an outage', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'No path could be found', error_code: 442 }, 400));
    const provider = createValhallaProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provider.routeLeg({ from: LONDON, to: LONDON, profile: 'motor' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no-route');
  });

  it('distinguishes a rate limit from a routing failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 429));
    const provider = createValhallaProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provider.routeLeg({ from: LONDON, to: LONDON, profile: 'motor' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('provider-unavailable');
  });

  it('turns a network failure into an error result rather than throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const provider = createValhallaProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provider.routeLeg({ from: LONDON, to: LONDON, profile: 'motor' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('provider-unavailable');
  });

  it('flags a hard turn as a junction even when Valhalla does not', async () => {
    // A right angle between two straights can have a perfectly reasonable
    // fitted radius while still requiring you to nearly stop.
    const cornerShape = encodePolyline(
      [
        { lat: 51.5074, lng: -0.128 },
        { lat: 51.5074, lng: -0.126 },
        { lat: 51.5094, lng: -0.126 },
      ],
      6,
    );
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ trip: { legs: [{ shape: cornerShape, maneuvers: [] }] } }),
    );
    const provider = createValhallaProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provider.routeLeg({ from: LONDON, to: LONDON, profile: 'motor' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.junctions).toHaveLength(1);
    expect(Math.abs(result.value.junctions[0]?.turnAngleDeg ?? 0)).toBeGreaterThan(80);
  });
});

describe('Open-Topo-Data elevation provider', () => {
  it('returns one elevation per point', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ results: [{ elevation: 12.5 }, { elevation: 18.25 }] }),
    );
    const provider = createOpenTopoDataProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provider.lookup([LONDON, { lat: 51.51, lng: -0.12 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([12.5, 18.25]);
  });

  it('reads a null elevation as sea level rather than failing', async () => {
    // Null means "outside this dataset's coverage" — over water, or beyond
    // SRTM's latitude range.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ results: [{ elevation: null }, { elevation: 3 }] }));
    const provider = createOpenTopoDataProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provider.lookup([LONDON, LONDON]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([0, 3]);
  });

  it('refuses a batch larger than the service allows', async () => {
    const fetchImpl = vi.fn();
    const provider = createOpenTopoDataProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provider.lookup(new Array<LatLng>(101).fill(LONDON));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('rate-limited');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a mismatched number of samples instead of misaligning the track', async () => {
    // Silently short elevations would shift every gradient down the route.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [{ elevation: 1 }] }));
    const provider = createOpenTopoDataProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provider.lookup([LONDON, LONDON]);
    expect(result.ok).toBe(false);
  });

  it('returns immediately for an empty request', async () => {
    const fetchImpl = vi.fn();
    const provider = createOpenTopoDataProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await provider.lookup([]);
    expect(result.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('provider fallback', () => {
  const failing = (error: RoutingError): RoutingProvider => ({
    id: 'failing',
    routeLeg: async () => err(error),
  });

  const request = { from: LONDON, to: { lat: 51.51, lng: -0.12 }, profile: 'motor' as const };

  it('falls back when the primary is unreachable', async () => {
    const provider = withRoutingFallback(
      failing({ kind: 'provider-unavailable', message: 'down' }),
      createMockRoutingProvider({ seed: 'fallback' }),
    );

    const result = await provider.routeLeg(request);
    expect(result.ok).toBe(true);
  });

  it('passes a genuine no-route straight through', async () => {
    // This is the important one. Inventing a road that does not exist is far
    // worse than telling the user the leg cannot be routed.
    const provider = withRoutingFallback(
      failing({ kind: 'no-route', message: 'one-way' }),
      createMockRoutingProvider({ seed: 'fallback' }),
    );

    const result = await provider.routeLeg(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no-route');
  });

  it('does not retry a downed primary on every leg', async () => {
    let calls = 0;
    const primary: RoutingProvider = {
      id: 'flaky',
      routeLeg: async () => {
        calls += 1;
        return err({ kind: 'provider-unavailable' as const, message: 'down' });
      },
    };

    let now = 0;
    const provider = withRoutingFallback(primary, createMockRoutingProvider({ seed: 'f' }), {
      retryAfterMs: 60_000,
      now: () => now,
    });

    for (let i = 0; i < 5; i++) await provider.routeLeg(request);
    expect(calls).toBe(1);

    // ...but it does try again once the cool-off has passed.
    now = 61_000;
    await provider.routeLeg(request);
    expect(calls).toBe(2);
  });

  it('recovers when the primary comes back', async () => {
    let healthy = false;
    const primary: RoutingProvider = {
      id: 'recovering',
      routeLeg: async () =>
        healthy
          ? ok({ polyline: [LONDON, LONDON], lengthMeters: 0, annotations: [], junctions: [] } as RouteLeg)
          : err({ kind: 'provider-unavailable' as const, message: 'down' }),
    };

    const degradedEvents: boolean[] = [];
    let now = 0;
    const provider = withRoutingFallback(primary, createMockRoutingProvider({ seed: 'f' }), {
      retryAfterMs: 1000,
      now: () => now,
      onDegraded: (degraded) => degradedEvents.push(degraded),
    });

    await provider.routeLeg(request);
    healthy = true;
    now = 2000;
    await provider.routeLeg(request);

    expect(degradedEvents).toEqual([true, false]);
  });

  it('survives a provider that throws instead of returning an error', async () => {
    const throwing: RoutingProvider = {
      id: 'throwing',
      routeLeg: async () => {
        throw new Error('kaboom');
      },
    };
    const provider = withRoutingFallback(throwing, createMockRoutingProvider({ seed: 'f' }));
    const result = await provider.routeLeg(request);
    expect(result.ok).toBe(true);
  });

  it('falls back for elevation too, and keeps the stricter batch size', async () => {
    const failingDem: ElevationProvider = {
      id: 'failing-dem',
      maxBatchSize: 100,
      lookup: async () => err({ kind: 'provider-unavailable' as const, message: 'down' }),
    };
    const provider = withElevationFallback(
      failingDem,
      createMockElevationProvider({ seed: 'dem' }),
    );

    expect(provider.maxBatchSize).toBe(100);
    const result = await provider.lookup([LONDON, LONDON]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
  });

  it('produces a usable route through the fallback, not an empty one', async () => {
    const provider = withRoutingFallback(
      failing({ kind: 'provider-unavailable', message: 'down' }),
      createMockRoutingProvider({ seed: 'fallback' }),
    );
    const result = await provider.routeLeg(request);
    if (!result.ok) throw new Error('expected a route');

    const first = result.value.polyline[0] as LatLng;
    const last = result.value.polyline[result.value.polyline.length - 1] as LatLng;
    expect(haversineMeters(first, request.from)).toBeLessThan(1);
    expect(haversineMeters(last, request.to)).toBeLessThan(1);
  });
});

describe('Open-Meteo weather provider', () => {
  const HOUR = 3600;
  const START_MS = Date.parse('2026-07-21T12:00:00Z');

  /** Hourly rows around the race, as Open-Meteo returns them. */
  const hourlyBody = (hours: number[]) => ({
    hourly: {
      time: hours.map((h) => START_MS / 1000 + h * HOUR),
      temperature_2m: hours.map((h) => 15 + h),
      precipitation: hours.map((h) => (h >= 1 ? 2.5 : 0)),
      wind_speed_10m: hours.map(() => 6),
      wind_direction_10m: hours.map(() => 225),
      cloud_cover: hours.map(() => 80),
      relative_humidity_2m: hours.map(() => 70),
    },
  });

  const provider = (fetchImpl: unknown, now = START_MS) =>
    createOpenMeteoProvider({
      fetchImpl: fetchImpl as typeof fetch,
      now: () => now,
    });

  const request = {
    at: LONDON,
    startsAt: '2026-07-21T12:00:00Z',
    durationS: 2 * HOUR,
  };

  it('converts hourly rows into race-relative samples', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(hourlyBody([-1, 0, 1, 2, 3])));
    const result = await provider(fetchImpl).forecast(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.value.find((sample) => sample.atOffsetS === 0);
    expect(first?.conditions.temperatureC).toBe(15);
    expect(first?.conditions.windSpeedMs).toBe(6);
    // Percentages become fractions.
    expect(first?.conditions.cloudCoverFraction).toBeCloseTo(0.8, 6);
    expect(first?.conditions.humidityFraction).toBeCloseTo(0.7, 6);
  });

  it('keeps the hours bracketing the race, not only those inside it', async () => {
    // `conditionsAt` interpolates, so it needs a sample either side of the race
    // or it has to extrapolate.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(hourlyBody([-2, -1, 0, 1, 2, 3, 4])));
    const result = await provider(fetchImpl).forecast(request);
    if (!result.ok) throw new Error('expected samples');

    const offsets = result.value.map((sample) => sample.atOffsetS);
    expect(Math.min(...offsets)).toBeLessThanOrEqual(0);
    expect(Math.max(...offsets)).toBeGreaterThanOrEqual(request.durationS);
  });

  it('returns samples in ascending time order', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(hourlyBody([2, 0, 1, -1, 3])));
    const result = await provider(fetchImpl).forecast(request);
    if (!result.ok) throw new Error('expected samples');

    const offsets = result.value.map((sample) => sample.atOffsetS);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it('asks for metres per second and unix timestamps', async () => {
    // Anything else means parsing dates and converting km/h at the boundary,
    // which is exactly where unit bugs live.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(hourlyBody([0, 1, 2])));
    await provider(fetchImpl).forecast(request);

    const url = String(fetchImpl.mock.lastCall?.[0]);
    expect(url).toContain('wind_speed_unit=ms');
    expect(url).toContain('timeformat=unixtime');
    expect(url).toContain('wind_direction_10m');
  });

  it('refuses a start beyond the forecast horizon rather than inventing weather', async () => {
    const fetchImpl = vi.fn();
    const result = await createOpenMeteoProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => START_MS,
    }).forecast({ ...request, startsAt: '2027-01-01T12:00:00Z' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('beyond-forecast-horizon');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks for past days when the start is in the recent past', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(hourlyBody([0, 1, 2])));
    await provider(fetchImpl, START_MS + 6 * HOUR * 1000).forecast(request);
    expect(String(fetchImpl.mock.lastCall?.[0])).toContain('past_days=');
  });

  it('rejects an unparseable start time', async () => {
    const fetchImpl = vi.fn();
    const result = await provider(fetchImpl).forecast({ ...request, startsAt: 'not a date' });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a rate limit distinctly from an outage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 429));
    const result = await provider(fetchImpl).forecast(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('rate-limited');
  });

  it('turns a network failure into an error result rather than throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const result = await provider(fetchImpl).forecast(request);
    expect(result.ok).toBe(false);
  });
});

describe('weather fallback', () => {
  const request = {
    at: LONDON,
    startsAt: '2026-07-21T12:00:00Z',
    durationS: 3600,
  };

  it('falls back when the service is down', async () => {
    const failing: WeatherProvider = {
      id: 'failing',
      forecast: async () => err({ kind: 'provider-unavailable' as const, message: 'down' }),
    };
    const provider = withWeatherFallback(failing, createMockWeatherProvider({}));
    const result = await provider.forecast(request);
    expect(result.ok).toBe(true);
  });

  it('passes a beyond-horizon answer straight through', async () => {
    // That is a true statement about the world, not an outage. Inventing
    // weather for a date nobody can forecast would be worse than saying so.
    const failing: WeatherProvider = {
      id: 'failing',
      forecast: async () => err({ kind: 'beyond-forecast-horizon' as const, message: 'too far' }),
    };
    const provider = withWeatherFallback(failing, createMockWeatherProvider({}));
    const result = await provider.forecast(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('beyond-forecast-horizon');
  });
});
