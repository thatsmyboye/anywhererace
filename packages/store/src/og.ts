import type { LatLng, Track } from '@anywhererace/core';
import type { RaceConfig, RaceResult } from '@anywhererace/sim';
import { getVehicleClass, isRetirement } from '@anywhererace/sim';

/**
 * The Open Graph share card.
 *
 * Shared links are the growth loop, so an unfurled link has to show the race at
 * a glance: the shape of the track, who won, and by how much. This builds that
 * card as an SVG string — no canvas, no headless browser, no binary — so it can
 * be produced anywhere the sim runs, including a serverless function that
 * decodes a link and renders its card on demand.
 *
 * It is pure and deterministic: the same race always yields the same card,
 * which matters because a card is generated from the race's *inputs* (re-run to
 * find the winner) rather than from a stored summary that could drift.
 */

/** Standard Open Graph image size. */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

export type RaceCard = {
  trackName: string;
  vehicleLabel: string;
  mode: Track['mode'];
  /** Name of the winner, or of whoever got furthest if nobody finished. */
  winnerName: string;
  /** Human phrase under the winner: "by 2.34s", "unopposed", "nobody finished". */
  marginText: string;
  /** Shape to draw. The snapped polyline is plenty of detail at card size. */
  polyline: readonly LatLng[];
};

/**
 * Reduce a race to the handful of facts the card shows. Takes the result rather
 * than trusting a stored summary, so the card can never disagree with the race.
 */
export const buildRaceCard = (
  track: Track,
  config: RaceConfig,
  result: RaceResult,
): RaceCard => {
  const nameOf = (racerId: string | undefined): string =>
    config.racers.find((racer) => racer.id === racerId)?.name ?? 'Nobody';

  const winner = result.finishers[0];
  const runnerUp = result.finishers[1];
  const vehicleLabel = getVehicleClass(config.vehicleClassId)?.label ?? config.vehicleClassId;

  let marginText: string;
  if (winner === undefined || isRetirement(winner.status)) {
    marginText = 'nobody finished';
  } else if (runnerUp === undefined || runnerUp.gapToWinnerS === undefined) {
    marginText = 'unopposed';
  } else if (runnerUp.gapToWinnerS < 0.5) {
    marginText = `by ${runnerUp.gapToWinnerS.toFixed(2)}s — a photo finish`;
  } else {
    marginText = `by ${formatMargin(runnerUp.gapToWinnerS)}`;
  }

  return {
    trackName: track.name,
    vehicleLabel,
    mode: track.mode,
    winnerName: nameOf(winner?.racerId),
    marginText,
    polyline: track.polyline,
  };
};

const formatMargin = (seconds: number): string => {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}:${String(rest).padStart(2, '0')}`;
};

/** The dark palette, kept in step with the app's race view. */
const COLORS = {
  bg: '#0b0e13',
  panel: '#161b24',
  border: '#2b3543',
  ink: '#e6ebf2',
  muted: '#8d9bb0',
  accent: '#3ddc97',
  track: '#5b8cff',
};

export const buildRaceOgSvg = (card: RaceCard): string => {
  const path = trackPath(card.polyline, {
    x: 64,
    y: 64,
    width: 460,
    height: OG_HEIGHT - 128,
    close: card.mode === 'circuit',
  });

  const textX = 580;
  const winner = truncate(card.winnerName, 22);
  const trackName = truncate(card.trackName, 30);
  const detail = `${card.vehicleLabel} · ${card.mode === 'circuit' ? 'Circuit' : 'Point to point'}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="${COLORS.bg}"/>
  <rect x="40" y="40" width="${OG_WIDTH - 80}" height="${OG_HEIGHT - 80}" rx="24" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="2"/>
  ${path}
  <text x="${textX}" y="132" font-family="Arial, Helvetica, sans-serif" font-size="30" fill="${COLORS.accent}" letter-spacing="4">ANYWHERERACE</text>
  <text x="${textX}" y="150" font-family="Arial, Helvetica, sans-serif" font-size="26" fill="${COLORS.muted}">Winner</text>
  <text x="${textX}" y="252" font-family="Arial, Helvetica, sans-serif" font-size="88" font-weight="bold" fill="${COLORS.ink}">${escapeXml(winner)}</text>
  <text x="${textX}" y="320" font-family="Arial, Helvetica, sans-serif" font-size="40" fill="${COLORS.muted}">${escapeXml(card.marginText)}</text>
  <text x="${textX}" y="512" font-family="Arial, Helvetica, sans-serif" font-size="40" font-weight="bold" fill="${COLORS.ink}">${escapeXml(trackName)}</text>
  <text x="${textX}" y="556" font-family="Arial, Helvetica, sans-serif" font-size="28" fill="${COLORS.muted}">${escapeXml(detail)}</text>
</svg>`;
};

type Box = { x: number; y: number; width: number; height: number; close: boolean };

/**
 * Project the track's lat/lng polyline into an SVG path that fits `box`,
 * preserving aspect so the shape is recognizable. Longitude is scaled by the
 * cosine of the mid-latitude — the standard cheap fix so a course does not look
 * stretched east-west the further it is from the equator.
 */
const trackPath = (polyline: readonly LatLng[], box: Box): string => {
  if (polyline.length < 2) {
    // Degenerate track — draw a marker rather than nothing.
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    return `<circle cx="${cx}" cy="${cy}" r="8" fill="${COLORS.track}"/>`;
  }

  const midLat = polyline.reduce((sum, p) => sum + p.lat, 0) / polyline.length;
  const lngScale = Math.cos((midLat * Math.PI) / 180);

  const projected = polyline.map((p) => ({ x: p.lng * lngScale, y: -p.lat }));
  const xs = projected.map((p) => p.x);
  const ys = projected.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const spanX = Math.max(maxX - minX, 1e-9);
  const spanY = Math.max(maxY - minY, 1e-9);
  const scale = Math.min(box.width / spanX, box.height / spanY);

  // Center the shape within the box after scaling.
  const drawnW = spanX * scale;
  const drawnH = spanY * scale;
  const offsetX = box.x + (box.width - drawnW) / 2;
  const offsetY = box.y + (box.height - drawnH) / 2;

  const coords = projected.map((p) => {
    const x = offsetX + (p.x - minX) * scale;
    const y = offsetY + (p.y - minY) * scale;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const d = `M${coords[0]}` + coords.slice(1).map((c) => `L${c}`).join('') + (box.close ? 'Z' : '');
  return `<path d="${d}" fill="none" stroke="${COLORS.track}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>`;
};

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const escapeXml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
