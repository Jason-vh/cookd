<!-- The decisions log: what went wrong, and the rule that came out of it. -->

# Lessons

Bugs that cost real time, and the rules that came out of them. Most of these
were found twice — once when they happened, and again when the fix was
undone by a refactor and the comment explaining it went with the code.

That is the reason this file exists separately from the code comments: a rule
that only lives next to one call site is a rule that survives exactly as long as
that call site does.

## Bugs worth remembering

- **Never let a world share state with a frame.** The client used to apply each
  frame to two worlds — the one it *drew* and the one it *predicted* in — and
  assigning the frame's order list to both made them the same array, so the
  prediction's `step()` wrote straight into what was being drawn. Orders flashed
  into view and vanished a frame later. It got worse with latency, because more
  unacknowledged input means more ticks replayed, so more chances to invent one.
  `applyFrame` copies now, and the customer list arrives the same way.

  There is **one** world now, and the rule did not go away with the second one:
  a frame outlives being applied. It sits in the playout timeline for a couple
  of seconds, and the world it was applied to replays hundreds of ticks over
  itself, so a shared reference is still a prediction reaching into the record
  of what the server actually said.

  **The rule is about state, not about arrays**, and the wording nearly cost us
  the same bug twice. Items were still shared by reference long after the lists
  were copied, and it looked safe because every rule of the game rewrote an item
  *in place* — a shared tomato becoming a shared chopped tomato is the same
  answer in both worlds. Then a pile of plates became an item that **moves its
  contents into another item**, and a single predicted grab at the plate stack
  took a plate out of the pile the player was looking at. A shared reference is
  a bug waiting for someone to write a mutation you had not thought of.
- **A replayed tick must see the same buttons the first run saw.** Reconciling
  re-runs every unacknowledged tick on top of the server's answer, starting from
  a world whose latched `prev` is whatever the *last* predicted tick left there.
  Grab and use are edge-triggered, so on the second run the button was already
  down and nothing happened. Movement never noticed — it has no edges — which is
  why this sat undiscovered until possession was predicted, whereupon every
  picked-up item vanished on the next frame. Each history entry now carries the
  `prev` it was first predicted against.

  The general shape: **anything replayed has to carry the state its result
  depended on**, not just its input. An edge is a fact about two ticks.
- **A queue read at the rate it is written never gets shorter.** Inputs arrive
  60 times a second and are consumed 60 times a second, so the only thing that
  ever shortened the server's queue was running dry — which happens at zero and
  nowhere else. Every dropped client frame delivered two ticks at once and left
  one of them in there permanently. It is the shape to watch for: a buffer with
  no restoring force does not settle, it *ratchets*, and the symptom is a
  session that gets worse the longer it goes on with nothing in the logs.
- **A timeline should be paced by what a message says, not by when it arrived.**
  Frames carry the tick they describe, and ticks are exactly 1/60s apart, but
  the playout buffer interpolated on arrival times — which silently assumes the
  sender is evenly spaced. It stopped being true the moment the server was
  allowed to send early, and it was never true on a link that bunches packets.
  Arrival times are still the right thing to measure *lateness* with; they are
  the wrong thing to measure *time* with.
- **A prediction may move things and may not talk.** The same replay makes
  anything a predicted tick *announces* happen again on every frame that lands —
  twenty times a second, until the server catches up. A predicted grab moves the
  item; the log line and the puff of coins wait for the frame that confirms it
  (`World.predicting`).
- **A correction is drawn, not simulated.** The offset that absorbs a bad
  prediction goes into the world at the end of a tick and comes back out before
  anything simulates from it, or the next tick's movement and collision start
  from a position that was never true and the correction is applied twice.
- **A request that takes a round trip needs a latch.** A single controller once
  produced **four** chefs. Online, `addLocalPlayer` is a *request*: the server
  owns player ids, so it returns nothing and the answer arrives a round trip
  later. Until then the pad still had no seat, so the binding code asked again —
  on every frame, about eleven times across a 180ms link, each one creating a
  cook. It was capped only by the four-players-per-connection limit. Offline it
  never happened, because a local `Host` hands back an id immediately.

  That is the shape of the whole class: **anything that becomes asynchronous
  when it goes online needs a latch, or the frame loop will do it as many times
  as latency allows.** Test the *online* shape of anything that changes shape
  online.
- **A connected gamepad is not a player either.** Binding a seat on connection
  rather than on a button press would hand a chef to a controller nobody had
  touched. Anything that creates should need an actual act — and have an undo
  (`Shift`+`P`).
