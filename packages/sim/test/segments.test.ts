import { describe, expect, it } from 'vitest';
import { buildSegmentHeat } from '../src/results';
import { SegmentTimer, segmentCountFor } from '../src/segments';
import type { SegmentTiming } from '../src/types';

/**
 * The timer is pure accounting over distances the tick has already decided, so
 * it can be driven directly rather than through a race.
 */

const LAP_M = 1000;

/** Walk a racer at a constant speed, one 50ms tick at a time. */
const walk = (
  timer: SegmentTimer,
  racerId: string,
  fromM: number,
  toM: number,
  speedMs: number,
): void => {
  const dtS = 0.05;
  const stepM = speedMs * dtS;
  for (let d = fromM; d < toM; d += stepM) {
    timer.record(racerId, d, Math.min(d + stepM, toM), dtS);
  }
};

describe('segment resolution', () => {
  it('gives a short lap enough bands to read as a map', () => {
    expect(segmentCountFor(400)).toBe(24);
  });

  it('aims for a hundred meters on an ordinary lap', () => {
    expect(segmentCountFor(5000)).toBe(50);
  });

  it('does not give a very long course hundreds of bands', () => {
    expect(segmentCountFor(100_000)).toBe(240);
  });
});

describe('timing a racer through the bands', () => {
  it('splits a lap into equal bands', () => {
    const timer = new SegmentTimer(LAP_M, ['a']);
    expect(timer.segmentCount).toBe(24);
    expect(timer.segmentLengthM).toBeCloseTo(LAP_M / 24, 9);
  });

  it('books a constant-speed lap evenly', () => {
    const timer = new SegmentTimer(LAP_M, ['a']);
    // Two laps, so every band is entered cleanly at least once.
    walk(timer, 'a', 0, LAP_M * 2, 10);

    const timing = timer.build();
    const mine = timing.perRacer[0];
    const expectedS = timing.segmentLengthM / 10;

    for (let i = 0; i < timing.segmentCount; i++) {
      expect(mine?.passes[i]).toBeGreaterThan(0);
      const mean = (mine?.totalS[i] ?? 0) / (mine?.passes[i] ?? 1);
      expect(mean).toBeCloseTo(expectedS, 3);
    }
  });

  it('books a slow stretch as slow and leaves the rest alone', () => {
    const timer = new SegmentTimer(LAP_M, ['a']);
    // Half speed through the middle of the lap, full speed elsewhere.
    walk(timer, 'a', 0, 400, 10);
    walk(timer, 'a', 400, 600, 5);
    walk(timer, 'a', 600, LAP_M * 2, 10);

    const timing = timer.build();
    const mine = timing.perRacer[0];
    const meanAt = (m: number): number => {
      const i = Math.floor(m / timing.segmentLengthM);
      return (mine?.totalS[i] ?? 0) / (mine?.passes[i] ?? 1);
    };

    // Band 12 sits inside 400-600m and was ridden once slow, once fast.
    expect(meanAt(500)).toBeGreaterThan(meanAt(100));
    expect(meanAt(800)).toBeCloseTo(meanAt(100), 2);
  });

  it('does not average in the band the grid dropped them into', () => {
    // Starting mid-band means the first traversal is partial. Counting it would
    // report that stretch as far quicker than it is.
    const timer = new SegmentTimer(LAP_M, ['a']);
    const bandLengthM = timer.segmentLengthM;
    walk(timer, 'a', bandLengthM * 0.9, bandLengthM * 3, 10);

    const timing = timer.build();
    const mine = timing.perRacer[0];
    expect(mine?.passes[0]).toBe(0);
    expect(mine?.totalS[0]).toBe(0);
    // The bands entered properly are there and are the real traversal time.
    expect(mine?.passes[1]).toBe(1);
    expect((mine?.totalS[1] ?? 0)).toBeCloseTo(bandLengthM / 10, 2);
  });

  it('drops the band a racer was still in when they retired', () => {
    const timer = new SegmentTimer(LAP_M, ['a']);
    const bandLengthM = timer.segmentLengthM;
    // Enters band 1 cleanly, stops halfway through it and is never seen again.
    walk(timer, 'a', 0, bandLengthM * 1.5, 10);

    const timing = timer.build();
    expect(timing.perRacer[0]?.passes[1]).toBe(0);
  });

  it('keeps counting across the start line on a circuit', () => {
    const timer = new SegmentTimer(LAP_M, ['a']);
    walk(timer, 'a', 0, LAP_M * 3, 10);

    const timing = timer.build();
    const last = timing.segmentCount - 1;
    // Three laps, two of them entering the last band cleanly from the one
    // before and one from a standing start; the wrap must not lose any.
    expect(timing.perRacer[0]?.passes[last]).toBeGreaterThanOrEqual(2);
  });

  it('books a stationary racer to the band they stopped in', () => {
    // A spin costs time on the stretch it happened on, not on the next one.
    const timer = new SegmentTimer(LAP_M, ['a']);
    const bandLengthM = timer.segmentLengthM;
    walk(timer, 'a', 0, bandLengthM * 1.5, 10);
    for (let i = 0; i < 20; i++) timer.record('a', bandLengthM * 1.5, bandLengthM * 1.5, 0.05);
    // Then they get going again and ride out of the band.
    walk(timer, 'a', bandLengthM * 1.5, bandLengthM * 2.5, 10);

    const timing = timer.build();
    const rollingS = bandLengthM / 10;
    // Band 1 was entered cleanly, ridden end to end, and stood still in for a
    // second along the way.
    expect(timing.perRacer[0]?.passes[1]).toBe(1);
    expect(timing.perRacer[0]?.totalS[1] ?? 0).toBeCloseTo(rollingS + 1, 2);
    // Band 2 was entered but never left, so it says nothing at all.
    expect(timing.perRacer[0]?.passes[2]).toBe(0);
  });
});

