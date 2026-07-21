# AnywhereRace

Draw a race track on a real map, configure the race, and watch a deterministic
simulation play it out — or skip to the finishing order.

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules that govern it,
and [PLACEHOLDERS.md](PLACEHOLDERS.md) for everything in this build that is a
guess rather than a decision.

## Status

Foundation only. The simulation, the track baker, and the shared core are built
and tested; there is no UI yet.

| Package | State |
|---|---|
| `packages/core` | Types, units, geo math, seeded RNG, provider interfaces + mocks |
| `packages/sim` | The deterministic race engine — 11 vehicle classes, 10 archetypes, full tick |
| `packages/track` | Routing, resampling, curvature, gradient, surface, junctions |
| `apps/cli` | Headless race runner, for tuning |
| `packages/ui`, `apps/web` | Not built |

Every external service is behind an interface with a mock implementation.
Nothing in this repo touches the network, including the tests.

## Getting started

```bash
pnpm install
pnpm test          # 119 tests
pnpm typecheck
pnpm lint
```

## Watching a race

There is no map yet, so the CLI is how you see what the sim is doing. It builds
a track from the mock providers, runs a race, and prints the classification, lap
chart, incident timeline, and result hash.

```bash
pnpm race                                     # defaults: cyclists, 3 laps
pnpm race --list                              # vehicle classes and personalities
pnpm race --vehicle gt-racer --laps 5 --rain 3
pnpm race --vehicle e-scooter --size 2000     # hills decide everything
pnpm race --help
```

Same seed, same result, every time. This tool found five real bugs in the sim
during its first hour of existence; use it before trusting a tuning change.

## The rules that matter

Three properties are load-bearing, and breaking any of them is a rework, not a
bug:

**The sim is pure and deterministic.** `packages/sim` imports no React, no DOM,
no `window`, no `Date.now()`, no `Math.random()`. Two tests enforce this by
scanning the source, and the lint config bans the imports outright.

Determinism goes further than avoiding `Math.random`: `Math.sin`, `Math.log` and
`Math.pow` are all *implementation-approximated* in the ECMAScript spec, so two
engines may legally disagree in the last bit. Every one of them is confined to
setup and track baking, which run a bounded number of times before the race
starts. Inside the tick the only non-arithmetic operation is `Math.sqrt`.

**All randomness flows through a forkable seeded RNG.** `rng.fork(label)`
derives from the seed string, never from the current state, so adding a racer to
a field does not perturb anyone else's stream.

**Any change to the tick, the vehicle data, or the tuning constants changes
results.** Bump `SIM_VERSION` and regenerate the goldens in the same commit,
with the reason in the message. `pnpm test:determinism` is the check.

## Layout

```
packages/
  core/    # shared types, units, geo math, provider interfaces + mocks
  sim/     # the deterministic race engine (no DOM, no React)
  track/   # track building: routing, resampling, curvature, gradient, surface
apps/
  cli/     # headless race runner
```

Dependency direction is strictly `track -> sim -> core`. Never the reverse.
