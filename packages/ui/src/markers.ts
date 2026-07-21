import type { MarkerPattern, RacerAppearance } from './palette';

/**
 * Racer markers, drawn once to a canvas and handed to MapLibre as images.
 *
 * CLAUDE.md is explicit that markers must not be DOM elements: forty absolutely
 * positioned divs updated at 60fps will not hold up. Pre-rendering each racer's
 * marker to an image and letting a single GL symbol layer draw all of them
 * means the per-frame cost is one source update, not forty layout passes.
 *
 * Icons are generated at 2x so they stay sharp on a retina display, and
 * registered with `pixelRatio: 2` so MapLibre halves them back down.
 */

/** Logical marker size in CSS pixels. */
const SIZE = 34;
const PIXEL_RATIO = 2;

const RING_WIDTH = 3;
/** Gap between the filled body and the pattern ring. */
const RING_GAP = 1.5;

const DASH_PATTERNS: Record<MarkerPattern, number[]> = {
  solid: [],
  dashed: [7, 5],
  // Short-and-round reads as dots rather than as very short dashes.
  dotted: [0.5, 5],
  double: [],
};

export type MarkerImage = {
  id: string;
  data: ImageData;
  pixelRatio: number;
};

/**
 * The id a racer's marker image is registered under. Status is part of the id
 * because a retired racer gets a visually distinct marker and MapLibre keys
 * images by name.
 */
export const markerImageId = (racerId: string, retired: boolean): string =>
  `racer-${racerId}${retired ? '-out' : ''}`;

/**
 * Build every marker image a race needs: one per racer, plus a retired variant.
 *
 * Returns `undefined` when there is no canvas to draw on — during SSR, or in a
 * test environment. Callers fall back to a plain circle layer.
 */
export const buildMarkerImages = (
  racers: readonly { racerId: string; number: number; appearance: RacerAppearance }[],
): MarkerImage[] | undefined => {
  const canvas = createCanvas(SIZE * PIXEL_RATIO, SIZE * PIXEL_RATIO);
  if (canvas === undefined) return undefined;

  // `OffscreenCanvas` and `HTMLCanvasElement` have separate 2D context types
  // that are structurally identical for everything used here. `Canvas2D` is
  // the shared subset, declared below.
  const context = canvas.getContext('2d') as Canvas2D | null;
  if (context === null) return undefined;

  const images: MarkerImage[] = [];
  for (const racer of racers) {
    for (const retired of [false, true]) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      drawMarker(context, racer.appearance, racer.number, retired);
      images.push({
        id: markerImageId(racer.racerId, retired),
        data: context.getImageData(0, 0, canvas.width, canvas.height),
        pixelRatio: PIXEL_RATIO,
      });
    }
  }
  return images;
};

/**
 * The subset of the 2D context this file uses, shared by the canvas and
 * offscreen-canvas flavours. Narrowing to this avoids a cast at every call.
 */
type Canvas2D = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'clearRect'
  | 'beginPath'
  | 'arc'
  | 'fill'
  | 'stroke'
  | 'moveTo'
  | 'lineTo'
  | 'setLineDash'
  | 'fillText'
  | 'getImageData'
> & {
  globalAlpha: number;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: CanvasLineCap;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
};

const drawMarker = (
  context: Canvas2D,
  appearance: RacerAppearance,
  racerNumber: number,
  retired: boolean,
): void => {
  const scale = PIXEL_RATIO;
  const center = (SIZE * scale) / 2;
  const bodyRadius = (SIZE / 2 - RING_WIDTH - RING_GAP - 1) * scale;
  const ringRadius = (SIZE / 2 - RING_WIDTH / 2 - 1) * scale;

  context.save();
  // A retired racer is drawn washed out rather than removed, so the viewer can
  // still see where the race ended for them.
  context.globalAlpha = retired ? 0.35 : 1;

  // Dark halo first: without it, a marker over a dark basemap has no edge and
  // two overlapping racers merge into one blob.
  context.beginPath();
  context.arc(center, center, ringRadius + RING_WIDTH * scale * 0.5, 0, Math.PI * 2);
  context.fillStyle = 'rgba(5, 8, 13, 0.75)';
  context.fill();

  context.beginPath();
  context.arc(center, center, bodyRadius, 0, Math.PI * 2);
  context.fillStyle = appearance.color;
  context.fill();

  drawRing(context, center, ringRadius, appearance, scale);

  if (!retired) {
    context.fillStyle = appearance.contrastText;
    context.font = `700 ${Math.round(13 * scale)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    // A hair below centre: text baselines sit optically high inside a circle.
    context.fillText(String(racerNumber), center, center + scale);
  } else {
    // A cross, so a retirement is legible without reading the timing tower.
    context.strokeStyle = appearance.contrastText;
    context.lineWidth = 2 * scale;
    context.lineCap = 'round';
    const arm = bodyRadius * 0.45;
    context.beginPath();
    context.moveTo(center - arm, center - arm);
    context.lineTo(center + arm, center + arm);
    context.moveTo(center + arm, center - arm);
    context.lineTo(center - arm, center + arm);
    context.stroke();
  }

  context.restore();
};

/**
 * The second visual channel. Colour alone is not enough at twenty-plus racers,
 * and the palette guarantees that two racers with similar hues never share a
 * ring pattern.
 */
const drawRing = (
  context: Canvas2D,
  center: number,
  radius: number,
  appearance: RacerAppearance,
  scale: number,
): void => {
  context.strokeStyle = appearance.color;
  context.lineWidth = RING_WIDTH * scale;
  context.lineCap = appearance.pattern === 'dotted' ? 'round' : 'butt';

  if (appearance.pattern === 'double') {
    // Two thin concentric rings rather than one thick one.
    context.lineWidth = (RING_WIDTH / 2.6) * scale;
    for (const offset of [-RING_WIDTH * 0.42 * scale, RING_WIDTH * 0.42 * scale]) {
      context.beginPath();
      context.arc(center, center, radius + offset, 0, Math.PI * 2);
      context.stroke();
    }
    return;
  }

  context.setLineDash((DASH_PATTERNS[appearance.pattern] ?? []).map((n) => n * scale));
  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([]);
};

/**
 * A canvas, from whichever API is available. `OffscreenCanvas` avoids touching
 * the document at all; the fallback covers browsers that lack it.
 */
const createCanvas = (
  width: number,
  height: number,
): OffscreenCanvas | HTMLCanvasElement | undefined => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

export const MARKER_SIZE_PX = SIZE;
