# Placeholders and decisions needing review

Everything in this file is something I invented, guessed, interpreted, or
deliberately deferred. Nothing here is load-bearing on evidence — it is
load-bearing on my judgment, which is exactly the part you should check.

Ordered roughly by how much it would cost to get wrong.

---

## 1. Every tuning constant in the simulation

**Where:** `packages/sim/src/tuning.ts`

All of it is a first calibration pass. The numbers were chosen to satisfy the
sanity table and to make the archetypes narratively legible; none of them were
derived from real race data. Each constant carries a comment explaining the
reasoning, so you can argue with the reasoning rather than the number.

The ones most likely to be wrong, and most consequential:

| Constant | Value | Why I picked it | Why it might be wrong |
|---|---|---|---|
| `effort.sustainableEffort` | stamina 0.76, fuel 0.98, battery 0.92 | Makes a cyclist's race pace 76% of their sprint top speed, which lands the 40km reference case in range | The single biggest lever on every finishing time in the product |
| `effort.minSkillScale` | 0.88 | Skill must outweigh personality; at 0.94 the lowest-skill racer routinely beat the highest | 12% across the skill range may be too wide once fields are hand-built rather than evenly spread |
| `cornering.minCornerSkillScale` | 0.85 | Skill has to scale cornering too, not just straights — see §9 | A 15% corner-speed span between a novice and an expert is a guess |
| `cornering.riskAmplitude` | 0.03 | Deliberately smaller than the skill span so bravery never beats talent | May now be too small to make a Charger feel brave |
| `incidents.basePerTick` | 2.5e-5 | Yields ~1-3 incidents per racer per hour-long race | Sensitive; a 2x change visibly alters how chaotic races feel |
| `incidents.overDriveScale` | 40 | Makes risk a trade rather than a free lunch | Set by reasoning about the trade, not by observation |
| `draft.maxGainFraction` | 0.08 | A strong tow | The whole leader/follower balance rests on this against `dirtyAirGripLoss` |
| `traffic.baseAttemptPerTick` | 0.02 | Produces frequent passing | Probably too high — see §12 |

**Anything you change here changes every golden result.** Bump `SIM_VERSION` and
regenerate the goldens in the same commit.

---

## 2. All eleven vehicle classes are invented

**Where:** `packages/sim/src/data/vehicles.ts`

Top speeds, grip, braking, mass and CdA are plausible, not measured. They were
chosen so the classes *feel* distinct in the way CLAUDE.md asks for — an
e-scooter race is decided by hills, an open-wheel race is decided under braking
— rather than to match any real vehicle.

The surface-penalty tables (8 surfaces × 8 tire archetypes) are pure judgment.

---

## 3. Three fields added to `VehicleClass`

**Where:** `packages/sim/src/data/vehicles.ts`

CLAUDE.md sketches the struct; I added three fields because the tick could not
be written without them. Each is documented in place, but they are deviations:

- **`descentBenefit`** — `gradientSensitivity` cannot do double duty. A runner
  and a cyclist both suffer badly uphill; only one gets anything back coming
  down.
- **`draftBenefit`** — `dragArea` alone gets slipstream backwards. The benefit
  depends on what fraction of a class's resistance is aerodynamic, not on
  absolute frontal area, and deriving that from CdA and mass gave a runner a
  bigger tow than a cyclist.
- **`widthMeters`** — pass resolution has to compare vehicle width against
  `TrackNode.widthMeters`. This is the mechanism that makes single-track
  passing hard.

If you would rather keep the struct as written, `draftBenefit` and
`descentBenefit` could both be moved into category-keyed tables in `tuning.ts`.
`widthMeters` genuinely needs to be per-class.

---

## 4. `SituationalModifiers` — an extension beyond the nine traits

**Where:** `packages/sim/src/traits.ts`

Three launch archetypes are defined by *conditional* behavior, not by a constant
tendency, and there is no honest way to write "strong until they're leading" as
a scalar:

