import type { Rng } from '@anywhererace/core';

/**
 * Names for a randomised field.
 *
 * PLACEHOLDER: two small invented word lists combined. They are deliberately
 * not real people's names, and they are deliberately not nationality-flavoured
 * — a generator that quietly assigns everyone names from one culture is a
 * choice, and not one worth making by accident.
 *
 * Drawn from the race's seeded RNG, so "randomise the field" is reproducible
 * from the seed like everything else.
 */

const FIRST = [
  'Ash', 'Bex', 'Cato', 'Dex', 'Elia', 'Fen', 'Gale', 'Hollis', 'Indi', 'Jory',
  'Kit', 'Lux', 'Mio', 'Nova', 'Oren', 'Pax', 'Quill', 'Rune', 'Sol', 'Tave',
  'Umber', 'Vale', 'Wren', 'Xen', 'Yara', 'Zeph', 'Bri', 'Corin', 'Darel', 'Echo',
] as const;

const LAST = [
  'Ashby', 'Barrow', 'Calder', 'Drake', 'Ellery', 'Fairhurst', 'Grimm', 'Hale',
  'Ives', 'Jarrow', 'Kestrel', 'Larkin', 'Mercer', 'Nash', 'Orsini', 'Pike',
  'Quarry', 'Roscoe', 'Sable', 'Thorn', 'Underwood', 'Vance', 'Wexler', 'Yates',
] as const;

/**
 * `count` distinct names. Distinct matters more than it looks: two racers
 * called the same thing makes the timing tower unreadable, which is the one
 * place a viewer looks to work out who is winning.
 */
export const generateRacerNames = (count: number, rng: Rng): string[] => {
  const used = new Set<string>();
  const names: string[] = [];

  for (let i = 0; i < count; i++) {
    let name = '';
    // The pool is 30 x 24, so a collision is unlikely even at 40 racers, but
    // "unlikely" is not "never" and the fallback keeps it deterministic.
    for (let attempt = 0; attempt < 12 && (name === '' || used.has(name)); attempt++) {
      name = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
    }
    if (used.has(name)) name = `${name} ${i + 1}`;
    used.add(name);
    names.push(name);
  }
  return names;
};
