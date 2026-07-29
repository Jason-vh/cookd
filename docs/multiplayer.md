<!-- How online play works: three clocks, prediction, and holding a seat. -->

# Multiplayer

The client is four pieces, and the split is the same one the problem has:

| | |
| --- | --- |
| `game/connection.ts` | The socket, and the business of keeping one. Backoff, and knowing when to stop. |
| `game/snapshots.ts` | The received timeline, and the playout clock that reads it. |
| `game/reconciler.ts` | Our own chefs, run ahead of the server and corrected when it disagrees. |
| `game/net.ts` | Wires those three to a `World` the renderer cannot tell from a local one. |

Each of the first three is pure enough to test without a socket, which is the
point: all three had bugs that only appear on a bad link or during a deploy.

One server, many kitchens. A **room code** picks the kitchen; the code lives in
the URL hash, so sharing the link is the entire invite flow. A room is created
the moment someone uses its code and is kept warm for ten minutes after the last
person leaves, so refreshing your browser doesn't wipe the kitchen.

Any number of players can share one browser — gamepads and the two keyboard
schemes work exactly as they do offline. You join with one chef; more appear by
pressing `P` or **pressing a button on another controller**, which is how couch
co-op actually starts.

A controller that is merely *plugged in* does not join. It used to, and the
first person to open the game with three controllers connected arrived to four
cooks standing in the kitchen — three of them nobody's, and no way to remove
them short of everyone leaving. `Shift`+`P` drops the last local player, because
adding one needed an undo. The join screen deliberately does **not** ask how many of you there are:
it made you answer a question about a game you had not seen yet, and the answer
was already changeable at any moment.

A connection owns its players and may only move those; a buggy client cannot
drive someone else's cook around.

## One `Host`, two places to run it

`game/host.ts` owns a world, its clock and its players, and does not care where
it is running. Offline it lives in the tab; online it lives on the server. There
is deliberately **one implementation of turning the handle**, because two would
drift and the difference would only ever show up as "it works on my machine, in
single player".

`Game` (`game/game.ts`) is what the shell talks to. Both implementations hand
back a real `World` and an `alpha`, which is why the renderer never learned that
multiplayer exists — online the world is assembled from snapshots, offline it is
the live simulation, and `View` cannot tell.

## State, not lockstep

The server is authoritative and sends **state**. The obvious alternative — send
only inputs and let everyone simulate — is tempting because `sim/` is pure, but
*pure* is not the same as *bit-identical across machines*. We have already been
bitten once by floating point in `movement.ts` (`2.32 - 0.32 = 1.9999…`).
Lockstep would promote that class of bug from "annoying" to "two players see
different kitchens and neither is wrong".

Measured, state sync costs **~14 KB/s per player**, which buys a whole category
of impossible bug:

| | bytes |
| --- | --- |
| Whole world, naively | 5264 |
| Split static/dynamic | 1561 |
| Idle appliances omitted | **723** |

Two things get it there. The **layout** (which appliances exist and where) is
~70% of the bytes and changes a handful of times a day, so it rides its own
message and is sent only when it changes. And a frame carries only appliances
that are *doing something* — a kitchen is mostly idle counters, and repeating
"still empty, still zero" twenty times a second for each of them was two thirds
of the frame. Anything missing from the list is idle by definition.

The simulation runs at 60Hz and broadcasts at 20Hz.

## Three clocks

Most of the difficulty in `game/net.ts` is keeping these apart:

- the **server's** clock — authoritative, arriving ~20 times a second, late and
  jittery;
- the **playout** clock — deliberately held ~110ms behind the newest frame so
  there is always a pair of frames to interpolate between. This is the jitter
  budget: a frame late by less than this is invisible;
- the **prediction** clock — our own chefs, running *now*.

Everything is sampled onto tick boundaries before it reaches the renderer, so
`View` still gets a plain `World` and one `alpha`.

Remote chefs are sampled at the current tick *and the one before it*, rather
than simply interpolated. The renderer derives the walk cycle from how far a
chef moved in one tick, so handing it two positions 50ms apart would have every
remote chef permanently sprinting.

## Prediction, because of the distance

Between Europe and South Africa the round trip is ~180ms. Without prediction,
every step you take would arrive a fifth of a second after you asked for it, and
running a kitchen would feel like steering a boat.

So the client keeps a second world, runs its own chefs in it immediately, and
replays anything the server hasn't acknowledged yet on top of each frame that
arrives. Inputs carry a sequence number; the server acknowledges the last one it
applied; everything after that is re-run locally.

For this to work the server must apply *exactly* the sequence the client
predicted against, so inputs are queued and consumed **one per tick** rather
than "latest wins" — otherwise the two would drift under jitter and never
reconcile cleanly. A starved queue repeats the last input instead of stopping
dead: a dropped packet should look like a moment of lag, not a stumble.

That last property is also what makes an idle kitchen quiet. Since silence
already means "carry on", the client stops sending altogether while a chef
stands still: runs of idle input collapse, and only the first idle tick — the
instruction to stop — goes out. A stationary chef cannot drift apart from the
server either, because both integrate the same zero velocity, so there is
nothing for the reconciler to correct. Idle upload falls from ~4 KB/s to 16 B/s,
which is just the two-second keepalive.

Measured against a 180ms latency proxy:

