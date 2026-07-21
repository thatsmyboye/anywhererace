# AnywhereRace — CLAUDE.md

## What this is

AnywhereRace lets a user draw a race track on top of a real map, configure the race
(vehicles, weather, field size, racer personalities), and then watch a deterministic
simulation play out in real time — or skip to the finishing order.

There is no human-controlled racer. Every participant is simulated. The user is a
race director / spectator, not a driver.

**Repo:** `github.com/thatsmyboye/anywhererace`

---

## Non-negotiable architectural rules

Read these before writing any code. Violating them causes rework.

1. **The simulation is a pure, headless, deterministic TypeScript module.**
   `packages/sim` has zero imports from React, the DOM, `window`, `Date.now()`,
   or `Math.random()`. It takes a config + seed, and produces identical output every
   time. This is what makes "watch live" and "fast-forward" the same code path.

2. **All randomness flows through an injected seeded PRNG.** Use a single
   `Rng` instance created from the race seed, passed down explicitly. No module-level
   RNG. Each racer gets a derived sub-stream (`rng.fork(racerId)`) so adding a racer
   doesn't perturb everyone else's results.

3. **Fixed timestep, decoupled from rendering.** The sim ticks at a fixed
   `SIM_HZ = 20` (50ms). Rendering interpolates between ticks. "Real time" = 1 tick
   per 50ms wall clock; "2x" = 2 ticks; "fast-forward" = run all ticks in a tight
   loop until race end. Never make timestep depend on frame rate.

4. **The sim runs in a Web Worker.** The main thread never blocks. Fast-forwarding a
   50-lap race must not freeze the UI.

5. **Racers move in 1D along the route.** Position is `distanceAlongRoute` (meters) plus
   a `lateralOffset` (meters from centerline) for overtaking and visual separation.
   Do not attempt 2D physics. The map polyline is the world.

6. **The race produces an event log, not just a result.** Every tick emits compact
   state; notable moments emit typed events (overtake, mistake, crash, DNF, lap, sector,
   personal best). Replay = re-reading the log. This gives us commentary, timelines, and
   shareable results for free.

---

## Stack

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript, strict mode | `noUncheckedIndexedAccess` on |
| Build | Vite + pnpm workspaces | |
| UI | React 18 + Tailwind | |
| Map render | MapLibre GL JS | Free, vector tiles, no Mapbox billing |
| Tiles | Protomaps or MapTiler free tier | Swappable behind `TileProvider` |
| Routing / snap-to-route | **Valhalla** (self-hosted or FOSSGIS public) | Behind `RoutingProvider` interface. Chosen over OSRM because we need multiple travel profiles *and* turn restrictions in one engine — see "Routing profiles" below |
| Elevation | Open-Topo-Data / OpenTopoData SRTM | Cached per track, never re-fetched |
| Weather | Open-Meteo | Free, no key, forecast + historical |
| Persistence | IndexedDB (Dexie) local-first; Supabase optional for sync/sharing | Sim must work fully offline once a track is saved |
| Testing | Vitest | Determinism golden tests are mandatory |
| Charts | Recharts | Lap times, gaps, position chart |

Every external service sits behind an interface in `packages/core/providers/` with a
mock implementation. Tests never hit the network.

---

## Package layout

```
packages/
  core/      # shared types, units, geo math, provider interfaces
  sim/       # the deterministic race engine (no DOM, no React)
  track/     # track building: routing, resampling, curvature, gradient, surface
  worker/    # hosts the sim in a Web Worker; playback, seeking, the wire protocol
  store/     # local-first persistence on IndexedDB (Dexie)
  ui/        # React app: editor, race view, results
apps/
  web/       # Vite app shell
  cli/       # headless race runner, for tuning the sim without a UI
```

Dependency direction is strictly `ui -> worker -> track -> sim -> core`, with
`store` alongside `worker`. Never the reverse.

`packages/worker` exists because the worker entry point needs `self` and
`postMessage`, which `packages/sim` must never import — putting it there would
break the rule that the sim is provably headless. Keeping it separate also
means the playback engine (`RaceSession`) is unit-testable in Node against a
fake clock, with the worker file itself reduced to a twenty-line adapter.

`packages/store` is separate from `ui` because persistence is not a rendering
concern, and keeping it apart lets it be tested against `fake-indexeddb` with no
React involved.

`apps/cli` exists because the simulation had to be watchable long before there
was a map to watch it on. It is still the fastest way to judge a tuning change.

