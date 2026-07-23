/**
 * Racer identity: colour, and a second visual channel.
 *
 * At twenty-plus racers colour alone stops working. Nine degrees of hue is the
 * gap between adjacent racers in a forty-car field, which is invisible at
 * marker size and worse than invisible for the roughly 8% of men with a colour
 * vision deficiency. So every racer carries a *pattern* as well, and the
 * assignment guarantees the property that matters: two racers whose colours are
 * hard to tell apart never share a pattern.
 *
 * Colours come from an OkLCH ramp rather than HSL. HSL is perceptually
 * dishonest — its yellows are far lighter than its blues at the same nominal
 * lightness, so an evenly-spaced HSL ramp produces a palette where half the
 * entries vanish against the map and the other half glare.
 */

/** The second channel. Rendered as the marker's ring. */
export type MarkerPattern = 'solid' | 'dashed' | 'dotted' | 'double';

export const MARKER_PATTERNS: readonly MarkerPattern[] = ['solid', 'dashed', 'dotted', 'double'];

/**
 * The third channel. Rendered as the marker's body outline.
 *
 * Colour plus one pattern channel holds up to about forty racers; past that the
 * hue wheel is sliced too finely for the four patterns to keep every similar
 * pair apart. Shape is a genuinely orthogonal channel — legible at marker size
 * and unaffected by colour vision deficiency — and it is what makes a
 * hundred-racer field readable. It is deliberately *not* the vehicle silhouette:
 * a v1 race runs a single vehicle class, so a silhouette is identical for every
 * racer and distinguishes nobody.
 *
 * Five shapes, coprime with the four patterns, so a given (pattern, shape) pair
 * recurs only every twenty steps around the hue wheel — 72 degrees at a
 * hundred racers, a gap no one confuses for a colour clash.
 */
export type MarkerShape = 'circle' | 'triangle' | 'square' | 'diamond' | 'pentagon';

export const MARKER_SHAPES: readonly MarkerShape[] = [
  'circle',
  'triangle',
  'square',
  'diamond',
  'pentagon',
];

export type RacerAppearance = {
  /** `#rrggbb`. */
  color: string;
  pattern: MarkerPattern;
  /** The body outline. See `MarkerShape`. */
  shape: MarkerShape;
  /** Position in the hue ramp, 0-based. Exposed for tests and debugging. */
  hueIndex: number;
  /** A darker shade of the same hue, for text on top of the colour. */
  contrastText: string;
};

/**
 * Tuned for a dark basemap: light enough to read against near-black, chromatic
 * enough to be a colour rather than a grey, and short of the sRGB gamut edge so
 * that the ramp stays perceptually even instead of flattening in the blues.
 */
const RAMP = {
  lightness: 0.74,
  chroma: 0.15,
  /**
   * Where the ramp starts. 25 degrees puts racer one on a warm red rather than
   * an ambiguous pink, which reads better as "leader" at a glance.
   */
  startHueDeg: 25,
} as const;

/**
 * Build appearances for a field.
 *
 * Two separate concerns, deliberately kept apart:
 *
 * - **Hue spacing.** Hues are evenly spaced around the wheel, so no two are
 *   closer than they have to be.
 * - **Assignment.** Racers are given hues in a strided order rather than in
 *   sequence, so that racer 1 and racer 2 — adjacent in the timing tower, and
 *   likely adjacent on the road at the start — land on opposite sides of the
 *   wheel instead of nine degrees apart.
 *
 * The pattern and shape are derived from the *hue* index, never the racer
 * index, which is what guarantees that neighbouring hues always differ in both.
 */
export const buildPalette = (count: number): RacerAppearance[] => {
  if (count <= 0) return [];
  const stride = coprimeStride(count);

  return Array.from({ length: count }, (_, racerIndex) => {
    const hueIndex = (racerIndex * stride) % count;
    const hue = (RAMP.startHueDeg + (360 * hueIndex) / count) % 360;
    const color = oklchToHex(RAMP.lightness, RAMP.chroma, hue);
    return {
      color,
      pattern: MARKER_PATTERNS[hueIndex % MARKER_PATTERNS.length] as MarkerPattern,
      shape: MARKER_SHAPES[hueIndex % MARKER_SHAPES.length] as MarkerShape,
      hueIndex,
      contrastText: oklchToHex(0.2, RAMP.chroma * 0.6, hue),
    };
  });
};

/**
 * The vertices of a marker shape, on a circle of the given radius, as `[x, y]`
 * pairs ready for a canvas or SVG path. `circle` has no vertices and returns
 * `null` — its renderers draw an arc instead.
 *
 * Lives here, next to the shape assignment and free of any canvas or DOM type,
 * so the map marker (canvas) and the timing-tower chip (SVG) trace an identical
 * outline from one source. Regular polygons with a per-shape start angle:
 * triangle, diamond and pentagon sit point-up; square sits flat.
 */
