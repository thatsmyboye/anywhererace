import { describe, expect, it } from 'vitest';
import { createRng } from '@anywhererace/core';
import { NAME_GROUPS, generateRacerNames } from '../src/racerNames';

/** One token of a name: a capital then one or more lowercase ASCII letters. */
const TOKEN = /^[A-Z][a-z]+$/;

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
    // The pool is thousands of combinations; asking for far more must still
    // terminate and still return distinct names.
    const names = generateRacerNames(200, createRng('crowded'));
    expect(names).toHaveLength(200);
    expect(new Set(names).size).toBe(200);
  });
});

describe('the name pool', () => {
  it('holds only plain ASCII tokens — no diacritics, hyphens or apostrophes', () => {
    // Sampling generated names would only catch a bad token by luck; every entry
    // in every tradition has to satisfy the marker-label and name-shape contract.
    for (const group of NAME_GROUPS) {
      for (const token of [...group.given, ...group.family]) {
        expect(token, `${group.label}: "${token}"`).toMatch(TOKEN);
      }
    }
  });

  it('gives every tradition enough combinations to matter', () => {
    // A tradition with a handful of names would collapse to the numbered
    // fallback in any real field. Each should offer well over a full grid.
    for (const group of NAME_GROUPS) {
      expect(group.given.length * group.family.length, group.label).toBeGreaterThan(40);
    }
  });

  it('pairs a given and family name from within one tradition', () => {
    // The rule the expansion exists to keep: the two halves of a name are never
    // crossed between cultures. Every generated name must be reconstructable
    // from a single group's lists.
    const names = generateRacerNames(120, createRng('pairing'));
    for (const name of names) {
      const [given, family] = name.split(' ');
      const coherent = NAME_GROUPS.some(
        (group) => group.given.includes(given ?? '') && group.family.includes(family ?? ''),
      );
      expect(coherent, name).toBe(true);
    }
  });
});
