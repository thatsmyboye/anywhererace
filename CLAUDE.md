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
   personal best, group move). Replay = re-reading the log. This gives us commentary,
   timelines, and shareable results for free.

   The log is written whole and filtered at the edges. Nothing decides *not to record*
   something because a particular screen would not show it — the results page, the
   charts and the race report all read the full log, and a filter applied at write time
   would be unrecoverable. Deciding what a viewer sees is the reader's job. See "Race
   formats, and how a race is told".

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
| Place search | Nominatim (OSM) | Behind `GeocodingProvider`. Towns and countries only, never streets or landmarks — it exists to point the map at where you want to draw. Alone among the providers it has **no fallback**; see below |
| Elevation | **Open-Meteo elevation** (Copernicus GLO-90) | Cached per track, never re-fetched. Open-Topo-Data's SRTM 30m is the better dataset and sends no CORS headers, so it cannot be called from a browser at all — see `openmeteo-elevation.ts` |
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
  separationPoints?: SeparationPoint[];  // BAKED — see "Separation points"
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

### Separation points

When a course is created, a fast sweep runs over the baked nodes looking for stretches
of road where a field could come apart — climbs, pinch points, technical sections, rough
surfaces, and long exposed drags. It lives in `packages/track/src/separation.ts` and runs
inside `bakeRoutedTrack`, which is the one place every course passes through.

```ts
type SeparationKind = 'climb' | 'narrows' | 'technical' | 'surface' | 'exposed';

type SeparationPoint = {
  startM: number;
  endM: number;          // always > startM; may exceed lap length if it wraps the line
  kind: SeparationKind;
  severity: number;      // 0-1, for ranking within one course only
  detail: SeparationDetail | string;  // the measurements; see below
};
```

Five rules govern it:

1. **It is an observation about the road, not a prediction about a race.** It says where
   a field *could* come apart, never where one will. The sim does read it — `profile.ts`
   flattens the points into a per-node `attackAppeal` and racers roll against it to
   choose where to attack — but that is a reason to go, not an instruction to split, and
   two races over the same course will not necessarily break up in the same places or at
   all. It sits in the same family as corner count and total climb. The UI copy must not
   promise otherwise.

   Because the sim reads it, the thresholds are now load-bearing: changing one moves race
   results and the determinism goldens with them. That was not true when the sweep
   shipped.
2. **The thresholds are calibrated for road cycling**, because that is the format the
   question is asked about and because it is the strictest case — a bunch of cyclists
   holds together through things that would already have strung out a field of cars.
   All of them live in `SEPARATION` in `packages/track/src/constants.ts`.
3. **It cannot see the weather.** The sweep runs when the course is saved, long before a
   race bakes a forecast. The one kind that depends on conditions — `exposed`, meaning a
   long constant-bearing stretch that would echelon in a crosswind — has a capped
   severity and says "if there is a crosswind" in its own copy rather than pretending.
4. **`undefined` and `[]` mean different things.** Absent means the course predates the
   sweep; empty means it was analyzed and the road is flat, wide and smooth. Never
   collapse the two — telling a user a course has no selection points when nobody ever
   looked is a lie the UI can easily tell by accident.
5. **It emits measurements, not prose.** `detail` carries the numbers behind the point —
   mean gradient and height gained, tightest width, feature count, surface — and the
   sentence is assembled at render time by `describeSeparation` in `packages/ui`. A
   course is baked once and has to read correctly for someone in miles and someone in
   kilometers, which a string frozen at bake time cannot do. The bare `string` arm is
   the pre-toggle shape, still in browsers that saved a track before this changed;
   those render verbatim, in the metric they were baked in, and nothing writes a new
   one.

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
  raceFormat: 'cycling' | 'standard';  // how a race of this class is *narrated*
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

### Race formats, and how a race is told

`raceFormat` on a vehicle class decides how a race is *narrated*. It changes nothing
about physics, incidents, or results — both formats run the identical tick, and
switching a class between them would not move a single finishing time.

What it changes is what reaches the viewer. A motor race is told pass by pass and every
pass is worth showing. A bunch race is not: a 24-rider peloton produces around two
thousand position changes in an hour, essentially all of them riders shuffling inside the
same group. Broadcasting those is broadcasting noise, and it buries the twenty-odd
moments that decide the race. So a cycling race is told in **groups** — who attacked, who
bridged, what split, what came back together.

