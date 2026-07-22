import { useCallback, useEffect, useState } from 'react';
import type {
  ElevationProvider,
  GeocodingProvider,
  LatLng,
  Place,
  RoutingErrorKind,
  RoutingProfile,
  RoutingProvider,
  Track,
  TrackMode,
} from '@anywhererace/core';
import { ZOOM_FOR_KIND } from '@anywhererace/core';
import type { LegalLoopError, LegalLoopFix } from '@anywhererace/track';
import { BuilderMap } from './BuilderMap';
import type { MapFocus } from './BuilderMap';
import { ElevationProfile } from './ElevationProfile';
import { MapSearch } from './MapSearch';
import { useTrackBuilder } from '../../useTrackBuilder';
import type { BuilderLeg } from '../../useTrackBuilder';
import { UnitToggle, useUnits } from '../../units';

/**
 * The track builder.
 *
 * Map on the right, a fixed panel on the left. The panel never overlaps the
 * streets you are trying to click on, and it gives the waypoint list somewhere
 * to live — which matters more than it sounds, because a leg that fails to
 * route has to be attributable to a specific corner rather than reported as a
 * general failure at save time.
 */

export type TrackBuilderProps = {
  routing: RoutingProvider;
  elevation: ElevationProvider;
  /**
   * Place search, for getting to where you want to draw. Optional: without it
   * the box simply is not offered, which is a better answer than a search field
   * that never finds anything.
   */
  geocoding?: GeocodingProvider | undefined;
  styleUrl: string;
  attribution: string;
  initialCenter?: LatLng;
  initialZoom?: number;
  /** Called with a fully baked track. The caller decides where it goes. */
  onSave: (track: Track) => void | Promise<void>;
  onCancel?: () => void;
  /** Shown when the routing service has fallen back to synthetic data. */
  degradedNotice?: string | undefined;
};

const DEFAULT_CENTER: LatLng = { lat: 51.5072, lng: -0.1276 };
const DEFAULT_ZOOM = 14;

