import { describe, expect, it } from 'vitest';
import { createRng } from '@anywhererace/core';
import { generateRacerNames } from '../src/racerNames';

describe('generateRacerNames', () => {
  it('returns the requested number of names', () => {
    for (const count of [1, 12, 40]) {
      expect(generateRacerNames(count, createRng('seed'))).toHaveLength(count);
    }
  });

  it('never repeats a name', () => {
    // Two racers with the same name makes the timing tower unreadable, and the
    // tower is the one place a viewer looks to work out who is winning.
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const names = generateRacerNames(40, createRng(seed));
      expect(new Set(names).size).toBe(40);
    }
  });

  it('is reproducible from the seed', () => {
    // "Randomise the field" has to be as deterministic as everything else, or
    // a shared race could not reproduce its own roster.
    expect(generateRacerNames(20, createRng('same'))).toEqual(
      generateRacerNames(20, createRng('same')),
    );
  });

  it('gives different fields for different seeds', () => {
    expect(generateRacerNames(12, createRng('one'))).not.toEqual(
      generateRacerNames(12, createRng('two')),
    );
  });

  it('produces names that read as names', () => {
    for (const name of generateRacerNames(30, createRng('shape'))) {
      expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+( \d+)?$/);
    }
  });

  it('copes with a field larger than the name pool would comfortably allow', () => {
    // The pool is a few hundred combinations; asking for far more must still
    // terminate and still return distinct names.
    const names = generateRacerNames(200, createRng('crowded'));
    expect(names).toHaveLength(200);
    expect(new Set(names).size).toBe(200);
  });
});