`'cycling'` is set on `road-cyclist` and `e-bike`, and deliberately not derived from
`category` or `draftBenefit`: category would sweep in the e-scooter, which shares
`micromobility` but at `draftBenefit: 0.2` never forms a bunch; a `draftBenefit`
threshold would sweep in the open-wheel racer, which tows hard but races one car at a
time.

**Narration groups are observation, not behavior.** `packages/sim/src/groups.ts` derives
which racers are riding together, purely from distances and speeds. It never touches an
`Rng`, nothing in the tick consults it, and deleting it would not change a result — which
is also why it cannot move the determinism goldens. It produces two things:

- `GroupEvent` — `attack`, `bridge`, `split`, `catch`, `dropped`, with the groups on
  either side and the gap between them.
- `significance` on every `OvertakeEvent` — `lead-change`, `between-groups`, or
  `in-group`. Every pass is still logged; this only says which ones are worth saying.
  Classified in the sim because only the sim knows the field's shape.

Two mechanisms stop this generating noise, and both are load-bearing. **Hysteresis**: a
group breaks at `splitGapS` but only re-forms at the much tighter `mergeGapS`. **Confirmation**:
a new shape must survive `confirmSamples` consecutive one-second samples before it is
believed. Without hysteresis in particular, a field whose natural spacing sits near the
threshold flaps across it forever — measured on a 30-rider five-hour race, adding it took
group moves from about 1600 to under 100 without losing a real one. If you are retuning
this, `pnpm race` prints the broadcast counts; that is what it is for.

### Riding in a bunch

The **behavioral** half lives in `packages/sim/src/bunch.ts`, and unlike `groups.ts` the
tick does read it. Two modules rather than one because they answer different questions and
neither threshold suits the other job: narration wants a loose twelve-second gap and
twenty seconds of confirmation before it will believe anything, and physics can afford
neither. Keeping them apart is what lets `groups.ts` go on being provably inert.

`bunch.ts` is re-read every tick with no hysteresis, and reports per racer how many wheels
are sheltering them, how large their group is, and what pace it is riding. Four things
follow from it, and all four move every result:

- **Drafting is group-shaped.** A racer's shelter is every wheel ahead of them in an
  unbroken slipstream chain, saturating. The leader must end up with less than the riders
  behind them: that difference is the only thing in the model that ever closes a gap, and
  erasing it dissolves a peloton into individuals within ten minutes.
- **The front rotates, and the turn is real.** There was briefly a flat shelter credit
  every group member received, standing in for turns nobody took. Now the racer on the
  front rides above their own sustainable effort for a genuine turn, pays for it out of
  the reservoir, and swings off — easing until they are several wheels back into the
  group, because ending the ease as soon as one rider comes past simply puts the
  strongest rider straight back on the front. That is what lets a bunch ride faster than
  any of its members could alone. Note the honest limit: a rider *can* now be worn down
  by leading, but it does not visibly decide races, because at the front of a bunch
  "did the work" and "is ahead on the road" are the same thing. See `IDEAS.md`.
- **A group has a collective pace** — the mean speed of its members — and racers hold it
  above their own limit by up to `bunch.hangOnHeadroom`, shrinking as the reservoir
  empties. Past that they cannot, and they come off. It has to be the mean and not the
  leader's speed: read from the leader, a group's pace *is* the strongest rider's solo
  pace, and everyone slower than the headroom is dropped by construction.
- **Nothing damps a racer down toward a slower group.** That was tried and removed. It
  double-counts the traffic model, which already refuses to let a racer ride through the
  one ahead, and it stops a follower ever being quicker than the rider in front, so no
  gap is ever closed and the field ratchets apart. The saving from sitting in is booked
  as effort rather than speed: `deliveredEffort` is the ratio of achieved pace to own
  pace, uncapped in both directions, so being held up drains less of the reservoir and
  hanging on drains more. That single ratio is the whole mechanism by which a peloton
  drops people.
- **Echelons.** In a crosswind the shelter runs out at the width of the road; the rider
  past the end of it is in the gutter, with a fresh and progressively more compromised
  echelon forming behind them. Derived from the per-node wind and width, not from
  `separationPoints` — the sweep's `exposed` points describe the same roads but are not
  the input to this. It fires hard per rider and is **not** measurable in a race result,
  because the field reorganises around it; assert it on `echelonDepth` directly rather
  than through a race.
