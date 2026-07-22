import type { Track } from '@anywhererace/core';
import { runRace } from '@anywhererace/sim';
import type { RaceConfig } from '@anywhererace/sim';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SHARE_SCHEMA_VERSION,
  decodeSharedRace,
  encodeSharedRace,
  isPayloadUrlSafe,
} from '../src/share';
import type { SharedRace } from '../src/share';
import { makeConfig, makeSyntheticTrack } from '../../sim/test/fixtures';

/**
 * Codec tests. A shared race is inputs, not a recording, so the contract these
 * pin down is: encode→decode is lossless, the same race always encodes to the
 * same string (a link has to be stable), and anything that is not a genuine,
 * readable, current-schema payload is refused with a reason rather than
 * half-parsed.
 */

afterEach(() => {
  vi.useRealTimers();
});

const makeSharedRace = (
  trackOverrides: Partial<Track> = {},
  configOverrides: Partial<RaceConfig> = {},
): SharedRace => {
  const track: Track = { ...makeSyntheticTrack({ lengthM: 2000, mode: 'circuit' }), ...trackOverrides };
  const config = makeConfig({ trackId: track.id, laps: 2, ...configOverrides });
  const run = runRace({ track, config });
  if (!run.ok) throw new Error(`fixture race failed: ${run.error.message}`);
  return {
    schemaVersion: SHARE_SCHEMA_VERSION,
    simVersion: run.value.simVersion,
    track,
    config,
    resultHash: run.value.resultHash,
  };
};

describe('shared race codec', () => {
  it('round-trips a race without loss', () => {
    const race = makeSharedRace();
    const decoded = decodeSharedRace(encodeSharedRace(race));

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toEqual(race);
  });

  it('embeds the baked track, since the recipient has no store', () => {
    // The whole reason a track rides along instead of a track id: the viewer
    // cannot look it up, and must not re-bake it.
    const race = makeSharedRace();
    const decoded = decodeSharedRace(encodeSharedRace(race));
    if (!decoded.ok) throw new Error('expected a decode');

    expect(decoded.value.track.nodes.length).toBe(race.track.nodes.length);
    expect(decoded.value.track.nodes[0]?.curvatureRadius).toBe(race.track.nodes[0]?.curvatureRadius);
  });

  it('is deterministic: the same race always yields the same link', () => {
    const race = makeSharedRace();
    expect(encodeSharedRace(race)).toBe(encodeSharedRace(race));
  });

  it('yields the same link tomorrow as it does today', () => {
    // gzip carries a modification time in its header, and a compressor left to
    // fill it from the clock makes the same race encode differently depending
    // on when you asked. This used to fail roughly whenever a test run happened
    // to straddle a second boundary, which is the worst way to find out.
    const race = makeSharedRace();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const today = encodeSharedRace(race);
    vi.setSystemTime(new Date('2026-01-02T12:34:56Z'));
    expect(encodeSharedRace(race)).toBe(today);
  });

  it('fits a short track inline in a URL', () => {
    const payload = encodeSharedRace(makeSharedRace({ ...makeSyntheticTrack({ lengthM: 500, mode: 'circuit' }) }));
    expect(isPayloadUrlSafe(payload)).toBe(true);
  });

  it('flags a big track as needing the short-link fallback', () => {
    // A baked track is hundreds of nodes; most real courses will not fit in a
    // link and must go behind a short link instead. The point of the check is
    // that the caller is told which case it is, not that everything fits.
    const payload = encodeSharedRace(makeSharedRace({ ...makeSyntheticTrack({ lengthM: 5000, mode: 'circuit' }) }));
    expect(isPayloadUrlSafe(payload)).toBe(false);
  });

  it('rejects text that is not a share link', () => {
    for (const junk of ['', 'hello', 'https://example.com/race']) {
      const decoded = decodeSharedRace(junk);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) continue;
      expect(decoded.error.kind).toBe('malformed');
    }
  });

  it('rejects a payload that carries the tag but corrupted bytes', () => {
    const decoded = decodeSharedRace('A@@@not-valid-base64-or-gzip@@@');
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.kind).toBe('malformed');
  });

  it('refuses a link from a newer schema rather than mis-parsing it', () => {
    const future = { ...makeSharedRace(), schemaVersion: SHARE_SCHEMA_VERSION + 1 };
    const decoded = decodeSharedRace(encodeSharedRace(future));

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.kind).toBe('unsupported-schema');
  });

  it('reports an incomplete race when a required field is missing', () => {
    const race = makeSharedRace();
    const { config: _dropped, ...withoutConfig } = race;
    const decoded = decodeSharedRace(encodeSharedRace(withoutConfig as SharedRace));

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.kind).toBe('incomplete');
  });

  it('re-runs to the identical hash after a round trip', () => {
    // The mismatch banner's whole premise: on the same build, replaying a
    // decoded link reproduces the exact result. If the track lost its Infinity
    // curvatures, or any field drifted through the codec, this hash would move
    // and every honest share would falsely accuse itself of a version mismatch.
    const race = makeSharedRace();
    const decoded = decodeSharedRace(encodeSharedRace(race));
    if (!decoded.ok) throw new Error('expected a decode');

    const rerun = runRace({ track: decoded.value.track, config: decoded.value.config });
    if (!rerun.ok) throw new Error(`replay failed: ${rerun.error.message}`);
    expect(rerun.value.resultHash).toBe(race.resultHash);
  });

  it('preserves the simVersion so the viewer can flag a mismatch', () => {
    // The mismatch banner leans on this surviving the trip untouched.
    const race = { ...makeSharedRace(), simVersion: '9.9.9' };
    const decoded = decodeSharedRace(encodeSharedRace(race));
    if (!decoded.ok) throw new Error('expected a decode');
    expect(decoded.value.simVersion).toBe('9.9.9');
  });
});
