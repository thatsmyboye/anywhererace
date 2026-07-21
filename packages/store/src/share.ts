import type { Track } from '@anywhererace/core';
import { err, ok } from '@anywhererace/core';
import type { Result } from '@anywhererace/core';
import type { RaceConfig } from '@anywhererace/sim';
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';

/**
 * Sharing a race.
 *
 * A race is deterministic, so what travels in a link is its *inputs*, never a
 * recording — the seed and config are the race, and the viewer's own build
 * re-runs it. That is what keeps the payload small enough to fit in a URL and
 * what makes a shared result reproducible rather than a video.
 *
 * The one thing that must be embedded rather than referenced is the track. A
 * saved race stores a track *id* and leans on the local IndexedDB to hold the
 * baked track; the recipient of a link has neither. So the whole baked track
 * rides along. It is deliberately the *baked* track, not just waypoints: CLAUDE
 * is explicit that replay must never re-fetch anything, and re-baking would
 * need the router and the elevation DEM. Pinning the baked nodes is what lets an
 * old link still replay the road layout it was created against, even after OSM
 * has moved on underneath it.
 *
 * Everything here is pure and framework-free, so it is tested in Node and can
 * also run inside a serverless function that renders share cards.
 */

export type SharedRace = {
  /** Bumped when the *wire* shape of a shared race changes. See below. */
  schemaVersion: number;
  /**
   * Semver of the simulation that produced `resultHash`. Load-bearing: on
   * opening a shared race, the viewer's build recomputes the hash and compares
   * it. A mismatch does not refuse the race — it plays, with an honest banner.
   */
  simVersion: string;
  /** The whole baked track. Embedded, not referenced — the viewer has no store. */
  track: Track;
  /** Seed and baked weather included; this alone reproduces the race. */
  config: RaceConfig;
  /** Hash of the finishing order and times when the link was created. */
  resultHash: string;
};

/**
 * The wire schema version.
 *
 * This is not `simVersion`. `simVersion` changing means the *result* may differ
 * and the viewer is told so; `schemaVersion` changing means the *envelope* — the
 * fields in `SharedRace` and how they compress — is different, which is a
 * decode-time concern. A link carrying a schema newer than this build
 * understands cannot be opened, and says so rather than mis-parsing.
 */
export const SHARE_SCHEMA_VERSION = 1;

/**
 * A one-character wire tag ahead of the base64url body, so the decoder can tell
 * a share payload apart from arbitrary text and reject an incompatible wire
 * format before it tries to gunzip garbage. Bumped only if the compression or
 * encoding itself changes, independently of the JSON schema.
 */
const WIRE_PREFIX = 'A';

export type ShareErrorKind =
  | 'malformed' // not a share payload, or corrupted in transit
  | 'unsupported-schema' // a newer link than this build knows how to read
  | 'incomplete'; // decoded, but missing something a race needs

export type ShareError = {
  kind: ShareErrorKind;
  message: string;
};

/**
 * Encode a race into a URL-safe string: JSON, gzipped, then base64url.
 *
 * Gzip earns its place here — a baked track is mostly long runs of smoothly
 * varying numbers, which compress hard — but it does not make every track fit.
 * A large circuit still produces a payload past what a URL can safely carry;
 * `isPayloadUrlSafe` is how a caller decides whether to put it in the link or
 * behind a short link instead.
 */
export const encodeSharedRace = (race: SharedRace): string => {
  const json = JSON.stringify(race, nonFiniteReplacer);
  const compressed = gzipSync(strToU8(json), { level: 9 });
  return WIRE_PREFIX + base64UrlEncode(compressed);
};

export const decodeSharedRace = (payload: string): Result<SharedRace, ShareError> => {
  const trimmed = payload.trim();
  if (!trimmed.startsWith(WIRE_PREFIX)) {
    return err({ kind: 'malformed', message: 'This does not look like a shared race link.' });
  }

  let parsed: unknown;
  try {
    const bytes = base64UrlDecode(trimmed.slice(WIRE_PREFIX.length));
    parsed = JSON.parse(strFromU8(gunzipSync(bytes)), nonFiniteReviver);
  } catch {
    return err({
      kind: 'malformed',
      message: 'This shared race link is corrupted and could not be read.',
    });
  }

  return validate(parsed);
};

