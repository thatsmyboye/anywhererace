import { describe, expect, it } from 'vitest';
import { MARKER_PATTERNS, buildPalette, oklchToHex } from '../src/palette';

/** Relative luminance, for contrast checks against the dark background. */
const luminance = (hex: string): number => {
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

const contrastRatio = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

describe('oklchToHex', () => {
  it('produces valid six-digit hex', () => {
    for (let hue = 0; hue < 360; hue += 7) {
      expect(oklchToHex(0.74, 0.15, hue)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('reduces chroma to fit the gamut rather than clipping channels', () => {
    // Clipping would shift the hue, and by different amounts per hue, undoing
    // the even spacing the palette exists to provide. An absurd chroma request
    // must still come back as a sensible colour of the right hue.
    const requested = oklchToHex(0.74, 0.9, 250);
    const reasonable = oklchToHex(0.74, 0.15, 250);
    expect(requested).toMatch(/^#[0-9a-f]{6}$/);

    const blueish = (hex: string): boolean =>
      parseInt(hex.slice(5, 7), 16) > parseInt(hex.slice(1, 3), 16);
    expect(blueish(requested)).toBe(true);
    expect(blueish(reasonable)).toBe(true);
  });

  it('is monotonic in lightness', () => {
    const dark = luminance(oklchToHex(0.3, 0.1, 140));
    const mid = luminance(oklchToHex(0.6, 0.1, 140));
    const light = luminance(oklchToHex(0.9, 0.1, 140));
    expect(mid).toBeGreaterThan(dark);
    expect(light).toBeGreaterThan(mid);
  });
});

describe('buildPalette', () => {
  it('returns one appearance per racer', () => {
    for (const size of [2, 8, 20, 40]) {
      expect(buildPalette(size)).toHaveLength(size);
    }
  });

  it('handles a degenerate field without throwing', () => {
    expect(buildPalette(0)).toEqual([]);
    expect(buildPalette(1)).toHaveLength(1);
  });

  it('gives every racer a distinct colour', () => {
    // A stride sharing a factor with the field size would hand several racers
    // the same hue, which is the failure this guards.
    for (const size of [2, 3, 7, 12, 16, 24, 36, 40]) {
      const colors = buildPalette(size).map((entry) => entry.color);
      expect(new Set(colors).size).toBe(size);
    }
  });

  it('visits every hue slot exactly once', () => {
    for (const size of [5, 9, 20, 40]) {
      const indices = buildPalette(size).map((entry) => entry.hueIndex).sort((a, b) => a - b);
      expect(indices).toEqual(Array.from({ length: size }, (_, i) => i));
    }
  });

  it('never gives neighbouring hues the same pattern', () => {
    // The property that makes a 40-racer field readable: if two colours are
    // hard to tell apart, the ring pattern must differ.
    for (const size of [8, 20, 40]) {
      const byHue = buildPalette(size).slice().sort((a, b) => a.hueIndex - b.hueIndex);
      for (let i = 1; i < byHue.length; i++) {
        expect(byHue[i]?.pattern).not.toBe(byHue[i - 1]?.pattern);
      }
    }
  });

  it('keeps consecutively numbered racers far apart in hue', () => {
    // Racer 1 and racer 2 sit next to each other in the timing tower and on the
    // grid, so they should not be nine degrees of hue apart.
    const size = 40;
    const palette = buildPalette(size);
    for (let i = 1; i < palette.length; i++) {
      const previous = palette[i - 1]?.hueIndex ?? 0;
      const current = palette[i]?.hueIndex ?? 0;
      const separation = Math.min(
        Math.abs(current - previous),
        size - Math.abs(current - previous),
      );
      // At least a tenth of the wheel between consecutive racer numbers.
      expect(separation).toBeGreaterThan(size / 10);
    }
  });

  it('produces colours that are legible on the dark theme', () => {
    // Every marker has to read against the near-black background.
    for (const entry of buildPalette(40)) {
      expect(contrastRatio(entry.color, '#0b0e13')).toBeGreaterThan(4.5);
    }
  });

  it('pairs each colour with readable text', () => {
    for (const entry of buildPalette(24)) {
      expect(contrastRatio(entry.color, entry.contrastText)).toBeGreaterThan(4.5);
    }
  });

  it('is deterministic', () => {
    expect(buildPalette(17)).toEqual(buildPalette(17));
  });

  it('only uses known patterns', () => {
    for (const entry of buildPalette(40)) {
      expect(MARKER_PATTERNS).toContain(entry.pattern);
    }
  });
});
