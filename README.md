# AnywhereRace

Draw a race track on a real map, configure the race, and watch a deterministic
simulation play it out — or skip to the finishing order.

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules that govern it,
and [PLACEHOLDERS.md](PLACEHOLDERS.md) for everything in this build that is a
guess rather than a decision.

## Status

You can draw a track on real streets, save it, configure a race on it, watch it,
and read the results. Everything except sharing is built and tested.

| Package | State |
|---|---|
| `packages/core` | Types, units, geo math, seeded RNG, provider interfaces + mocks |
| `packages/sim` | The deterministic race engine — 11 vehicle classes, 10 archetypes, full tick |
| `packages/track` | Routing, resampling, curvature, gradient, surface, junctions, render geometry |
| `packages/worker` | Hosts the sim in a Web Worker: playback, fast-forward, seeking |
| `packages/store` | Local-first persistence on IndexedDB |
| `packages/ui` | Race view, track builder, race setup, results |
| `apps/web` | Vite app shell — tracks, saved races, builder, setup, race view |
| `apps/cli` | Headless race runner, for tuning |

Not built: sharing — the compressed URL payload, the `simVersion` mismatch
banner for a *shared* race, and OG images.

Every external service is behind an interface with a mock implementation, and
each falls back independently at runtime. The tests never touch the network, and
the app runs with no API keys at all.

## Getting started

```bash
pnpm install
pnpm dev           # http://localhost:5173
pnpm test          # 265 tests
pnpm typecheck
pnpm lint
```

### Basemap key (optional)

Routing works without it — only the basemap tiles need a key. The app runs
without one, on a blank background, and tells you so. For a real map, put a
[MapTiler](https://cloud.maptiler.com/account/keys/) key in
`apps/web/.env.local`:

```
VITE_MAPTILER_KEY=your-key-here
```

That file is gitignored. The key ships to the browser and is therefore public —
restrict it by HTTP referrer in the MapTiler dashboard to the domains that
should use it.

## Drawing a track

`pnpm dev` opens the track list. **New track** gives you a map: click to add a
waypoint, drag one to move it, click a waypoint to remove it, Ctrl+Z to undo.
Each leg is routed as you place it against
[Valhalla](https://valhalla.github.io/valhalla/), so the route follows real
streets and respects one-way restrictions — and a leg that cannot be driven is
drawn as a dashed red line and named in the waypoint list rather than failing
quietly at save time.

Saving bakes the track at 5m resolution with real gradients and stores it in
IndexedDB, so it survives a reload and races offline. It also sweeps the route
for the places a field could come apart — climbs, pinch points, technical
sections, cobbles, and long exposed drags — which race setup shows you when you
pick a bunch-racing class. That is a read on the road, not a prediction: the
simulation does not use it, and a race may split somewhere else or never split
at all.

## Setting up a race

**Race it** on a saved track opens setup: vehicle class (filtered to those the
track's routing profile allows), laps, field size, grid order, and the seed.

Weather is either a real [Open-Meteo](https://open-meteo.com/) forecast — for
now, or for a scheduled future start — or set by hand. Either way it is **baked
into the race config at creation and never fetched again**, so a saved race
replays in the weather it was actually run in.

The roster table edits each racer's name, personality and skill, with a
randomise button and named presets you can save and reload. A preset is a
template: nothing about a race ever writes back into it.

## Watching a race

The race view opens from **Start race**: a map with the field on it, a
live timing tower, an event feed, and pause / 1x / 2x / 8x / skip-to-end. Once a
race finishes, a scrubber appears.

The feed adapts to what kind of race it is. A car or foot race is reported pass
by pass. A bike race is not — a 24-rider bunch generates around two thousand
position changes an hour, essentially all of it riders shuffling inside the same
group — so a cycling feed drops the shuffling and reports what a commentator
would instead: who attacked, who bridged, what split, what got caught. Nothing
is lost from the event log; the results page still sees every pass.

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

## Results

When the flag falls, results open over the race: classification, a generated
race report, position-by-lap and lap-time charts, sector bests with the ideal
lap nobody drove, and the incident timeline. Dismiss it and the finished race is
still there with its scrubber, so a chart can send you back to the lap it is
describing.

The report is assembled from the event log by template rather than written by a
model. A shared race has to read identically for everyone, which rules out
anything non-deterministic — and the log already carries the facts:

> Wren Jarrow won at Bloomsbury loop by 0.87s from Indi Vance. Lux Kestrel led
> away from pole; the winner started 11th. The lead changed 3 times; the one
> that stuck came on the 8th minute, past Fen Ellery. Wren Jarrow climbed 10
> places, 11th to 1st. Fastest lap went to Indi Vance, 2:05.96 on lap 4.

**Save race** stores the race as its *inputs* — track id, config, seed,
`simVersion`, `resultHash` — not as a recording. Replaying re-runs the
simulation from the seed, and if the result no longer matches what it was saved
with, it still plays and says so.

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
  core/    # shared types, units, geo math, provider interfaces + adapters
  sim/     # the deterministic race engine (no DOM, no React)
  track/   # track building: routing, resampling, curvature, gradient, surface
  worker/  # hosts the sim in a Web Worker; playback, seeking, wire protocol
  store/   # local-first persistence on IndexedDB
  ui/      # React: race view, track builder, race setup, results
apps/
  web/     # Vite app shell
  cli/     # headless race runner
```

Dependency direction is strictly `ui -> worker -> track -> sim -> core`. Never
the reverse.

The worker is its own package rather than living in `sim`: the worker entry
needs `self` and `postMessage`, and `packages/sim` importing either would break
the guarantee that it is provably headless.