- **The Choker** needs `leadingComposurePenalty`
- **The Showboat** needs `comfortableLeadEasing`
- **The Veteran** needs `paceCeiling` ("capped top-end pace")
- **The Wildcard** needs `rerollSpread`

These stay numeric and apply to every racer (almost always zero), so the
no-switch-statements rule still holds. `Traits` itself is untouched at exactly
the nine fields specified.

---

## 5. Archetype trait vectors

**Where:** `packages/sim/src/traits.ts`

Ten archetypes × nine traits, all tuned by feel. The blurbs are mine too. These
are the single most likely thing to need adjusting once races are watchable —
legibility is a judgment you can only make by watching.

There is a test (`race.test.ts`, "personalities are legible") that asserts the
*shape* holds — Front-Runners lead early, Closers finish ahead of them, Chargers
have more incidents than Metronomes — so you can retune the vectors freely and
still be told if an archetype stops behaving like itself.

---

## 6. Routing profile / vehicle category mapping — an interpretation

**Where:** `packages/core/src/providers/routing.ts`, `PROFILE_ALLOWED_CATEGORIES`

CLAUDE.md does not state which vehicle categories each routing profile permits.
I chose:

- `motor` → everything (the strict subset everyone can physically traverse)
- `bicycle` → `foot`, `micromobility` (no cars: contraflow lanes and unpaved)
- `pedestrian` → `foot` only (steps and narrow footways)

**Related interpretation:** I put `road-cyclist` in the `micromobility`
category alongside e-bikes and e-scooters, leaving `road` to mean cars. That is
what makes "no cars on a bicycle route" expressible. If you meant `road` to
include road cyclists, this mapping needs redoing.

Also unresolved in CLAUDE.md: the `pedestrian` comment reads "trails, footpaths,
steps excluded", which parses two ways. I read it as *restrictions* being
excluded and trails being included, since a later section requires pedestrian
routes to allow `highway=path|track|footway|bridleway`.

---

## 7. Surface inference and junction penalties

**Where:** `packages/track/src/surface.ts`, `packages/track/src/constants.ts`

The `highway` → `SurfaceType` table is a reasonable first guess and nothing
more. It should be checked against real OSM extracts for a few cities and a few
trail networks. Roughly two-thirds of ways carry no `surface` tag, so this is
the common path, not the fallback — which is why every node carries
`surfaceConfidence` so the UI can say "assumed".

Junction penalties (signals 0.25, stop 0.15, give-way 0.5, crossing 0.6) and the
sharp-turn curve are invented.

---

## 8. All external providers are mocks

**Where:** `packages/core/src/providers/mock/`

Per your decision, no real adapters were written. The mocks produce
*realistically shaped* data, not real data:

- **Routing** invents a smooth wandering path between waypoints with uneven
  vertex spacing, mixed surfaces and turn-angle junctions. It is not a road
  network and knows nothing about one-way streets.
- **Elevation** is a sum of sinusoids — smooth synthetic terrain.
- **Weather** is constant or linearly drifting.
- **Tiles** is a blank background with no network requests.

The Valhalla, Open-Meteo, and Open-Topo-Data adapters are the next thing to
write. The interfaces they must satisfy are already fixed and tested.

---

## 9. Bugs I found and fixed via the CLI — the fixes involved judgment

These were real defects, but the *corrections* are my calls, and the balance
they produce has never been watched by a human. Listing them because they are
where the sim is most likely still subtly wrong.

1. **Overtake detection compared positions within a single 50ms tick.** A pass
   takes seconds, so it could never fire: a 25-minute race logged 147 failed
   attempts and zero overtakes. Now tracks relative order across ticks,
   pairwise.
2. **A queued racer's effort was capped to the class sustainable value.** That
   erased the faster racer's pace advantage — which is what gates a pass
   attempt — so a quicker racer could sit behind a slower one for an entire
   race. Removed; the cost of being held up is now taken out of reservoir drain
   instead.