- **One key, one latch.** Opening and closing the menu used separate edge
  detectors — one against the menu's own nav state, one against gameplay
  input — so *holding* `Esc` closed the menu and immediately reopened it. Any
  control that toggles across a state boundary needs a single release-latch
  spanning both sides, not an edge detector on each.
- **Poll input once per _tick_, never once per frame.** A frame can legitimately
  run zero ticks (120Hz display, 60Hz simulation), and `InputManager` clears its
  "pressed since last poll" buffer every time it is asked — so polling per frame
  silently eats quick taps. `Game.update` takes a `poll` *function* for exactly
  this reason. This was originally a comment in `main.ts`, and when that file was
  rewritten for multiplayer the comment went with it and the bug came back
  immediately: the first `Grab` of every offline playthrough did nothing.
- **A buffer cleared on read belongs to one reader.** The "pressed since last
  poll" set was shared by the menu's poll and gameplay's, and the menu's ran
  first — so on any frame the menu was up, or the join screen was, a tap was
  consumed before the kitchen could see it. There is one set per reader now. The
  general shape: *clear-on-read is a queue of one, and a second reader is a
  thief.*
- **Controls belong to the camera, not to the grid.** Directions were written in
  world axes while the kitchen is drawn from a corner 41 degrees away, so
  pressing "up" walked you up and to the *right* — on the stick as well as the
  keys, on every playthrough since the camera was angled, and nobody filed it
  until a player did. It survived that long because both halves are individually
  correct: the sim is right to think in world axes and the camera is right to
  stand where it does. The missing piece was that *somebody* has to reconcile
  them, and the edge is the place — `input/` rotates by the shared yaw in
  `orientation.ts` before anything is quantised, so the sim stays ignorant of the
  camera and the wire still carries a plain vector.
- **Only simulate what the client can see the truth of.** Chefs pushed each
  other apart in the simulation, which is a rule about two bodies — and a client
  only knows where *one* of them is right now. The other is drawn on the playout
  clock, a broadcast and half a round trip in the past, so every frame two chefs
  touched produced a correction to the chef the player was steering: "we desync
  when we walk through each other", straight from playtest. Predicting the shove
  was wrong (half a tile at 180ms) and leaving it to the server alone was worse
  (over a tile). What fixed it was noticing that the collision **decided
  nothing** — you interact with the tile you face, not the space you occupy — so
  it was never a rule, only a picture, and the renderer can draw that picture by
  itself. *Before adding a rule to `sim/`, ask what the client would have to
  know to predict it.*
- **Never `world.players[id]`.** Use `playerById()`. Ids stopped being array
  positions when players could leave, and the two only disagree *after someone
  disconnects* — which no test covered, because tests join players in order from
  zero where id and index happen to match.
- **"Fall back to offline" must mean "we never got in".** The flag marking when
  we started connecting was never cleared on success, so the first disconnect
  after six seconds of play quietly moved the player into a *private offline
  kitchen* while their friends carried on without them. It looked like working
  reconnect logic in testing, because the test happened to drop the socket
  inside the six-second window.
- **Two rules about the same square have to be the same rule.** The build phase
  warned that an appliance could not be walked up to, and rang it in red, using
  the dining room's four-way seat search — while a chef *reaches diagonally*,
  which `canReach` says outright and which the corner rule exists for. So a
  perfectly usable oven in a corner was reported broken at every opening while
  somebody stood at the diagonal and cooked on it. The warning is gone; the
  table one, which really is about somebody who walks four ways, stayed.

  The shape to watch for: **a check written against a different actor's rules
  than the thing it is checking.** It is not a tuning error and it cannot be
  tuned out — the two answers were never about the same question.
- **An offer the phase cannot put down is not an offer.** The stall sold single
  plates, and a plate is an *item*; the build phase only understands
  *appliances*. So the grab that should have set a bought plate on a counter
  lifted the counter instead, which reads as the shop breaking the kitchen. It
  sells plate *stacks* now, crockery included. The general form: **anything a
  phase hands a player has to be something that phase's verbs can act on**, and
  "which verbs exist right now" is a question worth asking of every new reward.
- **Optional parameters in the middle of a signature are a trap.**
  `advance(elapsed, 8)` meant "at most 8 ticks" until polling was added, at which
  point 8 silently became the input function and the server threw every tick.
  `advance` takes an options object now.

## Design guidelines we hold ourselves to

**Friction is only worth it when it creates a decision.**

Carrying an appliance during the build phase used to slow you to 60% speed. It
looked like a cost, but the build phase has no clock and nothing competing for
your attention — so the slowdown created no decision, only delay between the
player and the layout they had already pictured. It's gone.

