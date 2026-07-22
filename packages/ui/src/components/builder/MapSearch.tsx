import { useEffect, useRef, useState } from 'react';
import type { GeocodingProvider, Place, PlaceKind } from '@anywhererace/core';
import { useMapSearch } from '../../useMapSearch';

/**
 * "Take me to Lisbon."
 *
 * Sits over the map rather than in the side panel, because it is about the map
 * and because the panel is already the densest thing on the screen. It is
 * deliberately coarse — countries, regions, towns, no streets and no landmarks
 * — since the user is about to draw a course by hand and what they need is the
 * right few square kilometers on screen, not a pin on a specific address.
 *
 * Moving the camera is all it does. No waypoint is placed, nothing already
 * drawn is touched, and a track never records the place that was searched for.
 */

export type MapSearchProps = {
  geocoding: GeocodingProvider;
  onSelect: (place: Place) => void;
};

const KIND_LABEL: Record<PlaceKind, string> = {
  country: 'Country',
  region: 'Region',
  city: 'City',
  town: 'Town',
  village: 'Village',
  district: 'District',
};

export const MapSearch = ({ geocoding, onSelect }: MapSearchProps) => {
  const search = useMapSearch({ geocoding });
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // A new set of results invalidates whatever row the keyboard was on.
  useEffect(() => setHighlighted(0), [search.results]);

  // Click anywhere else and the list goes away. Bound on the map container's
  // ancestor rather than the map itself so a click on the canvas closes it too
  // — and, importantly, still places a waypoint. Closing a dropdown should not
  // swallow the gesture that closed it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (rootRef.current?.contains(event.target) === true) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const choose = (place: Place): void => {
    onSelect(place);
    setOpen(false);
    search.clear();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (search.results.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((current) => (current + 1) % search.results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted(
        (current) => (current - 1 + search.results.length) % search.results.length,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const place = search.results[highlighted];
      if (place !== undefined) choose(place);
    }
  };

  const showList = open && (search.results.length > 0 || search.empty || search.error !== undefined);

  return (
    <div ref={rootRef} className="w-72 max-w-[calc(100vw-2rem)]">
      <div className="relative">
        <input
          type="search"
          value={search.query}
          onChange={(event) => {
            search.setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Go to a town or country…"
          aria-label="Search for a place to center the map on"
          role="combobox"
          aria-expanded={showList}
          aria-controls="map-search-results"
          autoComplete="off"
          className="w-full rounded-lg border border-[#2b3543] bg-[#161b24]/95 px-3 py-2 pr-8 text-sm text-[#e6ebf2] shadow-lg outline-none backdrop-blur placeholder:text-[#8d9bb0] focus:border-[#4da3ff]"
        />
        {search.searching ? (
          <span
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-[#8d9bb0]"
            aria-hidden="true"
          >
            …
          </span>
        ) : null}
      </div>

      {showList ? (
        <ul
          id="map-search-results"
          role="listbox"
          className="mt-1 overflow-hidden rounded-lg border border-[#2b3543] bg-[#161b24]/95 shadow-lg backdrop-blur"
        >
          {search.error !== undefined ? (
            <li className="px-3 py-2 text-[11px] leading-snug text-[#ffb020]">{search.error}</li>
          ) : search.results.length === 0 ? (
            <li className="px-3 py-2 text-[11px] leading-snug text-[#8d9bb0]">
              Nothing found. This searches towns, cities, regions and countries — not
              streets or landmarks.
            </li>
          ) : (
            search.results.map((place, index) => (
              <li key={place.id} role="option" aria-selected={index === highlighted}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => choose(place)}
                  className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                    index === highlighted ? 'bg-[#2b3543]' : 'hover:bg-[#1f2632]'
                  }`}
                >
                  <span className="shrink-0 text-[#e6ebf2]">{place.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[#8d9bb0]">
                    {place.context}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-[#4da3ff]">
                    {KIND_LABEL[place.kind]}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
};
