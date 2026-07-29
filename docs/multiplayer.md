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

Two things get it there. The **layout** — which appliances exist, where, what
the stall is holding and what is on the [card stand](the-menu.md) — is ~70% of
the bytes and changes a handful of times a day, so it rides its own message and
is sent only when it changes. The room's **menu** rides it too, for the same
reason: `unlocked` changes every third morning and never during service, and
spending twenty messages a second on it would be as silly as it would be for a
counter. And a frame carries only appliances that are *doing something* — a kitchen is mostly idle counters, and repeating
"still empty, still zero" twenty times a second for each of them was two thirds
of the frame. Anything missing from the list is idle by definition.

What is *derived* is never sent twice over: both ends roll the same stall stock
and the same pair of cards from `(seed, day)`. What is sent is everything that
depends on what somebody **did** — which slot was emptied, which card was taken,
what the menu now is. A shop or a stand that is half-derived and half-synced is
one missed field away from "my friend sees a different kitchen".

`PROTOCOL_VERSION` is **2**: the menu joined the layout, and a v1 server's
layouts are rejected wholesale by a v2 client (see `parseLayout`). Without the
bump that is a tab sitting at "connecting" with nothing logged; with it, it is
one sentence telling the player to refresh.

The simulation runs at 60Hz and broadcasts at 20Hz — except that a **press
brings the next frame forward**. A frame is otherwise due every third tick, so
putting a plate down just after one went out means everybody else finds out up
to 50ms later for no reason but the timetable. Bringing it forward rather than
adding one keeps the rate exactly where it was; a floor of two ticks between
frames keeps somebody mashing a button from turning into a broadcast every tick,
for everyone in the room. Measured, a grab reaches the other chef 28ms after the
press on a perfect link instead of 35ms, and the room sends not one extra byte.

## Three clocks

Most of the difficulty in `game/net.ts` is keeping these apart:

- the **server's** clock — authoritative, arriving ~20 times a second, late and
  jittery;
- the **playout** clock — deliberately held behind the newest frame so there is
  always a pair of frames to interpolate between. This is the jitter budget: a
  frame late by less than this is invisible;
- the **prediction** clock — our own chefs, running *now*.

Everything is sampled onto tick boundaries before it reaches the renderer, so
`View` still gets a plain `World` and one `alpha`.

### The timeline is the server's clock, not the postmark

Every frame says which **tick** it is, and ticks are exactly 1/60s apart, so
"where was this chef 80ms ago" has an exact answer that does not care when the
packet carrying it turned up. The buffer used to interpolate on arrival times
instead, which quietly assumes frames are evenly spaced — false twice over: a
bad link bunches them, and the server now deliberately sends early when somebody
does something. Interpolating a real 1-tick gap across a 50ms arrival gap plays
the motion back at a fifth speed.

Arrival times still matter, for the one thing they can honestly report: **how
late this link is running, and how much that varies**. The spread between the
earliest and latest arrival over the last couple of seconds — measured against
the server's clock, so sending early does not read as jitter — is exactly how far
behind we have to sit for a late frame to still be in hand.

So the delay is measured rather than guessed. It was a fixed **110ms**, sized
for a bad transatlantic link and charged to everybody; it is now one send
interval plus a tick (**67ms**) on a link with nothing wrong with it, growing
immediately when frames start arriving unevenly and shrinking at 20ms a second
when they stop, because calm for a moment is not the same as calm. Measured, a
remote chef's first step arrives 66ms after it was taken on a perfect link
instead of 116ms.

Growing is immediate and shrinking is slow on purpose: a frame that does not
arrive in time is a chef who stutters, which is the whole thing the buffer
exists to prevent, and 20ms of extra history is a price nobody can see.

Remote chefs are sampled at the current tick *and the one before it*, rather
than simply interpolated. The renderer derives the walk cycle from how far a
chef moved in one tick, so handing it two positions 50ms apart would have every
remote chef permanently sprinting.

## Prediction, because of the distance

Between Europe and South Africa the round trip is ~180ms. Without prediction,
every step you take would arrive a fifth of a second after you asked for it, and
running a kitchen would feel like steering a boat.

So the client runs its own chefs immediately and replays anything the server
hasn't acknowledged yet on top of each frame that arrives. Inputs carry a
sequence number; the server acknowledges the last one it applied; everything
after that is re-run locally.

