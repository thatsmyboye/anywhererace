import type { TrackPreview } from '@anywhererace/track';
import { THEME } from '../../palette';

/**
 * The elevation profile.
 *
 * CLAUDE.md asks for this to be prominent, and it is right to: elevation
 * matters far more off-road than on, and for the runner and e-scooter classes
 * the profile *is* the race. A flat-looking loop and a loop with a wall in it
 * are the same length and completely different events.
 *
 * Drawn as an SVG area chart rather than pulling in a charting library — it is
 * one series, it has no interaction, and Recharts is reserved for the results
 * page where the charts genuinely need axes and tooltips.
 */

export type ElevationProfileProps = {
  preview: TrackPreview | undefined;
  loading: boolean;
  height?: number;
};

const WIDTH = 260;
const DEFAULT_HEIGHT = 64;
/** Never draw a profile flatter than this; a 2m ripple should look flat. */
const MIN_RELIEF_M = 20;

export const ElevationProfile = ({
  preview,
  loading,
  height = DEFAULT_HEIGHT,
}: ElevationProfileProps) => {
  const samples = preview?.profile ?? [];

  if (samples.length < 2) {
    return (
      <div
        className="flex items-center justify-center rounded border border-[#2b3543] bg-[#0b0e13] text-[11px] text-[#8d9bb0]"
        style={{ height }}
      >
        {loading ? 'Reading the terrain…' : 'Elevation appears once the route is complete'}
      </div>
    );
  }

  const elevations = samples.map((sample) => sample.elevationM);
  const low = Math.min(...elevations);
  const high = Math.max(...elevations);
  // Padding the range keeps a genuinely flat course from rendering as a jagged
  // mountain range built entirely out of DEM noise.
  const relief = Math.max(high - low, MIN_RELIEF_M);
  const midpoint = (high + low) / 2;
  const top = midpoint + relief / 2;

  const totalM = samples[samples.length - 1]?.distanceM ?? 1;
  const x = (distanceM: number): number => (distanceM / totalM) * WIDTH;
  const y = (elevationM: number): number => ((top - elevationM) / relief) * height;

  const line = samples
    .map((sample, index) => `${index === 0 ? 'M' : 'L'}${x(sample.distanceM).toFixed(1)},${y(sample.elevationM).toFixed(1)}`)
    .join(' ');
  const area = `${line} L${WIDTH},${height} L0,${height} Z`;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        width="100%"
        height={height}
        className="block rounded border border-[#2b3543] bg-[#0b0e13]"
        role="img"
        aria-label={`Elevation profile: ${Math.round(preview?.climbM ?? 0)} meters of climbing over ${(totalM / 1000).toFixed(2)} kilometers`}
      >
        <path d={area} fill={THEME.accent} opacity={0.18} />
        <path d={line} fill="none" stroke={THEME.accent} strokeWidth={1.5} />
      </svg>
      <figcaption className="mt-1 flex justify-between text-[11px] tabular-nums text-[#8d9bb0]">
        <span>
          <span className="text-[#3ddc97]">↑</span> {Math.round(preview?.climbM ?? 0)}m
          <span className="ml-2 text-[#ffb020]">↓</span> {Math.round(preview?.descentM ?? 0)}m
        </span>
        <span>
          {Math.round(low)}–{Math.round(high)}m
        </span>
      </figcaption>
    </figure>
  );
};