/**
 * Roughly how many characters a payload adds to a URL. Callers compare this
 * against a practical ceiling rather than a spec one: the URL standard has no
 * length limit, but proxies, link unfurlers and address bars start truncating
 * somewhere north of a few thousand characters, so a link that fits everywhere
 * is worth more than one that is merely legal.
 */
export const URL_SAFE_PAYLOAD_MAX = 6000;

export const isPayloadUrlSafe = (payload: string): boolean =>
  payload.length <= URL_SAFE_PAYLOAD_MAX;

const validate = (value: unknown): Result<SharedRace, ShareError> => {
  if (typeof value !== 'object' || value === null) {
    return err({ kind: 'malformed', message: 'The shared race was empty.' });
  }
  const race = value as Partial<SharedRace>;

  if (typeof race.schemaVersion !== 'number') {
    return err({ kind: 'malformed', message: 'The shared race has no schema version.' });
  }
  if (race.schemaVersion > SHARE_SCHEMA_VERSION) {
    return err({
      kind: 'unsupported-schema',
      message:
        'This link was created by a newer version of the app than the one you are running. Update and try again.',
    });
  }

  const track = race.track;
  const config = race.config;
  const trackOk =
    typeof track === 'object' &&
    track !== null &&
    Array.isArray((track as Track).nodes) &&
    (track as Track).nodes.length > 0 &&
    Array.isArray((track as Track).polyline);
  const configOk =
    typeof config === 'object' &&
    config !== null &&
    Array.isArray((config as RaceConfig).racers) &&
    typeof (config as RaceConfig).seed === 'string' &&
    typeof (config as RaceConfig).vehicleClassId === 'string';

  if (
    !trackOk ||
    !configOk ||
    typeof race.simVersion !== 'string' ||
    typeof race.resultHash !== 'string'
  ) {
    return err({
      kind: 'incomplete',
      message: 'The shared race is missing information needed to replay it.',
    });
  }

  return ok({
    schemaVersion: race.schemaVersion,
    simVersion: race.simVersion,
    track: track as Track,
    config: config as RaceConfig,
    resultHash: race.resultHash,
  });
};

// --- non-finite numbers -----------------------------------------------------
//
// A baked track stores `curvatureRadius: Infinity` on every straight node, and
// JSON has no way to write it — `JSON.stringify(Infinity)` is `null`. Left
// alone, a decoded straight would come back as `null`, the viewer's re-run
// would corner where the original went straight, and every shared link would
// trip its own hash-mismatch banner. So non-finite numbers travel as sentinel
// strings and are restored on the way out. The sentinels are deliberately
// unlike any real string in the payload.

const INF = '__Infinity__';
const NEG_INF = '__-Infinity__';
const NAN = '__NaN__';

const nonFiniteReplacer = (_key: string, value: unknown): unknown => {
  if (typeof value !== 'number' || Number.isFinite(value)) return value;
  if (value === Infinity) return INF;
  if (value === -Infinity) return NEG_INF;
  return NAN;
};

const nonFiniteReviver = (_key: string, value: unknown): unknown => {
  if (value === INF) return Infinity;
  if (value === NEG_INF) return -Infinity;
  if (value === NAN) return NaN;
  return value;
};

// --- base64url over bytes ---------------------------------------------------
//
// `btoa`/`atob` are the one primitive available in both the browser and Node
// (18+) without a dependency; they work on binary strings, so bytes are packed
// into one first. Chunked so a large track does not blow the argument limit of
// `String.fromCharCode.apply`.

const BINARY_CHUNK = 0x8000;

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BINARY_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BINARY_CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const base64UrlDecode = (text: string): Uint8Array => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
