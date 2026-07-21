import type { Rng } from '@anywhererace/core';
import { clamp01 } from '@anywhererace/core';

/**
 * Personality is a numeric vector, never an enum with a switch. Archetypes are
 * named presets over the same vector, which is what will let users build custom
 * personalities later without touching the tick.
 */
export type Traits = {
  /** 0-1: overtake attempt frequency. */
  aggression: number;
  /** 0-1: how far past the grip limit they will push. */
  riskTolerance: number;
  /** 0-1: inverse of lap-to-lap variance. */
  consistency: number;
  /** 0-1: overtake success rate and defense quality. */
  racecraft: number;
  /** 0-1: 0 = go out hot and fade, 1 = negative split. */
  pacing: number;
  /** 0-1: recovery after a mistake or after being passed. */
  composure: number;
  /** 0-1: reduces wet and wind penalties. */
  weatherSkill: number;
  /** 0-1: how well they exploit slipstream. */
  draftAwareness: number;
  /** 0-1: willingness to attempt low-percentage moves late in the race. */
  ambition: number;
};

/**
 * Situational modifiers.
 *
 * EXTENSION beyond the nine traits in CLAUDE.md. Three of the launch archetypes
 * — the Choker, the Showboat and the Veteran — are defined by behavior that is
 * conditional on race state rather than by a constant tendency, and there is no
 * honest way to express "strong until they are leading" as a scalar tendency.
 * These stay numeric and apply to every racer (almost always at zero), so the
 * no-switch-statements rule still holds.
 */
export type SituationalModifiers = {
  /** 0-1: composure lost while running P1. The Choker. */
  leadingComposurePenalty: number;
  /** 0-1: effort given up when comfortably clear of the field. The Showboat. */
  comfortableLeadEasing: number;
  /** 0-1 multiplier capping outright pace regardless of skill. The Veteran. */
  paceCeiling: number;
  /** 0-1: width of the per-race re-roll applied to every trait. The Wildcard. */
  rerollSpread: number;
};

export type Personality = {
  id: string;
  label: string;
  /** One-line description, shown in the roster editor. */
  blurb: string;
  traits: Traits;
  modifiers: SituationalModifiers;
};

const NO_MODIFIERS: SituationalModifiers = {
  leadingComposurePenalty: 0,
  comfortableLeadEasing: 0,
  paceCeiling: 1,
  rerollSpread: 0,
};

const personality = (
  id: string,
  label: string,
  blurb: string,
  traits: Traits,
  modifiers: Partial<SituationalModifiers> = {},
): Personality => ({
  id,
  label,
  blurb,
  traits,
  modifiers: { ...NO_MODIFIERS, ...modifiers },
});

/**
 * The launch archetypes. Tuned to be narratively legible: a viewer who watches
 * a full race should be able to guess who is who without reading the roster.
 *
 * These vectors are a first pass and are the most likely thing in the sim to
 * need adjusting once races are actually watchable.
 */
