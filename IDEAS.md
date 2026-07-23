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

**Day/night cycle.** Would ride on the existing weather timeline —
`WeatherSpec` already interpolates across a race — plus a visibility term the
tick already has.

**3D terrain view.** The DEM is already fetched and baked per node.

---

## Left over from the championship change

Championships are built — a sequence of races over a fixed field, scored outside
the sim. The domain lives in `packages/championship` (types, standings, tour
continuity), persistence in `packages/store`, and the UI in
`packages/ui/src/components/championship`. The field is materialised onto the
championship as a snapshot so its standings cannot shift underneath it, each leg
bakes its own weather at add time, and nothing is ever written back into a
racer. Scoring is `time`, `points`, or `hybrid` (time with points breaking a
tie); the points table is configurable. Five things it turned up and did not do:

**A leg's finishing order is stored, unlike a standalone race.** A saved race
keeps only its inputs and re-runs; a championship keeps each leg's finishing
order too, because redrawing a standings table by re-running every leg would be
slow and pointless. Each leg still carries the `simVersion` it ran under, and a
stale leg is flagged rather than silently trusted — the same honesty a
mismatched race hash gets — but the projection is not free, and a future change
could reconcile the two approaches.

**Tour-style is validated, not stitched.** A tour checks that each leg's finish
is near the next leg's start and warns when it is not, but legs are added as-is;
it does not auto-pin a new leg's first waypoint to the previous finish. That
needs real track-builder integration — the "insert a waypoint" and "snap the
start line" gestures below are the pieces it would build on.

**One vehicle class per leg, chosen per leg.** A championship can mix classes
across its legs (a bicycle stage, then a rally stage), but a single leg still
runs one class for its whole field, because mixed classes in one race is its own
out-of-scope item above. The field's personalities and skills are class-agnostic
and carry across, which is what makes this coherent.

**No reverse-championship grid.** Grid order is fixed championship-wide. A
reverse-standings grid — last leg's leader starts at the back of the next — is
the obvious way to keep a runaway championship alive, and needs the standings
this now computes plus a `manual` grid built from them.

**Championship sharing.** A `SharedRace` carries one race; the same treatment
for a whole championship (inputs, not recordings, with per-leg hashes) would
share a season. The share codec and the OG card are per-race today.

---

## Left over from the peloton change

The peloton work is built, and so are three of the four follow-ups it turned up:
the front rotates properly, attacks read the field as well as the road, and a
dropped rider decides whether to chase, sit up, or wait. See "Riding in a bunch"
in CLAUDE.md. What is still open:

**The echelon has no lateral truth to it.** Deliberately deferred rather than
missed. It is expressed as a reset of shelter depth, which produces the right
per-rider outcome — a rider past the width of the road loses most of their tow —
without any rider ever having a position across the road. The sim is 1D along
the route and should stay that way, but it does mean the map cannot draw an
echelon, and drawing one is most of what makes them legible to a viewer.

**Echelons do not change race results, only individual riders.** Worth knowing
before anyone tunes them. The mechanism is strong: on a 5m road a full crosswind
takes a rider four wheels deep from 0.77 of the maximum tow to 0.06. It is not
detectable in a finishing order, because the field reorganises around it —
riders who lose the shelter drift back, chains stop growing past an echelon's
width, and everyone settles into *some* echelon with a workable tow. Across ten
seeds a 12 m/s crosswind moved mean finishing time by 0.2%, in the wrong
direction, and left the field slightly *less* fragmented. Making a crosswind
decide a race probably needs the lateral structure above, so that being caught on
the wrong side of a split is a place you can be rather than a number you have.

**Leading does not cost you the race.** A rider on the front now genuinely works
— above their own sustainable effort, drawn from the reservoir — which is the
thing the averaged credit could never do. But over both a 30-minute circuit and a
50km road race with an identical field, the riders who spent the most time on the
front finished *better*, not worse: at the front of a bunch, having done the work
and being ahead on the road are the same thing. For fatigue to decide anything, a
rider needs a reason to bury themselves for somebody who is not them, which is
team tactics — the first thing in the sim that would be about relationships
between racers rather than traits within one.

**Nobody sits up for anybody.** The dropped-rider model covers a racer reacting
to their own situation. It has no notion of waiting for a team-mate, refusing to
work with a rival, or a group agreeing to collaborate — all of which are the same
missing concept as above.

---

## Smaller ideas noticed while building

**Custom personalities in the UI.** Traits are already a numeric vector with
archetypes as presets over it, exactly so a user could build their own later.
Nothing in the sim would need to change; it is purely an editor.

**A "why did they lose" explainer on the results page.** The event log plus the
debug toggles make this tractable: re-run the same seed with `incidents: false`
and diff the finishing order to say "they lost 12 seconds to that spin on lap
4". This would be cheap and unusually satisfying, and the track heat map is now
most of the *where* — what is missing is the *why*.

**A field-spread heat map**, alongside the per-racer one that is built. Same
segment timing, different reading: colour each stretch by how much the field
came apart through it, and you have where the race was actually decided rather
than where one racer lost it. It would sit naturally beside the separation
points, which predict the same thing from the road alone — and comparing the
two would say how good that prediction was.

**Ghost replay against a previous race on the same track.** Determinism makes
this nearly free — two seeds, same track, render both.

**A wider legal-loop search.** The helper that ships spirals out to 180m from
the endpoints of a broken leg and gives up, because every candidate costs a
request to a free shared router and a sequential search of sixty of them already
takes the better part of a minute. Valhalla's `sources_to_targets` matrix
endpoint would answer a whole ring in one request, which would make a much wider
and finer search affordable — worth doing if the helper turns out to give up
more often than it succeeds.

**Dragging the route line itself**, rather than the handle at the middle of it.
Insert handles ship, and they are the discoverable version — you can see where
a waypoint would go before you commit to it. Grabbing the line anywhere along
its length is the gesture people know from Google Maps, and it would want the
line hit-tested under the cursor and the map's own drag suppressed for that
gesture. Worth doing only if the midpoint handles turn out to feel restrictive
on long legs.

**A grid, laid out behind the start line.** The line can be placed now, but
every racer still begins at the same distance and is separated only by their
lateral offset. Real starting grids are staggered back down the road, which
would make the first corner mean something — and the line having somewhere
sensible to be is the prerequisite that was missing.

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