export const TrackBuilder = ({
  routing,
  elevation,
  geocoding,
  styleUrl,
  attribution,
  initialCenter = DEFAULT_CENTER,
  initialZoom = DEFAULT_ZOOM,
  onSave,
  onCancel,
  degradedNotice,
}: TrackBuilderProps) => {
  const builder = useTrackBuilder({ routing, elevation });
  const { actions } = builder;
  const units = useUnits();

  // A fresh object per selection, so picking the same place twice moves the
  // camera twice — a user who has panned away since expects it to go back.
  const [focus, setFocus] = useState<MapFocus | undefined>(undefined);
  const goTo = useCallback((place: Place) => {
    setFocus({
      center: place.center,
      zoom: ZOOM_FOR_KIND[place.kind],
      // Framing the extent is right for a town or a region and wrong for a
      // country, because a country's extent includes everything it governs:
      // Portugal's bounding box reaches the Azores, France's reaches French
      // Guiana, and fitting either drops the user in an empty ocean halfway to
      // somewhere they did not ask for. A country's own point is on the
      // mainland, so a fixed continental zoom on it is the answer they meant.
      bounds: place.kind === 'country' ? undefined : place.bounds,
    });
  }, []);

  // Keyboard undo/redo. Standard bindings, including the Windows-style
  // Ctrl+Y that a lot of people reach for.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      // Never steal a keystroke from the name field.
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (!(event.ctrlKey || event.metaKey)) return;

      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        actions.undo();
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        actions.redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actions]);

  const save = useCallback(async () => {
    const id = `track-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await actions.bake(id);
    if (result.track !== undefined) await onSave(result.track);
  }, [actions, onSave]);

  const canSave = builder.complete && builder.waypoints.length >= 2 && !builder.saving;

  return (
    <div className="flex h-full w-full bg-[#0b0e13] text-[#e6ebf2]">
      <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-r border-[#2b3543] bg-[#161b24] p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-sm font-semibold uppercase tracking-wider text-[#8d9bb0]">
            Track builder
          </h1>
          <div className="flex items-center gap-2">
            <UnitToggle />
            {onCancel === undefined ? null : (
              <button type="button" onClick={onCancel} className={ghostButton}>
                Close
              </button>
            )}
          </div>
        </div>

        {degradedNotice === undefined ? null : (
          <p className="rounded border border-[#ffb020]/40 bg-[#ffb020]/10 px-2 py-1.5 text-[11px] leading-snug text-[#ffb020]">
            {degradedNotice}
          </p>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-[#8d9bb0]">Name</span>
          <input
            value={builder.name}
            onChange={(event) => actions.setName(event.target.value)}
            className="rounded border border-[#2b3543] bg-[#0b0e13] px-2 py-1.5 text-sm outline-none focus:border-[#4da3ff]"
          />
        </label>

        <fieldset className="flex flex-col gap-1">
          <legend className="text-[11px] uppercase tracking-wide text-[#8d9bb0]">Shape</legend>
          <div className="flex gap-1">
            {(['circuit', 'point-to-point'] as TrackMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => actions.setMode(mode)}
                aria-pressed={builder.mode === mode}
                className={toggleButton(builder.mode === mode)}
              >
                {mode === 'circuit' ? 'Circuit' : 'Point to point'}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-1">
          <legend className="text-[11px] uppercase tracking-wide text-[#8d9bb0]">
            Routing profile
          </legend>
          <div className="flex gap-1">
            {(['motor', 'bicycle', 'pedestrian'] as RoutingProfile[]).map((profile) => (
              <button
                key={profile}
                type="button"
                onClick={() => actions.setRoutingProfile(profile)}
                aria-pressed={builder.routingProfile === profile}
                className={toggleButton(builder.routingProfile === profile)}
              >
                {profile === 'motor' ? 'Motor' : profile === 'bicycle' ? 'Bike' : 'Foot'}
              </button>
            ))}
          </div>
          <p className="text-[11px] leading-snug text-[#8d9bb0]">
            {PROFILE_HELP[builder.routingProfile]}
          </p>
        </fieldset>

        <WaypointList
          waypoints={builder.waypoints}
          legs={builder.legs}
          onRemove={actions.removeWaypoint}
        />

        {builder.failedLegs.length === 0 ? null : (
          <LegalLoopHelper
            failed={builder.failedLegs}
            searching={builder.searching}
            onSearch={actions.findLegalLoop}
            units={units}
          />
        )}

        <div className="flex gap-1">
          <button type="button" onClick={actions.undo} disabled={!builder.canUndo} className={ghostButton}>
            Undo
          </button>
          <button type="button" onClick={actions.redo} disabled={!builder.canRedo} className={ghostButton}>
            Redo
          </button>
          <button
            type="button"
            onClick={actions.clear}
            disabled={builder.waypoints.length === 0}
            className={ghostButton}
          >
            Clear
          </button>
        </div>

        <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-sm tabular-nums">
          <dt className="text-[#8d9bb0]">Length</dt>
          <dd className="text-right">
            {builder.preview === undefined ? '—' : units.distance(builder.preview.lengthMeters)}
          </dd>
          <dt className="text-[#8d9bb0]">Corners</dt>
          <dd className="text-right">{builder.preview?.cornerCount ?? '—'}</dd>
          <dt className="text-[#8d9bb0]">Tightest</dt>
          <dd className="text-right">
            {builder.preview === undefined || !Number.isFinite(builder.preview.tightestRadiusM)
              ? '—'
              : units.shortDistance(builder.preview.tightestRadiusM)}
          </dd>
        </dl>

        <ElevationProfile preview={builder.preview} loading={builder.previewing} />

        {builder.saveError === undefined ? null : (
          <p className="rounded border border-[#ff5c5c]/40 bg-[#ff5c5c]/10 px-2 py-1.5 text-[11px] leading-snug text-[#ff5c5c]">
            {builder.saveError.message}
          </p>
        )}

        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSave}
          className="mt-auto rounded bg-[#4da3ff] px-3 py-2 text-sm font-semibold text-[#0b0e13] transition-colors hover:bg-[#6fb5ff] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {builder.saving ? 'Baking the track…' : 'Save track'}
        </button>
        <p className="text-[11px] leading-snug text-[#8d9bb0]">
          Click the map to add a waypoint, drag one to move it, click a waypoint to remove it.
          Drag the small handle in the middle of a leg to add a waypoint there instead of at
          the end.
        </p>
      </aside>

      <div className="relative flex-1">
        <BuilderMap
          waypoints={builder.waypoints}
          legs={builder.legs}
          styleUrl={styleUrl}
          attribution={attribution}
          initialCenter={initialCenter}
          initialZoom={initialZoom}
          focus={focus}
          onAddWaypoint={actions.addWaypoint}
          onInsertWaypoint={actions.insertWaypoint}
          onMoveWaypoint={actions.moveWaypoint}
          onRemoveWaypoint={actions.removeWaypoint}
        />
        {geocoding === undefined ? null : (
          <div className="absolute left-4 top-4 z-10">
            <MapSearch geocoding={geocoding} onSelect={goTo} />
          </div>
        )}
        {builder.waypoints.length === 0 ? (
          <div className="pointer-events-none absolute inset-x-0 top-6 flex justify-center">
            <p className="rounded-full border border-[#2b3543] bg-[#161b24]/90 px-4 py-2 text-sm text-[#8d9bb0] backdrop-blur">
              Click anywhere on the map to drop your first waypoint
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
};

/**
 * The "find nearest legal loop" helper CLAUDE.md asks for.
 *
 * Only appears when a leg will not route, because until then there is nothing
 * to find.
 *
 * The explanation is chosen from what the router actually said. A one-way
 * network is the case CLAUDE.md describes and the most interesting one, but it
 * is not the only way a leg fails, and telling a user their problem is a
 * one-way street when their waypoint is simply nowhere near a road sends them
 * looking in the wrong place. A user who understands *why* their block will not
 * close can usually fix it faster than the search can.
 *
 * Every outcome is reported, including the two that are not successes. A
 * search that exhausted its budget and a router that stopped answering mean
 * completely different things — the first says "not near here", the second
 * says nothing at all about the loop — and collapsing them into "could not
 * find a loop" would tell the user their route is impossible when it is not.
 */
const BREAK_CAUSE: Record<RoutingErrorKind, string> = {
  'illegal-direction':
    'On a one-way network a loop has to run in a single direction, so a block can be three-quarters possible and still not close.',
  'point-not-snappable':
    'A waypoint is too far from any road or path for the router to start from.',
  'no-route': 'There is no legal way to get between these two points on this profile.',
  'unsupported-profile': 'The router does not support this travel profile.',
  'provider-unavailable':
    'The routing service is not answering, so this may not be a problem with your route at all.',
};

const LegalLoopHelper = ({
  failed,
  searching,
  onSearch,
  units,
}: {
  failed: readonly BuilderLeg[];
  searching: { tried: number; budget: number } | undefined;
  onSearch: () => Promise<{ fix: LegalLoopFix } | { error: LegalLoopError }>;
  units: ReturnType<typeof useUnits>;
}) => {
  const [outcome, setOutcome] = useState<string | undefined>(undefined);
  const breaks = failed.length;

  // The first failure's kind, which is the right one to explain: they are
  // almost always the same cause, and leading with a list of maybes helps
  // nobody.
  const kind = failed[0]?.status.state === 'failed' ? failed[0].status.error.kind : undefined;
  const cause = kind === undefined ? '' : BREAK_CAUSE[kind];

  const run = useCallback(() => {
    setOutcome(undefined);
    void onSearch().then((result) => {
      if ('error' in result) {
        setOutcome(result.error.message);
        return;
      }
      const { waypointIndex, movedByMeters, remainingBreaks } = result.fix;
      setOutcome(
        `Moved waypoint ${waypointIndex + 1} by ${units.shortDistance(movedByMeters)}.` +
          (remainingBreaks === 0
            ? ' The loop closes. Undo puts it back.'
            : ` ${remainingBreaks} more leg${remainingBreaks > 1 ? 's' : ''} still will not route — run it again.`),
      );
    });
  }, [onSearch, units]);

  return (
    <div className="flex flex-col gap-1.5 rounded border border-[#ffb020]/40 bg-[#ffb020]/10 px-2 py-2">
      <p className="text-[11px] leading-snug text-[#ffb020]">
        {breaks === 1 ? 'One leg will not route' : `${breaks} legs will not route`}. {cause}
      </p>
      <button
        type="button"
        onClick={run}
        disabled={searching !== undefined}
        className="rounded bg-[#ffb020] px-2 py-1 text-xs font-semibold text-[#0b0e13] transition-colors hover:bg-[#ffc451] disabled:opacity-60"
      >
        {searching === undefined
          ? 'Find the nearest legal loop'
          : `Searching… ${searching.tried}/${searching.budget}`}
      </button>
      {outcome === undefined ? null : (
        <p className="text-[11px] leading-snug text-[#e6ebf2]">{outcome}</p>
      )}
    </div>
  );
};

const WaypointList = ({
  waypoints,
  legs,
  onRemove,
}: {
  waypoints: readonly LatLng[];
  legs: readonly BuilderLeg[];
  onRemove: (index: number) => void;
}) => {
  if (waypoints.length === 0) {
    return <p className="text-[11px] text-[#8d9bb0]">No waypoints yet.</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-[#8d9bb0]">
        Waypoints ({waypoints.length})
      </span>
      <ol className="flex max-h-48 flex-col overflow-y-auto rounded border border-[#2b3543]">
        {waypoints.map((point, index) => {
          // The leg *leaving* this waypoint is the one whose failure the user
          // should see attached to it.
          const leg = legs.find((candidate) => candidate.fromIndex === index);
          const failed = leg?.status.state === 'failed';
          const routing = leg?.status.state === 'routing';

          return (
            <li
              key={`${point.lat},${point.lng},${index}`}
              className="flex items-center gap-2 border-b border-[#2b3543]/60 px-2 py-1.5 text-xs last:border-b-0"
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                  index === 0 ? 'bg-[#3ddc97] text-[#0b0e13]' : 'bg-[#e6ebf2] text-[#0b0e13]'
                }`}
              >
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[#8d9bb0]">
                {failed ? (
                  <span className="text-[#ff5c5c]">{leg?.status.state === 'failed' ? leg.status.error.message : ''}</span>
                ) : routing ? (
                  'Routing…'
                ) : (
                  `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`
                )}
              </span>
              <button
                type="button"
                onClick={() => onRemove(index)}
                className="shrink-0 rounded px-1 text-[#8d9bb0] hover:bg-[#2b3543] hover:text-[#ff5c5c]"
                aria-label={`Remove waypoint ${index + 1}`}
              >
                ×
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
};

const PROFILE_HELP: Record<RoutingProfile, string> = {
  motor: 'One-way streets and turn restrictions enforced. Cars and race cars.',
  bicycle: 'Contraflow bike lanes allowed, unpaved permitted. Bikes and scooters.',
  pedestrian: 'Paths, tracks and footways included. Runners only.',
};

const ghostButton =
  'rounded border border-[#2b3543] bg-[#1f2632] px-2 py-1 text-xs text-[#e6ebf2] transition-colors hover:bg-[#2b3543] disabled:cursor-not-allowed disabled:opacity-40';

const toggleButton = (active: boolean): string =>
  [
    'flex-1 rounded px-2 py-1 text-xs font-medium transition-colors',
    active ? 'bg-[#4da3ff] text-[#0b0e13]' : 'bg-[#1f2632] text-[#e6ebf2] hover:bg-[#2b3543]',
  ].join(' ');