The same test applies to anything that gets proposed as "weight" or "realism":
if the player has no alternative to weigh it against, it is not a trade-off,
it's a toll. Service-phase friction (a fryer that burns, a plate you must fetch)
passes the test — there is always something else you could be doing instead.

**Say yes and let the failure be visible.** Plating the wrong thing, combining
on a plate, putting a tomato back in its crate: all allowed. The player learns
from a result they can see and undo, not from an interaction that silently
refuses. Serving is where the game says no, and by then the mistake is obvious.

## Conventions for future contributors

- Content goes in `src/data` as plain data. Adding a recipe should never require
  touching engine code.
- Anything time-based inside `sim/` must use the passed `dt`, never wall clock.
- Anything random inside `sim/` must use `random(world)`, never `Math.random()`.
- New systems get their own file in `sim/systems/` and are called in an explicit
  order from `step.ts`.
- The render layer may read the world; it must never write to it.
- **No type assertions.** `as` is banned by the linter, `as const` and
  `satisfies` are not. Anything arriving from outside the program — a socket, a
  save file, `localStorage` — is *parsed* into a type, never asserted into one.
  A cast is a place where we told the compiler to stop checking, and the two
  worst bugs in this codebase's history were both exactly that.
- **Anything that eases takes `dt` and uses `ease()`.** `Math.min(1, rate * dt)`
  is frame-rate dependent, and this game deliberately varies its frame rate.
- **A `switch` over a union gets a `default` that assigns to `never`.** Adding a
  case then fails the build instead of silently doing nothing.
- **Anything that creates a three.js object owns freeing it.** `scene.remove`
  does not. Shared resources come from `primitives.ts` and are freed by nobody
  — `disposeSubtree` knows the difference.
- `bun run check` runs on commit and on push, via lefthook (`lefthook.yml`), and
  again in CI. Commit gets the fast three — typecheck, lint, format, about a
  second; push gets the tests too, because pushing `main` deploys. Escape hatch
  is `--no-verify`, and using it means you have decided something, not that you
  were in a hurry.

## Where these are enforced

Several of these are no longer only advice:

| Lesson | Now enforced by |
| --- | --- |
| Never let a world share state with a frame — arrays or items | `host.test.ts`, "frames must not be shared between worlds" |
| A replayed tick sees the same buttons | `latency.test.ts`, "what we picked up stays picked up" |
| A prediction may move things and may not talk | `latency.test.ts`, "a predicted tick says nothing out loud" |
| A correction is drawn, not simulated | `reconciler.test.ts`, "a correction is carried as an offset" |
| The input queue does not ratchet | `host.test.ts`, "a queue deeper than it should be"; `latency.test.ts` |
| Playout is paced by the server's clock | `snapshots.test.ts`, "sending early does not read as jitter" |
| A round trip needs a latch | `input.test.ts`, "a pending online join is asked for once" |
| A connected gamepad is not a player | `input.test.ts`, "a connected but untouched pad does not create a player" |
| A buffer cleared on read belongs to one reader | `input.test.ts`, "press buffers" |
| Controls belong to the camera, from every corner | `camera.test.ts`, "screen-relative controls"; `input.test.ts`, "movement is screen-relative" |
| Chefs do not shove each other | `latency.test.ts`, "a shove does not put the drawn chef somewhere else" |
| Never `world.players[id]` | `playerById` is the only lookup; ids are never array positions |
| Optional parameters in the middle of a signature | `AdvanceOptions`, a named object |
| Don't trust what arrives over a socket | `game/wire.ts` and `wire.test.ts` |
| Casts hide the bugs types were meant to catch | `.oxlintrc.json` bans type assertions outright |
| A control meaning two things needs a latch spanning the boundary | `Latch`, and `menu-controller.test.ts` — one test per historical instance |
| A check must use the rules of whoever it is about | `unreachableTables` is the only reachability warning left |
| The shop only sells things the morning can put down | `shop.test.ts`, "a bought stack arrives stocked" |
| `src/sim` is pure | `layering.test.ts` |
| The renderer reads the world and never writes it | `layering.test.ts` |
| One list of a union, not several | `Record<K, true>` instead of `Set`, in `wire.ts` |
| Content the renderer cannot draw | `models.test.ts` |
| Committing past a failing check | `lefthook.yml` — pre-commit and pre-push |

The ones without a row are still only advice, which is worth knowing when you
are about to break one.

---

Next:

- [architecture.md](architecture.md) — the shape these rules protect
- [testing.md](testing.md) — where they are checked

[Back to the README](../README.md).