- **A dropped rider decides what to do about it.** Chase, sit up, or soft-pedal until
  the group behind arrives — rolled once from `ambition` and `composure` at the moment
  contact goes, and held. Going clear off the front is deliberately not this, or a racer
  would sit up in the middle of their own attack.
- **Attacks read the field as well as the road.** `attackAppeal` says where the road
  rewards a move; the gap to the group up the road and the size of the group a racer is
  in say whether it is worth making. A big bunch attacks itself apart far less readily
  than a committed group of three — the free-rider problem, and the reason
  `tactics.onusHalfGroupSize` exists.

A consequence worth knowing before writing a test: a bunch race finishes with a **tight
median and a long tail**. Do not assert on first-to-last, which gets *wider* — a peloton
holding its bulk together while spitting individuals out the back is the behavior this
exists to produce.

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
   width of a per-tick noise term drawn from the racer's RNG stream. Also where a racer
   decides to *attack*, rolling against `aggression` and `ambition` scaled by the
   `attackAppeal` of the road ahead. Nothing is emitted on the decision — whether the
   move opens a gap is the ground truth, and `groups.ts` reports that if it happens.
   **3b, the bunch** — a step in its own right, numbered this way only so the four below
   keep the numbers they have always had. If the racer is in a group they ride its
   collective pace rather than their own, holding above their own limit until they empty
   themselves and come off the back. See "Riding in a bunch".
4. **Traffic**: if a racer ahead is within the closing distance, either follow (dirty
   air / slower pace) or attempt a pass. Pass resolution is a probability roll from
   `racecraft`, `aggression`, speed delta, and available track width at that node.
   Failed passes cost time; badly failed passes can trigger a mistake.
5. **Incidents**: mistake chance scales with (effort above grip limit) × (1 −
   composure) × weather severity. Outcomes: minor lockup (small time loss), spin
   (large loss), crash (DNF). Mechanical DNF rolls against `reliability`.
6. **Integrate**: apply accel/brake toward target speed, advance
   `distanceAlongRoute`, update lateral offset, check line crossings, emit events.

Everything in steps 2–5, 3b included, must be individually toggleable via a debug panel
so we can isolate why a race felt wrong. `pnpm race --off <steps>` is the same switches
from the command line, and is what the debug panel will drive when it exists.

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

**The event feed is capped, so it must be filtered before it is capped.** The race client
keeps only the last few dozen showable events, and the predicate deciding what is showable
lives in `packages/ui/src/feed.ts` precisely so the client and the component share it. If
the client capped the raw log and the component filtered afterwards, a bunch race would
show an empty feed almost permanently — any recent forty events are overwhelmingly likely
to be in-bunch shuffling with nothing worth showing among them.

---

## UI flow

