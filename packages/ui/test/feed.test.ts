import { describe, expect, it } from 'vitest';
import type { GroupEventKind, RaceEvent } from '@anywhererace/sim';
import { describeEvent, eventLabel, isBroadcastable } from '../src/feed';

/**
 * What reaches the live feed.
 *
 * The rule that matters: a bunch race must not broadcast every pass. These
 * assert it from both ends — that in-bunch shuffling is dropped for cycling and
 * kept for everything else, and that nothing which is *not* a pass changes
 * behavior between the two formats.
 */

const at = <T extends RaceEvent>(event: T): T => event;

const pass = (significance: 'lead-change' | 'between-groups' | 'in-group'): RaceEvent =>
  at({
    type: 'overtake',
    tick: 100,
    atS: 5,
    racerId: 'a',
    victimId: 'b',
    forPosition: significance === 'lead-change' ? 1 : 7,
    distanceM: 1200,
    significance,
  });

const groupMove = (
  kind: GroupEventKind = 'attack',
  overrides: Partial<Extract<RaceEvent, { type: 'group' }>> = {},
): Extract<RaceEvent, { type: 'group' }> => ({
  type: 'group',
  kind,
  tick: 200,
  atS: 10,
  racerId: 'a',
  frontGroup: ['a'],
  chaseGroup: ['b', 'c'],
  gapS: 14,
  ...overrides,
});

/** Racer ids map to names; an id with no racer falls back to itself. */
const name = (id: string): string =>
  ({ a: 'Rivera', b: 'Okonkwo', c: 'Haas', d: 'Lindqvist' })[id] ?? id;

describe('isBroadcastable', () => {
  describe('in a cycling race', () => {
    it('drops shuffling inside the bunch', () => {
      expect(isBroadcastable(pass('in-group'), 'cycling')).toBe(false);
    });

    it('drops a pass between groups, because the group move already said it', () => {
      // A rider crossing from one group to another shows up as a bridge or a
      // catch; reporting the pass as well would say the same thing twice.
      expect(isBroadcastable(pass('between-groups'), 'cycling')).toBe(false);
    });

    it('keeps a pass for the lead', () => {
      expect(isBroadcastable(pass('lead-change'), 'cycling')).toBe(true);
    });

    it('keeps the group moves the race is actually told in', () => {
      expect(isBroadcastable(groupMove(), 'cycling')).toBe(true);
    });
  });

  describe('in a standard race', () => {
    it('keeps every pass, however small', () => {
      for (const significance of ['lead-change', 'between-groups', 'in-group'] as const) {
        expect(isBroadcastable(pass(significance), 'standard')).toBe(true);
      }
    });
  });

  describe('regardless of format', () => {
    const always: RaceEvent[] = [
      at({ type: 'crash', tick: 1, atS: 1, racerId: 'a', distanceM: 10, lap: 0 }),
      at({ type: 'mechanical', tick: 1, atS: 1, racerId: 'a', distanceM: 10, lap: 0 }),
      at({
        type: 'mistake',
        tick: 1,
        atS: 1,
        racerId: 'a',
        kind: 'spin',
        timeLostS: 4,
        distanceM: 10,
        causedByPassAttempt: false,
      }),
      at({ type: 'finish', tick: 1, atS: 1, racerId: 'a', position: 1, totalTimeS: 900 }),
    ];

    it('always shows incidents, retirements and finishes', () => {
      for (const event of always) {
        expect(isBroadcastable(event, 'cycling')).toBe(true);
        expect(isBroadcastable(event, 'standard')).toBe(true);
      }
    });

    const never: RaceEvent[] = [
      at({ type: 'race-start', tick: 0, atS: 0, grid: ['a', 'b'] }),
      at({
        type: 'lap',
        tick: 1,
        atS: 1,
        racerId: 'a',
        lap: 1,
        lapTimeS: 90,
        personalBest: true,
        raceBest: true,
      }),
      at({
        type: 'sector',
        tick: 1,
        atS: 1,
        racerId: 'a',
        lap: 1,
        sector: 0,
        timeS: 30,
        personalBest: true,
        raceBest: false,
      }),
      at({
        type: 'failed-pass',
        tick: 1,
        atS: 1,
        racerId: 'a',
        defenderId: 'b',
        distanceM: 10,
        timeLostS: 0.6,
      }),
      at({ type: 'race-end', tick: 9, atS: 9, reason: 'all-classified' }),
    ];

    it('never shows lap and sector crossings, which would drown everything else', () => {
      for (const event of never) {
        expect(isBroadcastable(event, 'cycling')).toBe(false);
        expect(isBroadcastable(event, 'standard')).toBe(false);
      }
    });
  });
});

describe('the copy for a group move', () => {
  const kinds: GroupEventKind[] = ['attack', 'bridge', 'split', 'catch', 'dropped'];

  it('gives every kind a label and a sentence', () => {
    for (const kind of kinds) {
      const event = groupMove(kind);
      expect(eventLabel(event)).toMatch(/^[A-Z]/);
      const sentence = describeEvent(event, name);
      expect(sentence.length).toBeGreaterThan(0);
      // A raw racer id leaking into the feed is the failure mode worth
      // guarding: it reads as a bug to anyone watching.
      expect(sentence).not.toMatch(/\b[abc]\b/);
    }
  });

  it('names the rider a move is about', () => {
    expect(describeEvent(groupMove('attack'), name)).toBe('Rivera goes clear of 2 riders');
    expect(describeEvent(groupMove('dropped'), name)).toBe(
      'Rivera comes off the back, 14s down',
    );
  });

  it('names a lone rider being bridged to, and counts a group', () => {
    expect(describeEvent(groupMove('bridge', { frontGroup: ['d'] }), name)).toBe(
      'Rivera bridges to Lindqvist',
    );
    expect(describeEvent(groupMove('bridge', { frontGroup: ['c', 'd'] }), name)).toBe(
      'Rivera bridges to the 2 riders ahead',
    );
  });

  it('counts riders on both sides of a split, which is about groups not people', () => {
    const split = groupMove('split', {
      frontGroup: ['a', 'b', 'c'],
      chaseGroup: ['d'],
      gapS: 9,
    });
    expect(describeEvent(split, name)).toBe('the group splits, 3 away from 1 at 9s');
  });

  it('gets the singular right, so a feed never says "1 riders"', () => {
    const caught = groupMove('catch', { frontGroup: ['d'], chaseGroup: ['b'] });
    expect(describeEvent(caught, name)).toBe('Lindqvist caught by 1 rider');
  });

  it('labels a rider going out the back distinctly from one going clear', () => {
    expect(eventLabel(groupMove('attack'))).toBe('Attack');
    expect(eventLabel(groupMove('dropped'))).toBe('Dropped');
  });
});