3. **Pass resolution ignored pace entirely.** Success was a coin flip on
   racecraft, and the attempt gate used the *instantaneous* speed difference,
   which mostly reflects where each racer is on the lap. Congested races became
   lotteries. Now gated on a smoothed pace advantage.
4. **A flat speed bonus while passing was an anti-leader bias.** The leader has
   nobody to pass and so could never earn it: across 30 seeds the fastest racer
   finished second ten times and won zero. Replaced with clean air (the
   dirty-air grip penalty lifts while committed to a move), which is something
   the leader also has.
5. **Skill scaled only the straight-line term.** On any track with corners,
   `riskTolerance` outweighed talent and a low-skill Charger beat a high-skill
   field routinely. Skill now scales cornering too, and risk was reduced and
   made more expensive.

After all five, the mean skill of the winner across 30 seeds is 0.90 in a field
spanning 0.55–0.95. Before, it was 0.76.

---

## 10. Golden hashes are generated, not verified

**Where:** `packages/sim/test/determinism.test.ts`

They lock in current behavior so accidental change is caught. They are not
independent evidence that the behavior is correct — the sanity-range suite is
what argues that. Said so in the file.

---

## 11. Smaller items

- **`vehicles.ts` path.** CLAUDE.md says `packages/sim/data/vehicles.ts`; it is
  at `packages/sim/src/data/vehicles.ts` so it sits inside the compilation root.
- **`apps/cli` is not in CLAUDE.md's package layout.** I added it because the
  sim needed to be watchable before a UI exists. It found five real bugs.
- **Racer colors are `#888888` everywhere.** The OkLCH palette ramp and the
  colorblind-safe pattern pairing described in CLAUDE.md are a rendering
  concern and were not built.
- **Racer names in the CLI are archetype labels** ("Charger", "Veteran") so
  output is readable. There is no name generator.
- **Sanity ranges for classes other than the road cyclist are mine.** CLAUDE.md
  specified only the 40km cyclist case; the other five rows in the table are my
  estimates of plausible.
- **The result hash covers finishing order, status and times, but not the event
  log.** Deliberate: two builds that agree on the result to the millisecond but
  differ in incident bookkeeping should not invalidate every published link.
  Worth confirming you agree.
- **Time losses are paid off by running slowly** (`debtPaydownFraction`, 0.6)
  rather than by teleporting a racer backwards. Exact and legible, but it means
  a spin looks like 10 seconds of slow running rather than a stop.
- **Grid layout** is 2 per row, 8m apart, 1.5m stagger. Invented.

---

## 12. Things I noticed but did not change

- **Overtake frequency looks high.** A 25-minute, 10-rider bike race logged
  ~200 position changes. That may be correct for a bunch race, or
  `traffic.baseAttemptPerTick` may need halving. This needs a human watching a
  race on a map to judge, which is not possible yet.
- **The leader/follower balance is tuned blind.** Drafting, dirty air, and the
  pass-commit mechanism interact in ways I could only measure statistically.
- **Wet weather barely matters on a straight track**, because rain mostly costs
  cornering grip. That is correct behavior, but it means the wet-weather sanity
  test is weaker than it looks.

---

## 13. Not built at all

Foundation-first, per your decision. None of this exists yet:

- `packages/ui` and `apps/web` — no React, no MapLibre, no timing tower
- The Web Worker wrapper. The sim is worker-ready (pure, no DOM, steppable via
  `RaceRunner.step`) but nothing hosts it in one yet.
- `SharedRace`, the compressed URL payload, `simVersion` mismatch banner, OG
  images
- IndexedDB / Dexie persistence, roster templates, Supabase
- The generated race narrative and commentary (the event log that feeds it is
  complete and typed)
- Real provider adapters (§8)