**The predicted world is the world being drawn.** There is one, and
`reconciler.ts` owns it: the server's last word with our own outstanding input
replayed over it, and then remote chefs and customers written across from the
playout clock, because nobody predicts those. It used to be two worlds — one
drawn, one predicted — with a few fields copied from the second into the first,
which meant that anything nobody had thought to copy silently cost a round trip.
`carried` was one of them; see [what a prediction may do](#what-a-prediction-may-do).

For this to work the server must apply *exactly* the sequence the client
predicted against, so inputs are queued and consumed **one per tick** rather
than "latest wins" — otherwise the two would drift under jitter and never
reconcile cleanly. A starved queue repeats the last input instead of stopping
dead: a dropped packet should look like a moment of lag, not a stumble.

### The queue is a ratchet, so it is caught up on

One in and one out, at the same rate, means the queue **never gets shorter**
except by running dry — which only happens at zero. Every dropped client frame
sends the two ticks it owes at once, and that extra tick then sits in front of
everything that player does for the rest of the session. Measured, ten dropped
frames were ten ticks of it, and only standing still took them back out: it
degraded slowly, worst during the busiest minute of a service, and was invisible
to any test that let go of the controls. At twenty the server starts discarding
input outright, and the chef visibly stutters.

Since the client predicts locally, this is not felt on your own chef at all — it
is 16ms a tick of staleness in what *everybody else* sees you doing, and a
widening window in which your predicted grab is judged against a world that has
moved on.

So a queue deeper than one tick is caught up on, one extra tick at a time, so a
backlog is absorbed as a series of 0.07-tile corrections rather than one lurch
across the kitchen. **What is skipped is the movement, never the press**: the
discarded tick may be the one somebody pressed grab on, and a press that
evaporates is a player pressing it again and getting two — so its buttons are
folded into the tick behind it. `/health` reports the deepest queue in the
process; it should sit at one.

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

### What a prediction may do

Possession used to be the server's word alone, on the argument that an item
which appears in your hands and then snaps back is worse than 60ms of nothing.
The argument is sound; the number was a guess, and it was wrong. Measured
(`game/latency.test.ts` — press a button, wait for the world the renderer is
handed to show it, swept across the broadcast cycle):

| round trip | move | grab, before | grab, now |
| --- | --- | --- | --- |
| offline | 1 tick | 1 tick | 1 tick |
| 0ms | 8ms | 44ms | **8ms** |
| 30ms | 8ms | 75ms | **8ms** |
| 180ms | 10ms | 212ms | **10ms** |

"60ms of nothing" was only ever true on a LAN. The cost was the round trip
**plus ~35ms** — a tick's wait to be read, the server's queue, and the wait for
the next of twenty frames a second — so a chef in another country spent a fifth
of a second empty-handed, per grab, per chop, per plate, in a game whose whole
subject is picking things up quickly.

So a chef now picks things up in their own world, and the server's answer
replaces the guess wholesale when it lands. What that costs is real and is the
price of the trade: when two chefs go for the same counter, one of them sees an
item for a round trip that was never theirs. That is rarer than *every grab you
ever make* being late.

**The morning is not predicted at all.** Build-phase interaction buys, sells and
moves appliances — it *mints entities* and rewrites the layout — and a client
guessing at that hands out ids the server will never agree with, once per
replayed tick. Service interaction only ever moves items that already exist,
which is a guess that can be wrong but cannot be made up. Nothing is lost by
waiting: the morning has no clock, and an appliance landing a round trip late
lands in a kitchen nobody is racing through.

**A prediction may move things and may not talk.** A replayed tick is re-run
from scratch every time a frame lands, so anything it *announces* — a log line,
a puff of coins over a collected tip — would be announced twenty times a second
until the server caught up. `World.predicting` makes `log` and `effect` no-ops in
that world; the money moves immediately, and the kitchen says so once, when the
frame confirming it arrives.

**The correction is drawn, not simulated.** The offset that absorbs a bad
prediction is written into the world at the very end of a tick and taken back out
before anything simulates from it again (`show` and `hide`). Leaving it in would
feed the correction into the next tick's movement and collision — a correction
applied twice, and a chef who never quite arrives.

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