| | |
| --- | --- |
| Local chef responds after | **16ms** (one tick) |
| Position error while running | 0.5 tiles |
| Position error once stopped | **0.000 tiles** |

That half-tile is not error — it is the client correctly being *ahead* of an
observation that is 180ms old. What matters is that it converges to exactly zero
the moment you stop, with no rubber-banding.

### When the server refuses your input

A stalled link can deliver half a second of input at once. The server drops the
oldest rather than working through the backlog, and **that is correct**: it has
already lived through that half second and cannot spend it again. Replaying it
would put the player half a second in the past and keep them there.

But the client has already predicted those inputs, and the acknowledgement jumps
straight past the dropped ones — so it can never replay the difference. Measured,
that was a **2.24 tile instant teleport** across the kitchen, mid-stride.

So a correction is carried as an **offset that decays to nothing over ~200ms**
rather than applied at once. You keep control the whole time; the chef slides
back into place. Past 2.5 tiles something has gone properly wrong (a reset, a
very long stall) and being in the right place beats being smooth about it, so it
snaps. Measured after the fix: a peak correction of 0.35 tiles, fully absorbed,
settling to exactly zero.

This is the one part of the netcode that only misbehaves on a *bad* link, which
is exactly why it survived the first round of testing — a healthy connection
never drops an input, so the convergence test showed a clean 0.000 and said
nothing about it.

**Only movement and facing are predicted.** Possession is not: an item that
appears in your hands and then snaps back is far worse than 60ms of nothing.
Pressing grab is confirmed by the server, and so is the chopping animation, so
the whole interaction lands together rather than in pieces.

## Dropping out, and coming back

A dropped connection **holds your seat for 25 seconds**. Your chef stays where
it was, faded out and still wearing your name, holding whatever you were
holding. Come back inside that window — same browser, same kitchen — and you
resume the same cook mid-pizza.

The alternative, deleting the player immediately, means a two-second wifi blink
costs you a half-built dish. On a link between Europe and South Africa that is
not an edge case, it is Tuesday.

An away chef is fed **empty input**, not its last input. Without that, the
starved-queue behaviour that normally makes a dropped packet look like lag would
helpfully repeat "walking left" and march an unattended cook into a wall for
twenty-five seconds. Anything queued before they vanished is dropped too, so a
grab held at the moment of disconnection does not fire on their return.

Seats are keyed by a token in `localStorage` — it identifies a *seat*, not a
person, and the worst it can do is take back your own cook. If the same token
reconnects while the old socket is still open (a reconnect that beat the close),
the new connection takes the seats over rather than doubling up.

Once the grace period passes, the seat is cleared exactly as a deliberate
departure would be:

A player who leaves has their food destroyed and their appliance put back —
at the tile it was lifted from, or the nearest free one. Food has no floor to
land on, and a chef vanishing while leaving a pizza hovering in mid-air is a
worse bug than losing an ingredient; an oven lost to someone's wifi would be
unrecoverable.

Player ids are **stable and never reused**. They were array indices until
multiplayer, which is fine when players only ever get added — the first time
someone in the middle disconnects, everyone after them shifts and inherits the
wrong chef.

Use `playerById(world, id)`, never `world.players[id]`. The two look
interchangeable and silently stop being so the moment anyone leaves; two call
sites in the renderer were missed in the conversion and only broke *after a
disconnect*, which no test covered because tests join players in order from
zero, where id and index happen to agree.

## Resetting

Reset wipes the kitchen **for everyone in the room**, so it asks twice. The
menu is driven by whichever button also means "yes" everywhere else in the game,
and one mis-timed press should not cost four people their layout. Arming clears
if you move, close the menu, or leave it for four seconds. The log names who did
it.

## Pausing

`Esc` / `Start` opens the pause menu. **The simulation has no concept of being
paused** — it never did, which turned out to be the right call: online the world
cannot stop because one player opened a menu.

So the menu does not pause anything. It **zeroes your inputs**: your chef stands
still, everyone can see it, and the kitchen carries on burning without you. That
is the honest behaviour online, so it is the behaviour offline too rather than
pause meaning two different things in two places. The menu's actions
(`resume`, `startDay`, `restartDay`) go back through ordinary simulation entry
points.

## The game loop

`src/main.ts` runs a classic accumulator loop:

```
accumulator += frameTime
while (accumulator >= 1/60) { step(world, inputs); accumulator -= 1/60 }
render(world, accumulator / (1/60))   // alpha interpolates prev -> current
```

Players store `prevPos` each tick so rendering interpolates between ticks, so the
sim stays at a deterministic 60Hz whatever the display is doing.

Drawing is capped at **60fps**. `requestAnimationFrame` follows the refresh rate,
so on a 120Hz panel the game drew every frame twice over — twice the draw calls,
twice the post-processing — to show the same thing, because the sim is a fixed
60Hz timestep either way and the extra frames only re-interpolated a chef
between two positions it was already being drawn between.

An unfocused window drops to **10fps**. Chrome throttles a hidden or occluded
tab but not one that has merely lost focus, so a kitchen sitting visible in the
corner of the screen kept drawing at full rate. Only *drawing* is throttled:
`game.update` keeps its cadence because online it is also what sends this
client's inputs to the server.

---

Next:

- [architecture.md](architecture.md) — where `Host`, `Game` and the shell sit
- [lessons.md](lessons.md) — the netcode bugs worth remembering

[Back to the README](../README.md).
