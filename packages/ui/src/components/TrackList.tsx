import type { TrackSummary } from '@anywhererace/store';

/**
 * Saved tracks.
 *
 * The `degraded` badge is the one non-obvious thing here. A track built while
 * the router had fallen back to synthetic geometry is not the same artefact as
 * one built against real OSM data — it will race perfectly well, but it is not
 * a real place, and quietly presenting the two as equivalent would be a small
 * lie that gets expensive later.
 */

export type TrackListProps = {
  tracks: readonly TrackSummary[];
  loading: boolean;
  error?: string | undefined;
  onCreate: () => void;
  onRace: (id: string) => void;
  onDelete: (id: string) => void;
};

export const TrackList = ({
  tracks,
  loading,
  error,
  onCreate,
  onRace,
  onDelete,
}: TrackListProps) => (
  <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 overflow-y-auto p-8 text-[#e6ebf2]">
    <header className="flex items-baseline justify-between">
      <div>
        <h1 className="text-xl font-semibold">AnywhereRace</h1>
        <p className="text-sm text-[#8d9bb0]">Draw a track on a real map, then watch it race.</p>
      </div>
      <button
        type="button"
        onClick={onCreate}
        className="rounded bg-[#4da3ff] px-3 py-2 text-sm font-semibold text-[#0b0e13] transition-colors hover:bg-[#6fb5ff]"
      >
        New track
      </button>
    </header>

    {error === undefined ? null : (
      <p className="rounded border border-[#ff5c5c]/40 bg-[#ff5c5c]/10 px-3 py-2 text-sm text-[#ff5c5c]">
        {error}
      </p>
    )}

    {loading ? (
      <p className="text-sm text-[#8d9bb0]">Loading saved tracks…</p>
    ) : tracks.length === 0 ? (
      <div className="rounded-lg border border-dashed border-[#2b3543] p-8 text-center">
        <p className="text-sm text-[#8d9bb0]">
          No tracks yet. Draw one and it will be saved to this browser.
        </p>
      </div>
    ) : (
      <ul className="flex flex-col gap-2">
        {tracks.map((track) => (
          <li
            key={track.id}
            className="flex items-center gap-3 rounded-lg border border-[#2b3543] bg-[#161b24] px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="truncate font-medium">{track.name}</h2>
                {badge(track) === undefined ? null : (
                  <span
                    className="shrink-0 rounded border border-[#ffb020]/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#ffb020]"
                    title={badge(track)?.title}
                  >
                    {badge(track)?.label}
                  </span>
                )}
              </div>
              <p className="text-xs tabular-nums text-[#8d9bb0]">
                {(track.lengthMeters / 1000).toFixed(2)} km · {track.mode} ·{' '}
                {track.routingProfile} · saved {formatDate(track.updatedAt)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onRace(track.id)}
              className="shrink-0 rounded bg-[#1f2632] px-3 py-1.5 text-sm transition-colors hover:bg-[#2b3543]"
            >
              Race it
            </button>
            <button
              type="button"
              onClick={() => onDelete(track.id)}
              className="shrink-0 rounded px-2 py-1.5 text-sm text-[#8d9bb0] transition-colors hover:bg-[#2b3543] hover:text-[#ff5c5c]"
              aria-label={`Delete ${track.name}`}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    )}
  </div>
);

/**
 * What was synthetic, if anything.
 *
 * The distinction matters: a synthetic route is not a real place, whereas
 * synthetic terrain is real streets with invented hills. One badge for both
 * would be wrong about whichever case it was not written for.
 */
const badge = (track: TrackSummary): { label: string; title: string } | undefined => {
  const { routing, elevation } = track.degraded;
  if (routing && elevation) {
    return {
      label: 'Synthetic',
      title: 'Built with no routing or elevation service, so neither the roads nor the hills are real.',
    };
  }
  if (routing) {
    return {
      label: 'Synthetic route',
      title: 'The routing service was unavailable, so this route does not follow real streets.',
    };
  }
  if (elevation) {
    return {
      label: 'Synthetic hills',
      title: 'Real streets, but the elevation service was unavailable, so the gradients are invented.',
    };
  }
  return undefined;
};

/** Short, local, and never a raw ISO string in front of a user. */
const formatDate = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'recently';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