---

## Domain model

### Track

A track is built from user-placed waypoints, snapped to real roads/paths, then baked.

```ts
type Track = {
  id: string;
  name: string;
  mode: 'circuit' | 'point-to-point';
  routingProfile: RoutingProfile;  // what this route is legal for — see below
  waypoints: LatLng[];          // user-editable source of truth
  polyline: LatLng[];           // snapped route from RoutingProvider
  nodes: TrackNode[];           // BAKED — regenerate whenever polyline changes
  lengthMeters: number;
  startLine: number;            // distance along route
  finishLine: number;
  sectors: number[];            // distances splitting the lap into 3 sectors
};

type TrackNode = {
  distance: number;             // meters from start
  lat: number; lng: number;
  bearing: number;              // degrees
  curvatureRadius: number;      // meters; Infinity on straights
  gradient: number;             // rise/run, signed
  surface: SurfaceType;         // 'asphalt' | 'concrete' | 'gravel' | 'dirt' | 'cobble' | 'trail' | 'sand' | 'grass'
  surfaceConfidence: 'tagged' | 'inferred';
  widthMeters: number;          // drives how many racers can run side-by-side
  junctionPenalty: number;      // 0–1 speed cap from turn restrictions, signals, stops
  elevation: number;
};
```

**Baking rule:** resample the polyline to a uniform 5m spacing before computing
curvature. Raw OSM geometry has wildly uneven vertex density and will produce garbage
corner radii. Compute radius via circumscribed circle over a 3-point window at ±15m,
then smooth with a rolling median to kill GPS noise spikes.

Circuit tracks must close the loop; validate that the last waypoint routes back to the
first and reject (with a clear UI message) if it can't.

### Routing profiles and legality

Routes must respect **one-way streets and turn restrictions**. This is a routing-time
concern, not a sim-time one — the router refuses to produce an illegal geometry, so the
sim never has to know about it. But it has three consequences that must be handled
explicitly:

```ts
type RoutingProfile =
  | 'motor'        // one-way + turn restrictions enforced; cars, race cars
  | 'bicycle'      // contraflow bike lanes allowed; unpaved permitted
  | 'pedestrian';  // trails, footpaths, steps excluded; restrictions mostly ignored
```

1. **Circuits get much harder.** A one-way network means a closed loop must be
   traversable in a single direction. A user who drops four corners of a city block may
   find three of the four streets run the wrong way. The builder must route each leg as
   the user places it, show failures immediately at the offending leg, and offer a
   "find nearest legal loop" helper rather than failing silently at save time.

2. **Profile is chosen at track-build time, vehicle at race-setup time.** These can
   conflict. Store `routingProfile` on the track; at race setup, filter the vehicle list
   to classes compatible with it, and if the user picks an incompatible one, offer to
   re-route the track under the new profile (which may change its length and shape —
   warn clearly, and treat the result as a new track version).

3. **Turn restrictions imply a cost.** Where the router reports a sharp turn or a
   junction with signals/stops, mark the node so the sim applies a slow-down. A route
   that's legal but full of right-angle turns should *feel* like it.

### Off-road and trail routes

First-class, not an afterthought. Trails are where the runner, gravel-bike, and rally-car
classes get interesting.

- `pedestrian` and `bicycle` profiles must allow `highway=path|track|footway|bridleway`.
- Pull OSM `surface` and `tracktype` tags through into `TrackNode.surface`; where absent,
  infer from highway type and mark `surfaceConfidence` so the UI can say "assumed."
- Trail width is usually untagged — default narrow (1.5m), which makes overtaking
  genuinely difficult. That's a feature: single-track passing should be dramatic.
- Elevation matters far more off-road. Gradient data must come from a real DEM, not from
  route geometry, and the elevation profile in the builder should be prominent.
- Expect gaps and dead ends in OSM trail data. Route failures here are normal, not bugs;
  the error message should say so and suggest moving the waypoint.

### Vehicle classes

Data-driven, defined in `packages/sim/data/vehicles.ts`. Do not hardcode vehicle
behavior in the physics — the physics reads these numbers.

