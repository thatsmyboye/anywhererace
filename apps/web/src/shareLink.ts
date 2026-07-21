import { decodeSharedRace } from '@anywhererace/store';
import type { ShareError, SharedRace } from '@anywhererace/store';

/**
 * Turning the URL into a shared race, and back.
 *
 * The whole payload rides in a single query parameter. It is already base64url
 * — the URL-safe alphabet, no padding — so it needs no further escaping, and
 * keeping it in `?r=` rather than the hash means a crawler or a future
 * serverless renderer sees it in the request line without executing any script.
 */

const PARAM = 'r';

export type SharedRaceOpen =
  | { status: 'none' }
  | { status: 'ok'; race: SharedRace }
  | { status: 'error'; error: ShareError };

export const readSharedRaceFromLocation = (): SharedRaceOpen => {
  if (typeof window === 'undefined') return { status: 'none' };
  const payload = new URLSearchParams(window.location.search).get(PARAM);
  if (payload === null || payload === '') return { status: 'none' };

  const decoded = decodeSharedRace(payload);
  return decoded.ok
    ? { status: 'ok', race: decoded.value }
    : { status: 'error', error: decoded.error };
};

export const buildShareUrl = (payload: string): string => {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}?${PARAM}=${payload}`;
};

/**
 * Drop the share parameter from the address bar without a reload. Called once a
 * shared race has been taken into memory, so a later refresh reopens the app
 * rather than re-decoding — and so the user's own runs do not carry a stranger's
 * link around with them.
 */
export const clearShareParam = (): void => {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(PARAM)) return;
  url.searchParams.delete(PARAM);
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
};