export const markerShapePoints = (
  shape: MarkerShape,
  cx: number,
  cy: number,
  radius: number,
): [number, number][] | null => {
  const geometry = SHAPE_GEOMETRY[shape];
  if (geometry === undefined) return null;
  const startRad = (geometry.startDeg * Math.PI) / 180;
  return Array.from({ length: geometry.sides }, (_, i) => {
    const angle = startRad + (2 * Math.PI * i) / geometry.sides;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  });
};

/** Sides and starting angle per shape; `circle` is absent and special-cased. */
const SHAPE_GEOMETRY: Partial<Record<MarkerShape, { sides: number; startDeg: number }>> = {
  triangle: { sides: 3, startDeg: -90 },
  // Vertices at the diagonals, which puts flat sides on the top and bottom.
  square: { sides: 4, startDeg: -45 },
  diamond: { sides: 4, startDeg: -90 },
  pentagon: { sides: 5, startDeg: -90 },
};

/**
 * A step size coprime to `count`, near `count / phi`.
 *
 * Coprime guarantees the stride visits every hue exactly once — a stride
 * sharing a factor with the count would hand several racers the same colour.
 * Near the golden ratio because that maximises the spacing between
 * consecutively-assigned entries.
 */
const coprimeStride = (count: number): number => {
  if (count <= 2) return 1;
  const target = Math.max(1, Math.round(count / 1.618));
  for (let offset = 0; offset < count; offset++) {
    for (const candidate of [target + offset, target - offset]) {
      if (candidate > 0 && candidate < count && gcd(candidate, count) === 1) return candidate;
    }
  }
  return 1;
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

// --- OkLCH -> sRGB ----------------------------------------------------------

/**
 * Convert OkLCH to a hex sRGB string, reducing chroma until the colour fits in
 * the gamut.
 *
 * Clamping the channels instead — the obvious shortcut — shifts the hue, and
 * shifts it by different amounts for different hues, which would undo the
 * even spacing this whole file exists to provide.
 */
export const oklchToHex = (lightness: number, chroma: number, hueDeg: number): string => {
  let low = 0;
  let high = chroma;
  let best = oklchToRgb(lightness, 0, hueDeg);

  // 12 bisections resolves chroma far finer than 8-bit output can show.
  for (let i = 0; i < 12; i++) {
    const mid = (low + high) / 2;
    const candidate = oklchToRgb(lightness, mid, hueDeg);
    if (candidate.inGamut) {
      best = candidate;
      low = mid;
    } else {
      high = mid;
    }
  }
  return `#${toHexByte(best.r)}${toHexByte(best.g)}${toHexByte(best.b)}`;
};

type RgbResult = { r: number; g: number; b: number; inGamut: boolean };

const oklchToRgb = (lightness: number, chroma: number, hueDeg: number): RgbResult => {
  const hue = (hueDeg * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);

  // Oklab -> LMS' -> LMS (Björn Ottosson's matrices).
  const lp = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mp = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sp = lightness - 0.0894841775 * a - 1.291485548 * b;

  const l = lp * lp * lp;
  const m = mp * mp * mp;
  const s = sp * sp * sp;

  const linearR = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const linearG = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const linearB = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  const inGamut =
    inUnitRange(linearR) && inUnitRange(linearG) && inUnitRange(linearB);

  return {
    r: linearToSrgb(linearR),
    g: linearToSrgb(linearG),
    b: linearToSrgb(linearB),
    inGamut,
  };
};

// A hair of tolerance, or rounding puts perfectly good colours out of gamut.
const inUnitRange = (value: number): boolean => value >= -0.0001 && value <= 1.0001;

const linearToSrgb = (value: number): number => {
  const clamped = value < 0 ? 0 : value > 1 ? 1 : value;
  return clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
};

const toHexByte = (channel: number): string =>
  Math.round(channel * 255)
    .toString(16)
    .padStart(2, '0');

// --- Status colours ---------------------------------------------------------

/** Semantic colours for the dark theme. Kept here so nothing is inline in JSX. */
export const THEME = {
  background: '#0b0e13',
  surface: '#161b24',
  surfaceRaised: '#1f2632',
  border: '#2b3543',
  text: '#e6ebf2',
  textMuted: '#8d9bb0',
  accent: '#4da3ff',
  positive: '#3ddc97',
  warning: '#ffb020',
  danger: '#ff5c5c',
  /** The route line drawn under the racers. */
  trackLine: '#4a5568',
  /** Casing beneath the route line, so it reads against a busy basemap. */
  trackCasing: '#0b0e13',
} as const;