```ts
type VehicleClass = {
  id: string;
  label: string;
  category: 'foot' | 'micromobility' | 'road' | 'performance' | 'motorsport';
  topSpeedKph: number;
  accelCurve: (speedKph: number) => number;   // m/s^2 available at speed
  brakingMs2: number;
  lateralGripG: number;          // drives cornering speed
  massKg: number;
  dragArea: number;              // CdA — matters for drafting
  gradientSensitivity: number;   // how much hills hurt; high for bikes/runners
  surfacePenalty: Record<SurfaceType, number>;  // 0–1 speed multiplier
  enduranceModel: 'none' | 'stamina' | 'fuel' | 'battery';
  reliability: number;           // 0–1, per-race DNF/mechanical base rate
};
```

Launch set: runner, road cyclist, e-scooter, e-bike, city car, hot hatch, sports car,
supercar, rally car, GT racer, open-wheel racer. Aim for the *feel* to differ — an
e-scooter race should be a slow grind where hills decide everything, an open-wheeler
race should be won in the braking zones.

### Personalities

Personalities are numeric trait vectors, not enums with `switch` statements. Archetypes
are named presets over the same vector, so users can also build custom ones later.

```ts
type Traits = {
  aggression: number;        // 0–1: overtake attempt frequency
  riskTolerance: number;     // 0–1: how far past the grip limit they'll push
  consistency: number;       // 0–1: inverse of lap-to-lap variance
  racecraft: number;         // 0–1: overtake success rate, defense quality
  pacing: number;            // 0–1: 0 = go out hot and fade, 1 = negative split
  composure: number;         // 0–1: recovery after a mistake or being passed
  weatherSkill: number;      // 0–1: reduces wet/wind penalty
  draftAwareness: number;    // 0–1: how well they exploit slipstream
  ambition: number;          // 0–1: willingness to attempt low-percentage moves late
};
```