describe('the heat map', () => {
  const timingFor = (rows: Record<string, number[]>): SegmentTiming => ({
    segmentLengthM: 100,
    segmentCount: 3,
    perRacer: Object.entries(rows).map(([racerId, totalS]) => ({
      racerId,
      totalS,
      passes: totalS.map((value) => (value === 0 ? 0 : 1)),
    })),
  });

  it('reports a gain as negative and a loss as positive', () => {
    const heat = buildSegmentHeat(
      timingFor({ a: [9, 10, 11], b: [10, 10, 10], c: [10, 10, 10] }),
      'a',
    );
    expect(heat?.bands.map((band) => band.deltaS)).toEqual([-1, 0, 1]);
    expect(heat?.peakS).toBe(1);
  });

  it('measures against the median, so one spin does not repaint the corner', () => {
    // Four racers at 10s and one who crawled through at 40s. Against a mean the
    // whole field would look quick there; against the median nobody moves.
    const heat = buildSegmentHeat(
      timingFor({ a: [10], b: [10], c: [10], d: [10], slow: [40] }),
      'a',
    );
    expect(heat?.bands[0]?.deltaS).toBe(0);
  });

  it('says nothing about a stretch the racer never completed', () => {
    const timing = timingFor({ a: [10, 0, 0], b: [10, 10, 10], c: [10, 10, 10] });
    const heat = buildSegmentHeat(timing, 'a');
    expect(heat?.bands).toHaveLength(1);
    expect(heat?.bands[0]?.startM).toBe(0);
  });

  it('carries the road position so the map can draw it', () => {
    const heat = buildSegmentHeat(timingFor({ a: [10, 12], b: [10, 10] }), 'a');
    expect(heat?.bands[1]).toMatchObject({ startM: 100, endM: 200 });
  });

  it('returns nothing for a racer who was not in the race', () => {
    expect(buildSegmentHeat(timingFor({ a: [10] }), 'nobody')).toBeUndefined();
  });
});
