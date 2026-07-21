# AnywhereRace

Draw a race track on a real map, configure the race, and watch a deterministic
simulation play it out — or skip to the finishing order.

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules that govern it,
and [PLACEHOLDERS.md](PLACEHOLDERS.md) for everything in this build that is a
guess rather than a decision.

## Status

You can watch a race. The simulation, the track baker, the Web Worker host and
the race view are built and tested; the track builder and race setup screens are
not.

| Package | State |
|---|---|
| `packages/core` | Types, units, geo math, seeded RNG, provider interfaces + mocks |
| `packages/sim` | The deterministic race engine — 11 vehicle classes, 10 archetypes, full tick |
| `packages/track` | Routing, resampling, curvature, gradient, surface, junctions, render geometry |
| `packages/worker` | Hosts the sim in a Web Worker: playback, fast-forward, seeking |
| `packages/ui` | Race view — MapLibre map, timing tower, event feed, transport controls |
| `apps/web` | Vite app shell, currently loading a demo race |
| `apps/cli` | Headless race runner, for tuning |

Not built: the track builder, race setup, the results page, sharing, and
persistence.

Every external service is behind an interface with a mock implementation. The
tests never touch the network, and the app runs with no API keys at all.

## Getting started

```bash
pnpm install
pnpm dev           # http://localhost:5173
pnpm test          # 168 tests
pnpm typecheck
pnpm lint
```

### Basemap key (optional)

The app runs without one, on a blank background, and tells you so. For a real
map, put a [MapTiler](https://cloud.maptiler.com/account/keys/) key in
`apps/web/.env.local`:

```
VITE_MAPTILER_KEY=your-key-here
```

That file is gitignored. The key ships to the browser and is therefore public —
restrict it by HTTP referrer in the MapTiler dashboard to the domains that
should use it.

## Watching a race

`pnpm dev` opens the race view on a demo track: a map with the field on it, a
live timing tower, an event feed, and pause / 1x / 2x / 8x / skip-to-end. Once a
race finishes, a scrubber appears.

The CLI is the other way in, and still the fastest way to judge a tuning change.
It builds a track from the mock providers, runs a race, and prints the
classification, lap chart, incident timeline, and result hash.

```bash
pnpm race                                     # defaults: cyclists, 3 laps
pnpm race --list                              # vehicle classes and personalities
pnpm race --vehicle gt-racer --laps 5 --rain 3
pnpm race --vehicle e-scooter --size 2000     # hills decide everything
pnpm race --help
```

Same seed, same result, every time. This tool found five real bugs in the sim
during its first hour of existence; use it before trusting a tuning change.

## Deploying

`pnpm build` produces a static bundle in `apps/web/dist` with no server runtime.
Asset URLs are relative, so the same build works from a domain root, a
subdirectory, or a preview URL without rebuilding — copy `dist/` to any static
host.

The simulation worker is emitted as its own chunk, and MapLibre is split out
separately so an app update does not force visitors to re-download the map
engine.

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
  worker/  # hosts the sim in a Web Worker; playback, seeking, wire protocol
  ui/      # React race view: map, timing tower, event feed, controls
apps/
  web/     # Vite app shell
  cli/     # headless race runner
```

Dependency direction is strictly `ui -> worker -> track -> sim -> core`. Never
the reverse.

The worker is its own package rather than living in `sim`: the worker entry
needs `self` and `postMessage`, and `packages/sim` importing either would break
the guarantee that it is provably headless.