Launch archetypes (tune these to be *narratively legible* — a viewer should be able
to guess someone's personality by watching):

- **The Metronome** — high consistency, low aggression. Never fast, never slow.
- **The Charger** — high aggression + risk, low composure. Spectacular or beached.
- **The Tactician** — high racecraft + draft awareness, patient, strikes late.
- **The Front-Runner** — fast early, low pacing, fades hard.
- **The Closer** — high pacing + ambition. Buried at half distance, terrifying at the end.
- **The Rookie** — low racecraft, low composure, high variance. Mistakes compound.
- **The Veteran** — high composure and weatherSkill, capped top-end pace.
- **The Wildcard** — every trait re-rolled per race from a wide distribution.
- **The Choker** — strong until they're leading, then composure penalty kicks in.
- **The Showboat** — high aggression, deliberately loses time when comfortably clear.

Each racer's *base skill* (a single 0–1 scalar) is separate from personality. Personality
shapes the shape of the performance curve; skill scales it. Two Chargers with different
skill should still both drive like Chargers.

**Racers are stateless between races.** There is no career, no ELO, no form carried
forward, no fatigue from a previous event. Every race starts from the config alone.
Users may save a *roster template* (a named list of name/color/personality/skill rows)
to reuse a field, but that is a template, not a persistent entity — nothing about a
past race writes back into it. Do not add a `RacerCareer` table or accumulate results
against a racer id.

### Race config

```ts
type RaceConfig = {
  trackId: string;
  laps: number;                  // ignored for point-to-point
  vehicleClassId: string;        // v1: one class per race
  weather: WeatherSpec;          // 'live-forecast' | explicit conditions
  fieldSize: number;             // 2–40
  racers: RacerSpec[];           // name, color, personality, skill
  seed: string;
  gridOrder: 'random' | 'by-skill' | 'reverse-skill' | 'manual';
};
```

---

## The tick

Per racer, per tick, in this order. Keep this function readable — it is the heart of
the product and it will be tuned constantly.

1. **Target speed** = min(vehicle top speed, corner speed limit from
   `sqrt(lateralGripG * 9.81 * curvatureRadius)`, legal/practical limit for the surface).
2. **Modifiers**: gradient, surface penalty, weather (grip + drag + visibility),
   drafting bonus if within ~2s of a racer ahead, endurance state
   (stamina/fuel/battery drain), tire/tread wear where the class has it.
3. **Personality overlay**: `riskTolerance` scales the corner limit up or down;
   `pacing` sets a target effort curve across race distance; `consistency` sets the
   width of a per-tick noise term drawn from the racer's RNG stream.
4. **Traffic**: if a racer ahead is within the closing distance, either follow (dirty
   air / slower pace) or attempt a pass. Pass resolution is a probability roll from
   `racecraft`, `aggression`, speed delta, and available track width at that node.
   Failed passes cost time; badly failed passes can trigger a mistake.
5. **Incidents**: mistake chance scales with (effort above grip limit) × (1 −
   composure) × weather severity. Outcomes: minor lockup (small time loss), spin
   (large loss), crash (DNF). Mechanical DNF rolls against `reliability`.
6. **Integrate**: apply accel/brake toward target speed, advance
   `distanceAlongRoute`, update lateral offset, check line crossings, emit events.

Everything in step 2–5 must be individually toggleable via a debug panel so we can
isolate why a race felt wrong.

---

## Weather

`WeatherSpec` is either `{ kind: 'live', at: ISOTimestamp }` (fetched from Open-Meteo
for the track's centroid and baked into the race config at creation time) or
`{ kind: 'manual', ... }`.

Effects: precipitation reduces grip and visibility; temperature affects grip and
endurance drain; wind is directional and interacts with each node's `bearing` — a
headwind on the back straight should be a real, visible tactical factor, especially for
bikes and runners. Weather may change during long races if the forecast does; interpolate.

**Bake weather into the race config at race creation.** A saved race must replay
identically a year later, so never re-fetch weather at replay time.

---

## Rendering racers

Recommendation, in priority order:

1. **Base layer:** a rounded marker per racer with a solid team color, the racer's
   number, and a short name label that fades in when zoomed past a threshold.
2. **Colorblind safety:** color alone is not enough at 20+ racers. Pair each color with
   a pattern (solid / stripe / dot / halo ring) so any two adjacent racers differ on two
   channels. Generate palettes from an OkLCH ramp for even perceptual spacing.
3. **Vehicle silhouette:** small SVG icon per vehicle category, rotated to the node
   bearing. Cheap, and instantly communicates what kind of race this is.
4. **Motion cues:** a short trailing tail whose length scales with speed; a brief
   flash/shake on incidents; lateral offset animated so overtakes are legible rather
   than markers teleporting past each other.

Render markers as a MapLibre GL symbol/canvas layer, not DOM elements — 40 DOM markers
at 60fps will not hold up. Interpolate positions between sim ticks; do not render at
sim rate.

**Also always on screen:** a live timing tower (position, gap to leader, gap to car
ahead, last lap), because for most of a race the map alone doesn't tell you who's
winning.

---

## UI flow

1. **Track builder** — click to drop waypoints, drag to adjust, snapped route drawn
   live. Show length, elevation profile, and detected corner count. Toggle
   circuit/point-to-point. Undo/redo. Save.
2. **Race setup** — vehicle class, laps, weather, field size, then a racer roster table
   where each row is name / color / personality / skill, with a "randomize field" button
   and the ability to save the roster as a reusable template.
3. **Race view** — map, timing tower, speed controls (pause, 1x, 2x, 8x, skip to end),
   scrubber once the race is complete.
4. **Results** — finishing order and times, lap chart, position-over-time chart,
   sector bests, incident timeline, and a short generated race narrative built from the
   event log.

---

## Sharing and replay

A race must be reproducible by anyone from a link. Because the sim is deterministic,
the shared payload is tiny — we share **inputs, not recordings**.

```ts
type SharedRace = {
  schemaVersion: number;
  simVersion: string;      // semver of packages/sim
  track: Track;            // waypoints + routingProfile only; nodes are re-baked
  config: RaceConfig;      // includes seed and baked weather
  resultHash: string;      // hash of the finishing order + times at publish time
};
```

Rules:

- **Never re-fetch anything at replay time.** Weather is already baked into the config.
  Routing must be re-derived — so pin the router response by storing the snapped
  `polyline` alongside the waypoints. If OSM changes under us, an old link must still
  replay the old road layout.
- **`simVersion` is load-bearing.** Any change to the tick, the vehicle data, or the
  personality traits changes results. On opening a shared race, compare `simVersion` and
  recompute `resultHash`. If it doesn't match, still play the race but show an honest
  banner: "This race was created with an earlier version of the simulation; results may
  differ." Do not silently pretend it's the same race, and do not refuse to open it.
- Keep the payload URL-safe where it fits (compress + base64 the JSON), falling back to
  a Supabase-stored short link for large tracks. Shared races are immutable — opening one
  gives the viewer a read-only copy they can fork, never an edit handle on the original.
- Shared links are the main growth mechanism, so the results page needs OG image
  metadata: track shape, winner, margin.

## Commands

```bash
pnpm install
pnpm dev             # vite dev server
pnpm build           # static production bundle
pnpm test            # vitest
pnpm test:determinism # golden-seed regression suite
pnpm typecheck
pnpm lint
pnpm race            # headless race runner; --help for options
```

### External services

All three are optional at runtime and each falls back independently:

| Service | Used for | Without it |
|---|---|---|
| MapTiler (`VITE_MAPTILER_KEY`) | basemap | blank background, app still works |
| Valhalla (FOSSGIS public) | snapping routes to real roads | synthetic geometry, flagged in the UI |
| Open-Topo-Data | real gradients | synthetic hills, flagged in the UI |
| Open-Meteo | the real forecast, baked at race creation | dry and still, flagged in the UI |

Only MapTiler needs a key: put it in `apps/web/.env.local` (gitignored; see
`apps/web/.env.example`). It ships to the browser and so is public — restrict it
by HTTP referrer in the MapTiler dashboard.

**The fallback never covers up a real answer.** "No route exists between these
two points" is the router doing its job — usually a one-way street — and it is
shown to the user. Only an outage, a timeout or a rate limit degrades to the
mock, and when it does, the track records which service was synthetic so the
track list can say so.

---

## Testing expectations

- **Determinism golden tests are mandatory.** A fixed seed + config must produce a
  byte-identical result hash. Any sim change that alters golden output requires
  deliberately regenerating the goldens in the same commit, with the reason in the
  message.
- Sim tests are headless and fast; no map, no network.
- Property tests on the track baker: resampled polylines preserve length within 0.5%;
  curvature is finite and positive; gradients stay within plausible bounds.
- Sanity ranges: a road cyclist on a flat 40km course should finish in roughly 60–70
  minutes. If the sim says 20, the physics is wrong. Keep a table of these expectations
  and assert against them.

---

## Conventions

- US English spelling throughout, including in code identifiers and UI copy.
- SI units internally (meters, m/s, seconds, kelvin-free celsius). Convert only at the
  UI boundary. Suffix ambiguous variables: `speedMs`, `distanceM`, `lapTimeS`.
- Named exports only. No default exports.
- Errors are typed results in the sim (`Result<T, SimError>`); exceptions only at the
  app boundary.
- No `any`. No `@ts-ignore` without an adjacent comment explaining why.
- Comments explain *why* a magic number exists, especially tuning constants. Every
  tuning constant lives in a named, documented config object, never inline.

---

## Explicitly out of scope for v1

Don't build these without being asked: human-controlled racers, multiplayer, mixed
vehicle classes in one race, racer careers or championships, pit stops and tire
strategy, day/night cycle, 3D terrain view, monetization. Several are good v2
candidates — note them in `IDEAS.md` rather than implementing them.

Two of these have been explicitly ruled out rather than deferred, so don't design
around them "just in case": **persistent racer careers** and **human-controlled
racers**.

---

## Open decisions

These are unresolved. Ask before assuming:

- Whether posted speed limits should cap non-racing vehicle classes (one-way and turn
  restrictions are in; speed limits currently are not).
- Whether shared races are public-by-default or unlisted-by-link.
- How to handle a shared track whose route no longer exists in current OSM data when a
  viewer tries to *fork and edit* it.

### Resolved

- **Race setup design.** One scrolling page rather than a wizard, because the
  settings interact — the routing profile filters the vehicle list, vehicle and
  laps decide the race duration and therefore how much forecast to fetch, and
  field size drives the roster. Incompatible vehicle classes are filtered out
  with a line naming them and explaining what would allow them. Roster colours
  come from the OkLCH palette by position rather than being user-chosen, so the
  two-channel colourblind guarantee cannot be broken by accident.
- **Race view design.** Map-dominant layout with a translucent timing tower and
  event feed floating over it; camera fits the whole track and then leaves the
  user alone; racers are drawn as an OkLCH-spaced colour plus a ring pattern
  plus a number, so any two are distinguishable on two channels; dark theme
  only. Auto-follow camera modes are noted in `IDEAS.md` rather than built.
- **"Real forecast" means both, defaulting to now.** A race bakes the forecast for
  the moment it was created unless the user picks a scheduled future start, in which
  case it bakes the forecast for that instant. `WeatherSpec`'s `live` variant stores
  `fetchedAt` and `startsAt` separately for exactly this reason, alongside the sampled
  timeline. Either way the weather is baked once and never re-fetched at replay time.
  Both are built: race setup defaults to the forecast for now, with a
  scheduled-start picker, and `beyond-forecast-horizon` is surfaced as a message
  telling the user to pick a nearer start or set the weather by hand.
