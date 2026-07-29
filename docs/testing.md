<!-- What is tested, how, and what is only ever tested by hand. -->

# Testing & debugging

```bash
bun run check    # typecheck + lint + format + test — what CI runs
bun test         # just the tests
```

## What each suite covers

| Suite | What it proves |
| --- | --- |
| `src/sim/sim.test.ts` | The game, driven the way a player drives it — `PlayerInput` into `step()`, which is only possible because the sim is pure. The full pizza pipeline, hold-to-chop semantics, burning, collision regressions, the day/build loop (a room waking into its morning, the day turning at close, a close that takes nothing out of the till), the patio ring (walking it, what may be built on it, working an oven from behind), what the kitchen says is wrong with it — including that a healthy one says **nothing**, which is the assertion that keeps the warnings worth reading — and that a burnt dish costs a plate for the day and not a minute longer, which is the fact the stall's do-not-sell list is sized against, the dining room (seating, delivery, the wrong dish, tips, bussing, walkouts, a walled-off room, the closing beat), and the plate economy — including one test that **counts the kitchen's plates** through a serve, a binning, a disconnect, closing time and an appliance being lifted, because a plate that stops existing is a room that stops working. |
| `src/sim/shop.test.ts` | The stall, through `Grab` and nothing else — because "no new verbs" is a design claim a test can hold to account. Buying, the broke refusal changing *nothing*, same-morning refunds, sellback at half, the essential kinds it will not take, shutters during service, a morning's stock being a layout change the server actually sends, and a bought plate followed through a whole day loop by the conservation count. Two things here cannot be caught any other way: **two Hosts on one seed** must stock identically for five days (otherwise the bug is "my friend sees a different shop"), and demand must measurably follow free tables in both directions, with the day curve still acting as a floor. |
| `src/sim/cards.test.ts` | The menu and the card stand, through `Grab` and nothing else, for the same reason the shop is: **zero new verbs** is a design claim a test can hold to account. A fresh room being salad-only and everybody ordering it, the cadence, two distinct tier-weighted prereq-respecting cards, arming and confirming, walking away, the timeout, a pick taking the *offer* and not just a card, unpicked cards leaving at open, an exhausted library, and deliveries landing exactly the missing kit on interior tiles — with the pathological "nowhere to put it" refused out loud rather than dropped. Two things here cannot be caught any other way: **two Hosts on one seed** must be offered the same pair, and the stall must not stock a fryer for a kitchen with nothing to fry. |
| `src/game/host.test.ts` | The multiplayer machinery **without a socket in sight**: stable ids across a departure, what a leaver was holding, one-input-per-tick consumption and acks, reset, holding a seat, and a full encode/decode round trip proving a client that has only ever seen frames ends up with the same kitchen. `Host` is the same class the server runs, so anything proved here is proved for hosted play. |
| `src/game/latency.test.ts` | **How long the game takes to answer you, in milliseconds.** The real `NetGame` and the real `Host`, with a virtual clock and a pipe between them costing whatever round trip is asked for, measuring the only thing a player can perceive: press a button, wait for the *drawn* world to show it. Moving is one tick at any latency; handling is a round trip plus a broadcast, every time. Swept across the whole 20Hz broadcast cycle, because a single press can land just before a frame goes out or just after one did, and 50ms of that difference says nothing about the link. It also holds the server's input queue to account: every dropped client frame puts a tick of latency in front of everything pressed afterwards, and only standing still takes it back out. |
| `src/game/wire.test.ts` | That nothing malformed reaches the simulation. NaN, infinities, wrong types, oversized payloads, unbounded nesting — and that honest input still passes through unchanged. |
| `server/server.test.ts` | The transport, against a **real server in a subprocess**: the handshake, a duplicate `hello`, seat reclaim after a drop, that one connection cannot drive another's chef, and that a NaN payload leaves every other player in the room untouched. |
| `server/store.test.ts` | Saves on disk: atomic writes, coalescing, quarantine of a file we cannot read, and that a failed write is reported rather than swallowed. |
| `src/save.test.ts` | The save format: round trips, migration from older schemas, that a save written before the sink existed is given one rather than restoring an unplayable kitchen, that a save for a level that no longer exists is refused by name, and every way a file can be wrong. |
| `src/render/anim.test.ts` | The animation maths, which is why it lives in a file with no three.js in it. The chop cycle's three segments, and that easing is frame-rate independent. |
| `src/render/camera.test.ts` | Framing: following the local chefs, staying inside the kitchen, any aspect ratio. |
| `src/input/input.test.ts` | Gamepad seating, including that a pad which is merely plugged in takes no seat. |
| `src/data/validate.test.ts` | That the content the game ships is coherent. |
| `docs/docs.test.ts` | That these documents still describe this codebase. |

