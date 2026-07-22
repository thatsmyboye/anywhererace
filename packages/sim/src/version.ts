/**
 * Semver of the simulation itself.
 *
 * This is load-bearing for sharing. Any change to the tick, the vehicle data,
 * the archetype vectors, or the tuning constants changes race outcomes, and
 * therefore MUST bump this. A shared race whose `simVersion` differs from the
 * running build still opens and still plays — but the viewer is told, honestly,
 * that results may differ.
 *
 * Bump policy:
 *   patch — a change that provably cannot alter any golden result
 *   minor — tuning changes that alter outcomes but not the config schema
 *   major — a change to RaceConfig, Traits, or the event log shape
 */
export const SIM_VERSION = '0.6.0';
