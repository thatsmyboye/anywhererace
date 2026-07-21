import { describe, expect, it } from 'vitest';
import { createRng } from '../src/rng';

describe('Rng', () => {
  it('produces the same stream for the same seed', () => {
    const a = createRng('seed-a');
    const b = createRng('seed-a');
    const drawsA = Array.from({ length: 100 }, () => a.next());
    const drawsB = Array.from({ length: 100 }, () => b.next());
    expect(drawsB).toEqual(drawsA);
  });

  it('produces a different stream for a different seed', () => {
    const a = createRng('seed-a');
    const b = createRng('seed-b');
    expect(b.next()).not.toBe(a.next());
  });

  it('stays within [0, 1)', () => {
    const rng = createRng('bounds');
    for (let i = 0; i < 10_000; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('is roughly uniform', () => {
    const rng = createRng('uniformity');
    const buckets = new Array<number>(10).fill(0);
    const samples = 100_000;
    for (let i = 0; i < samples; i++) {
      const bucket = Math.floor(rng.next() * 10);
      buckets[bucket] = (buckets[bucket] as number) + 1;
    }
    for (const count of buckets) {
      // Within 5% of the expected tenth. A generator this broken would be
      // obvious, but a silently biased one would quietly skew every race.
      expect(count).toBeGreaterThan(samples / 10 - samples / 200);
      expect(count).toBeLessThan(samples / 10 + samples / 200);
    }
  });
});

describe('Rng.fork', () => {
  it('derives from the seed, not from the current state', () => {
    // This is the property that lets a racer be added to a field without
    // perturbing everybody else's race.
    const fresh = createRng('race-seed');
    const used = createRng('race-seed');
    for (let i = 0; i < 500; i++) used.next();

    const fromFresh = fresh.fork('racer:7');
    const fromUsed = used.fork('racer:7');

    expect(
      Array.from({ length: 20 }, () => fromUsed.next()),
    ).toEqual(Array.from({ length: 20 }, () => fromFresh.next()));
  });

  it('gives different labels independent streams', () => {
    const rng = createRng('race-seed');
    const seven = rng.fork('racer:7');
    const eight = rng.fork('racer:8');
    expect(eight.next()).not.toBe(seven.next());
  });

  it('nests without collisions', () => {
    const rng = createRng('race-seed');
    const a = rng.fork('racer:7').fork('traits');
    const b = rng.fork('racer:7').fork('race');
    expect(b.next()).not.toBe(a.next());
  });

  it('is not confused by labels that concatenate ambiguously', () => {
    const rng = createRng('s');
    // "a" + "b" must not collide with "ab" — a real hazard for any scheme that
    // joins the seed and the label without a separator.
    expect(rng.fork('a').fork('b').next()).not.toBe(rng.fork('ab').next());
  });
});

describe('Rng.normal', () => {
  it('has the requested mean and standard deviation', () => {
    const rng = createRng('normal');
    const samples = 200_000;
    let sum = 0;
    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
      const value = rng.normal(5, 2);
      sum += value;
      sumSquares += value * value;
    }
    const mean = sum / samples;
    const variance = sumSquares / samples - mean * mean;

    expect(mean).toBeCloseTo(5, 1);
    expect(Math.sqrt(variance)).toBeCloseTo(2, 1);
  });

  it('consumes a fixed number of uniforms regardless of call history', () => {
    // A cached-spare implementation would break this, and would make stream
    // position depend on how callers interleave normal() and next().
    const a = createRng('draws');
    const b = createRng('draws');
    a.normal(0, 1);
    for (let i = 0; i < 12; i++) b.next();
    expect(b.next()).toBe(a.next());
  });

  it('clamps to the requested sigma', () => {
    const rng = createRng('clamped');
    for (let i = 0; i < 5_000; i++) {
      const value = rng.normalClamped(0, 1, 2);
      expect(Math.abs(value)).toBeLessThanOrEqual(2);
    }
  });
});

describe('Rng helpers', () => {
  it('shuffles deterministically without mutating the input', () => {
    const source = ['a', 'b', 'c', 'd', 'e', 'f'];
    const a = createRng('shuffle').shuffled(source);
    const b = createRng('shuffle').shuffled(source);

    expect(b).toEqual(a);
    expect(source).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(a.slice().sort()).toEqual(source.slice().sort());
  });

  it('picks within range and throws on an empty array', () => {
    const rng = createRng('pick');
    const items = [1, 2, 3];
    for (let i = 0; i < 100; i++) expect(items).toContain(rng.pick(items));
    expect(() => rng.pick([])).toThrow();
  });

  it('honors the probability given to bool()', () => {
    const rng = createRng('bool');
    let trues = 0;
    const samples = 100_000;
    for (let i = 0; i < samples; i++) if (rng.bool(0.25)) trues += 1;
    expect(trues / samples).toBeCloseTo(0.25, 2);
  });
});