They double as executable documentation.

## Poking at a running game

In dev builds the live state is exposed on `window.cookd` for console poking:
```js
cookd.world.players[0].pos
cookd.world.money = 500        // offline only — online the server owns this
cookd.world.dayTime = 1        // fast-forward to closing time, and the next morning
cookd.world.day = 8            // then close, to see a later day's stall
cookd.game.status              // "local" | "connecting" | "online" | "offline"
cookd.game.ping
```

Online, **writing to `cookd.world` does nothing lasting**: the next frame
overwrites it. That is the authority model working, but it does mean debugging
recipes is much easier offline (`?local`).

`?server=ws://host/ws` points the client at a different server — used below to
test against a latency proxy, and handy for running a local client against a
deployed kitchen.

## Testing multiplayer by hand

Two browser contexts against one room is enough to catch most things. For
latency, put a proxy in front:

```js
// delays every message in both directions
const LAG = 90;   // one way, so 180ms round trip
```

**Use a fresh room code per test run.** Rooms persist to disk, so a second run
of the same test starts from the kitchen the first one left behind — which shows
up as a test that passes once and then reports "nothing changed" forever.

**Two menu presses in the same frame count as one.** Menu navigation is
edge-triggered, so a script sending `ArrowDown` twice with no delay moves the
selection once. Humans cannot press twice in 8ms; Playwright can.

Anything that walks a chef to a fixed position by *timing* keypresses will fail
online — the harness has to wait on state instead, because a 180ms link makes
"press right for 500ms" land somewhere different every run. This is a good
property, not a nuisance: it is the same reason the tests drive `step()` rather
than the clock.

## Verified by hand

The list below is deliberately only the things a test cannot reach. Anything
that *can* be automated has been, and moved to the table at the top of this
file — a hand-verified claim in a document is a claim that stops being true
without telling anybody.

**Play, in a real browser.** Keyboard play end to end: crate → chop → combine →
plate → deliver pays out, food burns if left on the fryer, appliances can be
picked up and re-placed in the build phase. The dining room too, offline and
online: customers walk the path, take a seat, raise a bubble with the dish and a
patience ring, eat a delivered plate, and leave a dirty plate and a stack of
coins behind.

**Multiplayer against a 180ms latency proxy.** Two browsers in one room see each
other move and collide; picking up, placing and chopping all confirm across the
link; a build-phase move propagates and lands on disk; a reset reaches every
client and names who did it; a room survives a server restart; and an
unreachable server falls back to offline play after six seconds with the game
still playable.

**Gamepad input has not been tested against physical hardware** — the mapping
assumes the standard layout (`A`/south = grab, `X`/west = use, `Start` = next
day). `input.test.ts` covers the *seating* logic against a fake pad, which is a
different question from whether the button indices are right.

**Room isolation, observed rather than arranged.** The per-room tick is wrapped
so one bad room cannot take the others with it, and this is not theoretical: a
signature change during development made `advance` throw every tick, and the
isolation contained it to one room while the rest of the server carried on. In
Bun an uncaught throw in a timer callback can end the process.

### Since automated

These were once hand-verified claims in this document. They are now assertions,
which is the direction things should travel:

- A dropped player reclaims the same chef inside the grace period, and is
  cleared away after it — `server.test.ts`.
- Junk traffic (input before hello, malformed JSON, a duplicate handshake) is
  ignored rather than crashing anything — `server.test.ts`, `wire.test.ts`.
- A reconnect ends up with exactly one client and one chef, with the stale
  session's frames and input history discarded — `host.test.ts`, `server.test.ts`.
- A room nobody touched leaves nothing on disk — `host.test.ts`.
- The wire frame stays under 1.5 KB with four chefs — `host.test.ts`.

---

Next:

- [architecture.md](architecture.md) — why the sim can be tested at all
- [lessons.md](lessons.md) — what the tests are defending

[Back to the README](../README.md).
