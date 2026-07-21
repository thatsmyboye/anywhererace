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
CLAUDE.md asks for this in the builder; it needs a real router to be worth
writing, since the shape of the problem depends entirely on how Valhalla
reports direction failures.

**Weather as a race-setup preset** ("a wet evening", "a summer heatwave") rather
than six numeric fields. The `WeatherSpec` manual variant already supports it.

**Commentary generation from the event log.** The log is typed and complete
enough to drive this today — overtakes carry both racer ids and the position
fought over, mistakes carry cause and cost, laps carry personal and race bests.
