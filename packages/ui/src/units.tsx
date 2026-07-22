import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { UnitSystem } from '@anywhererace/core';
import {
  formatDistanceM,
  formatRainMmPerHour,
  formatShortDistanceM,
  formatSpanM,
  formatSpeedMs,
  formatTemperatureC,
  formatWindSpeedMs,
} from '@anywhererace/core';

/**
 * Which units the reader sees.
 *
 * This is the whole extent of the feature: everything stored, simulated and
 * baked stays SI, and the choice is applied at the last possible moment, in the
 * component that prints the number. Nothing upstream of a render ever asks what
 * system is in force — which is what keeps a race shared by a reader in miles
 * identical to the same race opened by a reader in kilometers.
 *
 * The formatters arrive pre-bound rather than as `(value, system)` pairs so a
 * call site reads `units.distance(track.lengthMeters)` and cannot forget to
 * thread the system through.
 */

export type Units = {
  system: UnitSystem;
  setSystem: (system: UnitSystem) => void;
  /** Course length, race distance, position along the route. Always km/mi. */
  distance: (meters: number, decimals?: number) => string;
  /** Corner radius, road width, climbing, a gap on the grid. Always m/ft. */
  shortDistance: (meters: number, decimals?: number) => string;
  /** Picks its own scale. For values that could be either. */
  span: (meters: number) => string;
  speed: (speedMs: number) => string;
  windSpeed: (speedMs: number) => string;
  temperature: (celsius: number) => string;
  rain: (mmPerHour: number) => string;
};

const STORAGE_KEY = 'anywhererace.units';

/**
 * The three countries where imperial is the everyday system. Everywhere else
 * gets metric, which is also what the sport itself speaks — a race is a
 * hundred-kilometer race even to a reader who thinks in miles.
 */
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);

const UnitsContext = createContext<Units | undefined>(undefined);

/**
 * Outside a provider this falls back to metric rather than throwing. Every
 * component here is exported individually and several are rendered on their own
 * in tests and in isolation; making each of them require a provider would be a
 * lot of ceremony to protect a default that is already the right one.
 */
export const useUnits = (): Units => useContext(UnitsContext) ?? FALLBACK;

export const UnitsProvider = ({
  children,
  initialSystem,
}: {
  children: ReactNode;
  /** Overrides both the stored choice and the locale guess. For tests. */
  initialSystem?: UnitSystem;
}) => {
  // Read synchronously in the initializer: resolving this in an effect would
  // render every number in the wrong units for one frame first.
  const [system, setSystemState] = useState<UnitSystem>(
    () => initialSystem ?? readStoredSystem() ?? guessSystemFromLocale(),
  );

  const setSystem = useCallback((next: UnitSystem) => {
    setSystemState(next);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      // Private browsing, a full quota, storage disabled entirely. The toggle
      // still works for this session; only the memory of it is lost.
    }
  }, []);

  const value = useMemo(() => bind(system, setSystem), [system, setSystem]);

  return <UnitsContext.Provider value={value}>{children}</UnitsContext.Provider>;
};

/**
 * The toggle itself. Labelled with the distance unit rather than "metric" and
 * "imperial" because that is the part a reader is actually choosing between,
 * and it is two characters instead of nine.
 */
export const UnitToggle = ({ className = '' }: { className?: string }) => {
  const { system, setSystem } = useUnits();

  return (
    <div
      className={`flex overflow-hidden rounded border border-[#2b3543] ${className}`}
      role="group"
      aria-label="Measurement units"
    >
      {(['metric', 'imperial'] as UnitSystem[]).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => setSystem(option)}
          aria-pressed={system === option}
          title={option === 'metric' ? 'Kilometers and °C' : 'Miles and °F'}
          className={[
            'px-2 py-1 text-[11px] font-medium transition-colors',
            system === option
              ? 'bg-[#4da3ff] text-[#0b0e13]'
              : 'bg-[#1f2632] text-[#8d9bb0] hover:bg-[#2b3543] hover:text-[#e6ebf2]',
          ].join(' ')}
        >
          {option === 'metric' ? 'km' : 'mi'}
        </button>
      ))}
    </div>
  );
};

const bind = (system: UnitSystem, setSystem: (system: UnitSystem) => void): Units => ({
  system,
  setSystem,
  distance: (meters, decimals) => formatDistanceM(meters, system, decimals),
  shortDistance: (meters, decimals) => formatShortDistanceM(meters, system, decimals),
  span: (meters) => formatSpanM(meters, system),
  speed: (speedMs) => formatSpeedMs(speedMs, system),
  windSpeed: (speedMs) => formatWindSpeedMs(speedMs, system),
  temperature: (celsius) => formatTemperatureC(celsius, system),
  rain: (mmPerHour) => formatRainMmPerHour(mmPerHour, system),
});

const FALLBACK: Units = bind('metric', () => undefined);

const readStoredSystem = (): UnitSystem | undefined => {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return stored === 'metric' || stored === 'imperial' ? stored : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Read the region out of the browser's locale. `en-US` gives `US`; a bare `en`
 * gives nothing, which is the honest answer — English is not a country — and
 * falls through to metric.
 */
export const guessSystemFromLocale = (
  locale: string | undefined = globalThis.navigator?.language,
): UnitSystem => {
  const region = locale?.split('-')[1]?.toUpperCase();
  return region !== undefined && IMPERIAL_REGIONS.has(region) ? 'imperial' : 'metric';
};