export const ARCHETYPES: readonly Personality[] = [
  personality(
    'metronome',
    'The Metronome',
    'Never fast, never slow. Wins races other people lose.',
    {
      aggression: 0.2,
      riskTolerance: 0.25,
      consistency: 0.95,
      racecraft: 0.55,
      pacing: 0.5,
      composure: 0.8,
      weatherSkill: 0.6,
      draftAwareness: 0.5,
      ambition: 0.25,
    },
  ),
  personality(
    'charger',
    'The Charger',
    'Spectacular or beached. Usually both, in that order.',
    {
      aggression: 0.95,
      riskTolerance: 0.9,
      consistency: 0.35,
      racecraft: 0.6,
      pacing: 0.2,
      composure: 0.3,
      weatherSkill: 0.45,
      draftAwareness: 0.5,
      ambition: 0.85,
    },
  ),
  personality(
    'tactician',
    'The Tactician',
    'Sits in the tow, says nothing, arrives at the end.',
    {
      aggression: 0.45,
      riskTolerance: 0.45,
      consistency: 0.8,
      racecraft: 0.9,
      pacing: 0.7,
      composure: 0.8,
      weatherSkill: 0.65,
      draftAwareness: 0.95,
      ambition: 0.6,
    },
  ),
  personality(
    'front-runner',
    'The Front-Runner',
    'Leads from the gun. Ask again at three-quarter distance.',
    {
      aggression: 0.75,
      riskTolerance: 0.6,
      consistency: 0.55,
      racecraft: 0.6,
      pacing: 0.1,
      composure: 0.5,
      weatherSkill: 0.5,
      draftAwareness: 0.4,
      ambition: 0.5,
    },
  ),
  personality(
    'closer',
    'The Closer',
    'Buried at half distance. Terrifying at the end.',
    {
      aggression: 0.5,
      riskTolerance: 0.5,
      consistency: 0.75,
      racecraft: 0.75,
      pacing: 0.95,
      composure: 0.75,
      weatherSkill: 0.6,
      draftAwareness: 0.8,
      ambition: 0.9,
    },
  ),
  personality(
    'rookie',
    'The Rookie',
    'High variance, low ceiling. Mistakes compound.',
    {
      aggression: 0.55,
      riskTolerance: 0.65,
      consistency: 0.3,
      racecraft: 0.2,
      pacing: 0.45,
      composure: 0.25,
      weatherSkill: 0.25,
      draftAwareness: 0.3,
      ambition: 0.5,
    },
  ),
  personality(
    'veteran',
    'The Veteran',
    'Unflappable, and unbothered by the weather. Just not quite quick enough.',
    {
      aggression: 0.4,
      riskTolerance: 0.35,
      consistency: 0.85,
      racecraft: 0.85,
      pacing: 0.6,
      composure: 0.95,
      weatherSkill: 0.9,
      draftAwareness: 0.75,
      ambition: 0.35,
    },
    // The capped top end is the whole character: they never have the legs, so
    // they have to win on composure and craft instead.
    { paceCeiling: 0.97 },
  ),
  personality(
    'wildcard',
    'The Wildcard',
    'Rerolled every race. Nobody knows, including them.',
    {
      aggression: 0.5,
      riskTolerance: 0.5,
      consistency: 0.5,
      racecraft: 0.5,
      pacing: 0.5,
      composure: 0.5,
      weatherSkill: 0.5,
      draftAwareness: 0.5,
      ambition: 0.5,
    },
    { rerollSpread: 0.9 },
  ),
  personality(
    'choker',
    'The Choker',
    'Immaculate in second. Comes apart in first.',
    {
      aggression: 0.5,
      riskTolerance: 0.5,
      consistency: 0.8,
      racecraft: 0.75,
      pacing: 0.55,
      composure: 0.7,
      weatherSkill: 0.6,
      draftAwareness: 0.65,
      ambition: 0.5,
    },
    { leadingComposurePenalty: 0.7 },
  ),
  personality(
    'showboat',
    'The Showboat',
    'Fights like a dog for the lead, then throws the time away enjoying it.',
    {
      aggression: 0.9,
      riskTolerance: 0.7,
      consistency: 0.5,
      racecraft: 0.7,
      pacing: 0.4,
      composure: 0.55,
      weatherSkill: 0.5,
      draftAwareness: 0.6,
      ambition: 0.75,
    },
    { comfortableLeadEasing: 0.6 },
  ),
];

const ARCHETYPE_BY_ID = new Map(ARCHETYPES.map((p) => [p.id, p]));

export const getArchetype = (id: string): Personality | undefined => ARCHETYPE_BY_ID.get(id);

export const TRAIT_KEYS = [
  'aggression',
  'riskTolerance',
  'consistency',
  'racecraft',
  'pacing',
  'composure',
  'weatherSkill',
  'draftAwareness',
  'ambition',
] as const satisfies readonly (keyof Traits)[];

/**
 * Apply a personality's per-race re-roll. Only the Wildcard has a non-zero
 * spread; for everyone else this returns the traits unchanged.
 *
 * Drawn from the racer's own forked stream, so a Wildcard in the field does not
 * shift anybody else's race.
 */
export const rollTraits = (personality: Personality, rng: Rng): Traits => {
  const spread = personality.modifiers.rerollSpread;
  if (spread <= 0) return personality.traits;

  const rolled = { ...personality.traits };
  for (const key of TRAIT_KEYS) {
    // Uniform across a window centered on the archetype value, clipped to
    // [0,1]. Uniform rather than normal on purpose — a Wildcard should
    // genuinely land at the extremes sometimes.
    rolled[key] = clamp01(personality.traits[key] + rng.range(-spread, spread));
  }
  return rolled;
};
