# Ideas

Things deliberately out of scope for v1, parked here rather than built. Per
CLAUDE.md, don't implement any of these without being asked.

---

## Ruled out, not deferred

These two are decided. Don't design around them "just in case" — the sim's
statelessness and the absence of any racer-identity persistence are load-bearing
simplifications, not oversights.

- **Persistent racer careers.** No ELO, no form, no fatigue carried between
  races. A roster template is a list of rows to reuse, not an entity that
  accumulates history.
- **Human-controlled racers.** The user is a race director and a spectator.

---

## Good v2 candidates

**A peloton that actually behaves like one.** The *observational* half of this is
built: `packages/sim/src/groups.ts` reads which racers are riding together and
emits attacks, bridges, splits and catches, and the course sweep
(`packages/track/src/separation.ts`) already marks the climbs, pinches and
cobbled sectors where a field would plausibly come apart. Neither of them
touches racer behavior, which is exactly why they could ship without moving a
determinism golden.

The missing half is the tick reading any of it. Today a racer only knows about
the one racer directly ahead, so a bunch is an emergent traffic queue rather than
a thing racers are *in*: nobody shelters in the middle of a group, nobody takes a
turn on the front, and nobody gets dropped on a climb because the group's pace is
above their own. What would need to change:

- Drafting would have to become group-shaped rather than pairwise. A rider
  twentieth in a bunch is sheltered by the whole bunch, not by the wheel in front.
- A group needs a collective pace, and riders need to hold it above or below
  their own sustainable effort — being in a group should cost you when it is
  faster than you and save you when it is slower.
- Racers would need to read `separationPoints` ahead of them, and personality
  would decide who attacks on the climb and who sits in. `aggression`,
  `ambition` and `pacing` are the natural hooks and already exist.
- Echelons, for the `exposed` stretches. The wind model is directional per node
  already, so the physics is there; what is missing is lateral group structure.

This is a large change and it moves every result, so it wants its own branch,
regenerated goldens, and a `SIM_VERSION` bump. Worth noting that the sanity
table would need new rows: a bunch race that behaves like one should produce
much tighter finishing times than the current model does.


**Mixed vehicle classes in one race.** The sim is closer to this than it looks:
`VehicleClass` is already per-racer data rather than per-race, and the tick
reads it per racer. What would need work is the corner-speed and braking profile
precomputation in `profile.ts`, which is currently built once for the race's
single class. A handicap or class-offset system would also be needed to make the
result mean anything.

**Pit stops and tire strategy.** Would need a wear model on top of the existing
endurance reservoir, plus a pit-lane geometry concept the track model does not
have. The endurance framework (`enduranceModel`, drain, fade) is the natural
hook.

**Championships.** A sequence of races with points. Compatible with stateless
racers as long as the standings live outside the sim and nothing writes back
into a racer.

**Day/night cycle.** Would ride on the existing weather timeline —
`WeatherSpec` already interpolates across a race — plus a visibility term the
tick already has.

**3D terrain view.** The DEM is already fetched and baked per node.

---

## Smaller ideas noticed while building

**Custom personalities in the UI.** Traits are already a numeric vector with
archetypes as presets over it, exactly so a user could build their own later.
Nothing in the sim would need to change; it is purely an editor.

**A "why did they lose" explainer on the results page.** The event log plus the
debug toggles make this tractable: re-run the same seed with `incidents: false`
and diff the finishing order to say "they lost 12 seconds to that spin on lap
4". This would be cheap and unusually satisfying.

**Sector-level heat map on the track.** The baker already computes curvature,
gradient and surface per 5m node; overlaying where each racer gained and lost
time against the field is mostly a rendering job.

**Ghost replay against a previous race on the same track.** Determinism makes
this nearly free — two seeds, same track, render both.

**A "find nearest legal loop" helper** for circuit building on one-way networks.
CLAUDE.md asks for this in the builder. Now that a real router is wired up this
is finally tractable: Valhalla reports an unroutable leg distinctly from an
outage, so the builder already knows *which* corner is impossible — the missing
piece is searching nearby positions for one that closes the loop.

**Insert a waypoint into an existing leg.** Right now a waypoint can only be
appended, so refining the middle of a long route means clearing and starting
again. Dragging a point off the route line to split a leg is the standard
gesture and the leg model already supports it.

**Snap the drawn route to a saved track's start line.** Start and finish are
currently pinned to the first waypoint; letting the user drag the line along the
route would make circuits far more raceable.

**Auto-follow camera modes.** The race view deliberately fits the whole track
and then leaves the camera alone. Two modes were considered and parked: follow
the leader (dramatic, but you lose the race behind, which is usually where the
action is) and follow the closest battle (genuinely exciting, but jumps around
and would need tuning not to feel seasick). The frame buffer and interpolation
already give a smooth position for any racer, so either is mostly a camera
easing problem.

**Vehicle silhouettes on the map.** Markers are currently colour + ring pattern
+ number. Rotating a per-category SVG to the node bearing would instantly
communicate what kind of race it is; the bearing is already computed and carried
on every marker feature. The reason it was not built is legibility at forty
racers and low zoom — the natural version is a hybrid that swaps to silhouettes
past a zoom threshold, which is two render paths to keep consistent.

**A live debug panel.** Every step of the tick is already individually
switchable and the toggles are plumbed through the worker protocol; nothing
exposes them in the UI. Being able to re-run the same seed with drafting off
and watch the difference would make tuning dramatically faster.

**Weather as a race-setup preset** ("a wet evening", "a summer heatwave") rather
than four sliders. The `WeatherSpec` manual variant already supports it, and it
would also be the natural place to expose cloud and humidity, which the sliders
currently leave at their defaults.

**Reorderable palette slots.** Roster colours are assigned by position, which
guarantees the colourblind-safe spacing but gives the user no say. Letting them
swap two racers' slots would offer control without letting anyone pick two
colours nobody can tell apart.

**Save a configured race, not just a track.** Setup currently exists only until
you navigate away. Persisting a race config is a prerequisite for sharing
anyway, since a shared link *is* a serialised config.

**Live commentary during a race**, as opposed to the report afterwards. The
narrative generator already turns events into sentences; the missing piece is
choosing which of them are worth saying *now* rather than in summary.

**Click a chart to scrub there.** The results panel sits over the finished race
precisely so the scrubber survives underneath — clicking lap 7 on the position
chart and having the race jump to it is the obvious next step, and needs only a
callback from the chart to the existing seek.

**Add the lap number to overtake events.** The narrative currently times its
decisive moment in minutes because overtakes carry distance and tick but not
lap. It is a one-field change to the event and would read far better.

**A "why did they lose" explainer**, now more tractable than when first noted:
the results page already computes places gained, incident costs and sector
deltas, so attributing a lost race to a specific spin is mostly presentation.
