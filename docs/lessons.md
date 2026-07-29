<!-- The decisions log: what went wrong, and the rule that came out of it. -->

# Lessons

Bugs that cost real time, and the rules that came out of them. Most of these
were found twice — once when they happened, and again when the fix was
undone by a refactor and the comment explaining it went with the code.

That is the reason this file exists separately from the code comments: a rule
that only lives next to one call site is a rule that survives exactly as long as
that call site does.

## Bugs worth remembering

- **Never hand two worlds the same arrays.** The client applies each frame to
  the world it *draws* and the world it *predicts* in. Assigning the frame's
  order list to both made them the same array, and the prediction world's
  `step()` — which spawns customers, logs events and queues effects — wrote
  straight into what was being drawn. Orders flashed into view and vanished a
  frame later. It got worse with latency, because more unacknowledged input
  means more ticks replayed, so more chances to invent one. `applyFrame` copies
  now, and the customer list arrives the same way.
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
| Never hand two worlds the same arrays | `host.test.ts`, "frames must not be shared between worlds" |
| A round trip needs a latch | `input.test.ts`, "a pending online join is asked for once" |
| A connected gamepad is not a player | `input.test.ts`, "a connected but untouched pad does not create a player" |
| Never `world.players[id]` | `playerById` is the only lookup; ids are never array positions |
| Optional parameters in the middle of a signature | `AdvanceOptions`, a named object |
| Don't trust what arrives over a socket | `game/wire.ts` and `wire.test.ts` |
| Casts hide the bugs types were meant to catch | `.oxlintrc.json` bans type assertions outright |
| A control meaning two things needs a latch spanning the boundary | `Latch`, and `menu-controller.test.ts` — one test per historical instance |
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
