import { describe, expect, it } from 'vitest';
import {
  celsiusToFahrenheit,
  formatDistanceM,
  formatRainMmPerHour,
  formatShortDistanceM,
  formatSpanM,
  formatSpeedMs,
  formatTemperatureC,
  formatWindSpeedMs,
  ftToM,
  mToFt,
  mToMi,
  miToM,
  msToMph,
} from '../src/units';

describe('unit conversion', () => {
  it('round-trips distance without drift', () => {
    expect(miToM(mToMi(4321))).toBeCloseTo(4321, 9);
    expect(ftToM(mToFt(4321))).toBeCloseTo(4321, 9);
  });

  it('uses the exact international definitions', () => {
    expect(miToM(1)).toBe(1609.344);
    expect(ftToM(1)).toBe(0.3048);
  });

  it('converts speed and temperature at the reference points', () => {
    // 100 km/h is 62.14 mph, the number on every dual-marked speedometer.
    expect(msToMph(100 / 3.6)).toBeCloseTo(62.137, 3);
    expect(celsiusToFahrenheit(0)).toBe(32);
    expect(celsiusToFahrenheit(100)).toBe(212);
    expect(celsiusToFahrenheit(-40)).toBe(-40);
  });
});

describe('formatting for a reader', () => {
  it('keeps long distances in the large unit', () => {
    expect(formatDistanceM(12_340, 'metric')).toBe('12.34 km');
    expect(formatDistanceM(12_340, 'imperial')).toBe('7.67 mi');
  });

  it('keeps short distances in the small unit', () => {
    // A 40m gap is not 0.04 of anything, in either system.
    expect(formatShortDistanceM(40, 'metric')).toBe('40 m');
    expect(formatShortDistanceM(40, 'imperial')).toBe('131 ft');
  });

  it('switches a span at one of its own large unit, not at one kilometer', () => {
    expect(formatSpanM(900, 'metric')).toBe('900 m');
    expect(formatSpanM(1200, 'metric')).toBe('1.2 km');
    // 1200m is under a mile, so imperial is still in feet where metric is not.
    expect(formatSpanM(1200, 'imperial')).toBe('3937 ft');
    expect(formatSpanM(2000, 'imperial')).toBe('1.2 mi');
  });

  it('shows racer speed in km/h but wind in m/s', () => {
    expect(formatSpeedMs(10, 'metric')).toBe('36.0 km/h');
    expect(formatSpeedMs(10, 'imperial')).toBe('22.4 mph');
    expect(formatWindSpeedMs(10, 'metric')).toBe('10.0 m/s');
    expect(formatWindSpeedMs(10, 'imperial')).toBe('22.4 mph');
  });

  it('formats weather', () => {
    expect(formatTemperatureC(18, 'metric')).toBe('18°C');
    expect(formatTemperatureC(18, 'imperial')).toBe('64°F');
    expect(formatRainMmPerHour(2.4, 'metric')).toBe('2.4 mm/h');
    expect(formatRainMmPerHour(2.4, 'imperial')).toBe('0.09 in/h');
  });

  it('keeps drizzle and a downpour distinguishable in inches', () => {
    // One decimal would round the whole interesting range to 0.0 or 0.1.
    expect(formatRainMmPerHour(0.5, 'imperial')).not.toBe(
      formatRainMmPerHour(2, 'imperial'),
    );
  });
});