1. **Track builder** — click to drop waypoints, drag to adjust, snapped route drawn
   live. Show length, elevation profile, and detected corner count. Toggle
   circuit/point-to-point. Undo/redo. Save. A place search over the map gets you to
   the right part of the world without panning an ocean; it moves the camera and
   does nothing else — no waypoint is placed, and a track never records the place
   that was searched for.
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
pnpm race --off bunch,tactics   # re-run one seed with part of the tick switched off
```

`--off` takes any of the `DebugToggles` keys. Re-running a seed with a step disabled is
the fastest way to find out what that step is worth, and it is how the peloton model was
tuned — `--off bunch,tactics` is the race the simulation ran before it knew what a bunch
was. The runner prints the finishing spread alongside the broadcast counts for exactly
this comparison.

### External services

All of them are optional at runtime. The first four fall back independently; place
search deliberately does not, for the reason below.

| Service | Used for | Without it |
|---|---|---|
| MapTiler (`VITE_MAPTILER_KEY`) | basemap | blank background, app still works |
| Valhalla (FOSSGIS public) | snapping routes to real roads | synthetic geometry, flagged in the UI |
| Open-Meteo elevation | real gradients | synthetic hills, flagged in the UI |
| Open-Meteo | the real forecast, baked at race creation | dry and still, flagged in the UI |
| Nominatim | finding a town or country to draw in | **no fallback** — search says it is unavailable and the map stays put |

**Place search has no fallback on purpose.** A synthetic DEM still gives you hills
to race over and a synthetic router still gives you a road; a synthetic gazetteer
would move the map to somewhere that is not the place the user named, under a name
they trust. A mock exists in `providers/mock/geocoding.ts` for tests and is
deliberately never wired into `createProviders`. Nominatim's usage policy caps us
at one request a second, which is why `useMapSearch` debounces rather than
searching per keystroke, and why every lookup carries an abort signal.

Framing a result uses its bounding box, except for countries. A country's extent
covers everything it governs — Portugal's box reaches the Azores, France's reaches
French Guiana — so fitting it lands the user in an empty ocean. Countries get a
fixed continental zoom on their own point, which is on the mainland.

Only MapTiler needs a key: put it in `apps/web/.env.local` (gitignored; see
`apps/web/.env.example`). It ships to the browser and so is public — restrict it
by HTTP referrer in the MapTiler dashboard.

**The fallback never covers up a real answer.** "No route exists between these
two points" is the router doing its job — usually a one-way street — and it is
shown to the user. Only an outage, a timeout or a rate limit degrades to the
mock, and when it does, the track records which service was synthetic so the
track list can say so.

**Anything the browser calls has to send CORS headers, and curl will not tell
you whether it does.** A service without them fails with a bare
`TypeError: Failed to fetch` before the request leaves the page, which the
fallback reads as an outage — correctly — and quietly serves mock data from then
on. That is exactly how every track saved from this app came to have invented
hills while the same request worked perfectly from a terminal. When adding or
swapping a provider, test it from the page, not from a shell.

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
- Some sanity rows have to be **averaged across seeds** rather than asserted per seed,
  and the ones that do say so and say why. A bunch riding faster than a strung-out field
  is a systematic five percent and holds every time; the median gap closing, and a
  crosswind costing an echelon time, are real but comparable to seed-to-seed swing. A
  per-seed assertion on either is a flaky test wearing a confident comment.
- Keep the long ones short enough not to block the vitest worker for tens of seconds at a
  stretch, or its RPC heartbeat times out and the suite fails with an unhandled error
  while every test passes.

---

## Conventions

- US English spelling throughout, including in code identifiers and UI copy.
- SI units internally (meters, m/s, seconds, kelvin-free celsius). Convert only at the
  UI boundary. Suffix ambiguous variables: `speedMs`, `distanceM`, `lapTimeS`.
- **The reader picks metric or imperial; nothing else ever asks.** `UnitsProvider` in
  `packages/ui/src/units.tsx` holds the choice, remembers it in `localStorage` and
  defaults from the browser's locale; `useUnits()` hands back formatters already bound
  to it. The formatters themselves live in `packages/core/src/units.ts`, which is the
  only place a conversion factor may appear. Nothing upstream of a render branches on
  the system — that is what keeps a race shared by a reader in miles byte-identical to
  the same race opened by a reader in kilometers. A number that reaches the screen from
  a store, a sim result or a bake must therefore arrive in SI and be formatted there,
  never formatted earlier and carried as a string.
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

- **A bunch race is not narrated pass by pass.** Cycling formats suppress in-bunch
  position changes in the live feed and report group moves instead. The format is
  derived from the vehicle class rather than chosen at setup, because v1 runs one class
  for the whole field so the class already settles it and a separate control could only
  contradict it. The sim tags each pass with its significance rather than leaving the UI
  to guess, because only the sim knows the shape of the field.
- **The separation sweep is an input to tactics, not to outcomes.** It runs at course
  creation and is stored on the track. The sim reads it as one number per node —
  `attackAppeal` — which raises the odds that a racer commits to an attack there. It
  never makes a field split; whether a move sticks is decided by the same physics as
  everything else. This was informational only until the peloton change, and the sweep's
  thresholds became golden-moving at that point.
- **A peloton behaves like one, and it is `bunch.ts` that does it, not `groups.ts`.**
  The narration layer stays inert and a second module carries the behavior, because the
  thresholds and the lag that make a commentator readable would make the physics wrong.
  See "Riding in a bunch".
- **Results design.** A dismissable panel over the finished race rather than a
  separate screen, so the scrubber survives underneath and a chart can send you
  back to the lap it describes. Order is classification, then the generated
  report, then position-by-lap and lap-time charts, sector bests and the
  incident timeline. The narrative is assembled from the event log by template,
  never by a model — a shared race has to read identically for everyone, which
  rules out anything non-deterministic.
- **Finished races are stored as inputs, not recordings.** A saved race keeps
  its track id, config, seed, `simVersion` and `resultHash`; reopening it
  re-runs the simulation. That is the same contract `SharedRace` needs, and it
  means a stored race can never drift out of step with the physics — a
  mismatched hash is shown to the user rather than papered over.
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
