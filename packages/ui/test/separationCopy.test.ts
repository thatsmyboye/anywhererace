import { describe, expect, it } from 'vitest';
import type { SeparationPoint } from '@anywhererace/core';
import { describeSeparation } from '../src/separationCopy';

const at = (startM: number, endM: number, detail: SeparationPoint['detail']): SeparationPoint => ({
  startM,
  endM,
  kind: typeof detail === 'string' ? 'climb' : detail.kind,
  severity: 0.5,
  detail,
});

describe('describing a separation point', () => {
  it('writes a climb in either system', () => {
    const climb = at(400, 1000, { kind: 'climb', meanGradient: 0.06, gainM: 36 });
    expect(describeSeparation(climb, 'metric')).toBe('6.0% for 600 m, 36 m of climbing');
    expect(describeSeparation(climb, 'imperial')).toBe('6.0% for 1969 ft, 118 ft of climbing');
  });

  it('keeps gradient a ratio — a percent is a percent in both systems', () => {
    const climb = at(0, 2000, { kind: 'climb', meanGradient: 0.085, gainM: 170 });
    for (const system of ['metric', 'imperial'] as const) {
      expect(describeSeparation(climb, system)).toContain('8.5%');
    }
  });

  it('writes a pinch point to a tenth, which is where the drama is', () => {
    const narrows = at(300, 600, { kind: 'narrows', tightestWidthM: 2.5 });
    expect(describeSeparation(narrows, 'metric')).toBe('down to 2.5 m wide for 300 m');
    expect(describeSeparation(narrows, 'imperial')).toBe('down to 8.2 ft wide for 984 ft');
  });

  it('writes the remaining kinds', () => {
    expect(describeSeparation(at(0, 1200, { kind: 'technical', featureCount: 6 }), 'metric')).toBe(
      '6 corners and junctions in 1.2 km',
    );
    expect(
      describeSeparation(at(400, 800, { kind: 'surface', surface: 'cobble', assumed: false }), 'metric'),
    ).toBe('400 m of cobble');
    expect(
      describeSeparation(at(400, 800, { kind: 'surface', surface: 'gravel', assumed: true }), 'metric'),
    ).toBe('400 m of assumed gravel');
  });

  it('says a crosswind is a condition, not a promise', () => {
    const exposed = at(2000, 4000, { kind: 'exposed' });
    expect(describeSeparation(exposed, 'metric')).toContain('if there is a crosswind');
  });

  it('renders a pre-measurement track verbatim rather than mangling it', () => {
    // Courses saved before the sweep emitted numbers carry the sentence itself,
    // and there is nothing left in it to convert.
    const legacy = at(400, 1000, '6.0% for 600 m, 36m of climbing');
    expect(describeSeparation(legacy, 'imperial')).toBe('6.0% for 600 m, 36m of climbing');
  });
});
