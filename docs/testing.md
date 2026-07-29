<!-- What is tested, how, and what is only ever tested by hand. -->

# Testing & debugging

```bash
bun run check    # typecheck + lint + format + test — what CI runs
bun test         # just the tests
```

## What each suite covers

| Suite | What it proves |
| --- | --- |
| `src/sim/sim.test.ts` | The game, driven the way a player drives it — `PlayerInput` into `step()`, which is only possible because the sim is pure. The full pizza pipeline, hold-to-chop semantics, burning, collision regressions, the day/build loop, the dining room (seating, delivery, the wrong dish, tips, bussing, walkouts, a walled-off room, the closing beat), and the plate economy — including one test that **counts the kitchen's plates** through a serve, a binning, a disconnect, closing time and an appliance being lifted, because a plate that stops existing is a room that stops working. |
| `src/game/host.test.ts` | The multiplayer machinery **without a socket in sight**: stable ids across a departure, what a leaver was holding, one-input-per-tick consumption and acks, reset, holding a seat, and a full encode/decode round trip proving a client that has only ever seen frames ends up with the same kitchen. `Host` is the same class the server runs, so anything proved here is proved for hosted play. |
| `src/game/wire.test.ts` | That nothing malformed reaches the simulation. NaN, infinities, wrong types, oversized payloads, unbounded nesting — and that honest input still passes through unchanged. |
| `server/server.test.ts` | The transport, against a **real server in a subprocess**: the handshake, a duplicate `hello`, seat reclaim after a drop, that one connection cannot drive another's chef, and that a NaN payload leaves every other player in the room untouched. |
| `server/store.test.ts` | Saves on disk: atomic writes, coalescing, quarantine of a file we cannot read, and that a failed write is reported rather than swallowed. |
| `src/save.test.ts` | The save format: round trips, migration from older schemas, that a save written before the sink existed is given one rather than restoring an unplayable kitchen, and every way a file can be wrong. |
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
cookd.world.dayTime = 1        // fast-forward to the build phase
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
