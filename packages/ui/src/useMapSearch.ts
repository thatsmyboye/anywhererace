import { useCallback, useEffect, useRef, useState } from 'react';
import { MIN_QUERY_LENGTH } from '@anywhererace/core';
import type { GeocodingProvider, Place } from '@anywhererace/core';

/**
 * Typing a place name into the builder.
 *
 * Two things make this more than a fetch-on-change. Nominatim's usage policy
 * caps us at one request a second, so keystrokes are debounced rather than sent;
 * and a slow answer to "Lis" must never overwrite a fast answer to "Lisbon", so
 * every in-flight lookup is aborted when the query moves on and any late reply
 * is dropped on arrival as well. The abort is not enough on its own — a request
 * can already be resolving when the next keystroke lands.
 *
 * A failed lookup keeps the previous results on screen rather than blanking the
 * list. The user is mid-word; clearing what they could already see would make
 * an intermittent service look like a broken one.
 */

export type MapSearchState = {
  query: string;
  setQuery: (query: string) => void;
  results: readonly Place[];
  searching: boolean;
  /** Set only when a lookup genuinely failed, never when it was superseded. */
  error: string | undefined;
  /** True once a search has completed and found nothing. */
  empty: boolean;
  clear: () => void;
};

export type UseMapSearchOptions = {
  geocoding: GeocodingProvider;
  /**
   * How long to wait after the last keystroke. 400ms is long enough that
   * ordinary typing produces one request per word rather than one per letter,
   * and short enough not to feel like the box has stopped responding.
   */
  debounceMs?: number;
};

const DEFAULT_DEBOUNCE_MS = 400;

export const useMapSearch = ({
  geocoding,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}: UseMapSearchOptions): MapSearchState => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [empty, setEmpty] = useState(false);

  // Which lookup is current. Compared on arrival so a reply that lost the race
  // is discarded rather than allowed to overwrite a newer one.
  const generation = useRef(0);

  const clear = useCallback(() => {
    generation.current += 1;
    setQuery('');
    setResults([]);
    setSearching(false);
    setError(undefined);
    setEmpty(false);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      // Not an error — the user is still typing the first letter.
      setResults([]);
      setSearching(false);
      setError(undefined);
      setEmpty(false);
      return;
    }

    const mine = ++generation.current;
    const controller = new AbortController();
    setSearching(true);

    const timer = setTimeout(() => {
      void geocoding.search(trimmed, { signal: controller.signal }).then((result) => {
        if (generation.current !== mine) return;
        setSearching(false);
        if (result.ok) {
          setResults(result.value);
          setEmpty(result.value.length === 0);
          setError(undefined);
        } else if (result.error.kind !== 'query-too-short') {
          // Leave `results` alone: whatever is on screen is still the best
          // answer anyone has, and blanking it makes a blip look like a bug.
          setError(result.error.message);
          setEmpty(false);
        }
      });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, geocoding, debounceMs]);

  return { query, setQuery, results, searching, error, empty, clear };
};
