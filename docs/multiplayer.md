<!-- How online play works: three clocks, prediction, and holding a seat. -->

# Multiplayer

The client is four pieces, and the split is the same one the problem has:

| | |
| --- | --- |
| `game/connection.ts` | The socket, and the business of keeping one. Backoff, and knowing when to stop. |
| `game/snapshots.ts` | The received timeline, kept on the server's clock, and how far behind to read it. |
| `game/reconciler.ts` | The world being drawn: our own chefs run ahead of the server, corrected when it disagrees. |
| `game/net.ts` | Wires those three into a `World` the renderer cannot tell from a local one. |

Each of the first three is pure enough to test without a socket, which is the
point: all three had bugs that only appear on a bad link or during a deploy.

One server, many kitchens. A **room code** picks the kitchen; the code lives in
the URL hash, so sharing the link is the entire invite flow. A room is created
the moment someone uses its code and is kept warm for ten minutes after the last
person leaves, so refreshing your browser doesn't wipe the kitchen.

The join screen asks one question at a time, and the URL picks which. **Starting**
a kitchen asks where it is and mints a fresh code; **joining** one asks nothing
but your name, because a kitchen's level is fixed the day it is built. A link
with a room in it therefore shows the code rather than a field to type it into.
The two used to be one form behind one button, so "Where" was heeded or silently
ignored depending on whether the code you typed happened to be taken already.

The wire follows: `hello.level` is sent only by someone *making* a kitchen. A
joining client sends no opinion, so the server's answer — the room's save, else
the default — cannot be second-guessed by a stale preference in somebody's
localStorage. A joining client still has to build *some* world to predict
against, so it loads its last kitchen as a guess; if the room turns out to stand
somewhere else, `welcome` says so and the shell loads theirs.

`welcome` carries the **kitchen itself**, not its id. It used to name one, and
the argument for that was good: both ends compile the same registry, so a name
is enough and a server cannot get somebody's floor plan wrong. But that rests on
the client already holding a correct copy — and a
[generated kitchen](content.md#kitchens-nobody-drew) is precisely the case where
it does not, so the id would stop pinning the geometry and the *bundle* would
pin it instead. Two peers on either side of a deploy would then build different
walls from the same id, silently. The building is one fact now, held by whoever
runs the room, sent once at the door for ~1.4 KB, and parsed on arrival like
everything else that comes off a socket.

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

State sync buys a whole category of impossible bug, and this is what it costs.
Measured by `latency.test.ts`, in payload bytes — JSON, uncompressed, what
`Bun.serve` actually puts on the wire:

| the park kitchen, mid-service, with | per frame | down, per player | up, per player |
| --- | --- | --- | --- |
| 1 chef in it | 895 B | 18 KB/s | — |
| 4 chefs standing | 1282 B | 26 KB/s | — |
| 4 chefs cooking | 1327 B | **28 KB/s** | **7 KB/s** |

**Chefs are what a frame grows with** — about 130 bytes each, and every client
is sent all of them, because everybody is sent the whole world. So a room of
four costs the server ~105 KB/s of egress, not four times a fixed price, which
is the number that matters for a box holding 200 rooms. Upstream is a tick of
input at 60Hz and nothing else.

The dining room is a smaller part of it than it looks: the starting kitchen has
two tables, so there are never more than two customers to describe. A room that
has bought its way to eight tables is not measured here, and would be worth
re-running the table for.

This document claimed 14 KB/s and `protocol.ts` claimed 30 KB/s for months. Both
were measured once, under conditions neither wrote down, and then a dining room
was added to the game. A figure in prose with no conditions attached is a figure
that will be wrong within a season; the test prints this table, so the next
person can re-read it rather than re-derive it.

Getting there took two rounds of work, on a bare kitchen with nobody in it:

| | bytes |
| --- | --- |
| Whole world, naively | 5264 |
| Split static/dynamic | 1561 |
| Idle appliances omitted | **723** |

Two things get it there. The **layout** — which appliances exist, where, what
is for sale outside, including the morning's [recipe card](the-menu.md) — is ~70% of
the bytes and changes a handful of times a day, so it rides its own message and
is sent only when it changes. The room's **menu** rides it too, for the same
reason: `unlocked` changes on a morning somebody buys a card and never during service, and
spending twenty messages a second on it would be as silly as it would be for a
counter. And a frame carries only appliances that are *doing something* — a kitchen is mostly idle counters, and repeating
"still empty, still zero" twenty times a second for each of them was two thirds
of the frame. Anything missing from the list is idle by definition.

What is *derived* is never sent twice over: both ends roll the same stall stock
and the same pair of cards from `(seed, day)`. What is sent is everything that
depends on what somebody **did** — which slot was emptied, which card was taken,
what the menu now is. A shop or a stand that is half-derived and half-synced is
one missed field away from "my friend sees a different kitchen".

`PROTOCOL_VERSION` is **5**. Each bump is a field an older peer cannot supply
and a newer one cannot do without: the menu joined the layout at v2, a
customer's kind at v3, the whole level in `welcome` at v4, and at v5 a counter's
`topper` — where [chopping boards](the-shop.md#boards-go-on-counters) live now —
and the frame's `pausedBy`. Layouts and frames missing them are rejected
wholesale (see `parseLayout` and `parseFrame`), so without the bump that is a
tab sitting at "connecting" with nothing logged; with it, it is one sentence
telling the player to refresh.

**A pause is a fact about the room.** It used to be a fact about a screen: the
menu blanked your own input and the day, the fryer and the dining room carried
on without you, on the grounds that a client cannot stop a kitchen four people
are standing in. It cannot — but the *host* can, and that is where it lives now.
Opening the menu sends a `menu` action, `step` refuses to advance a world with
`pausedBy` set, and everybody else is shown whose menu it is. Two safeguards
follow from a pause being state rather than a keypress: a seat that goes away or
leaves releases it (the menu that would let go of it is on a screen that has
gone), and a reset from an open menu comes back paused, because the menu is
still open.

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
to any test that let go of the controls. At twenty it reaches the cap and the
server starts discarding input outright — see [when the server refuses your
input](#when-the-server-refuses-your-input) — which is a 0.10-tile lurch against
a 0.07-tile step, and permanent, because nothing was ever going to take those
ticks back out.

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

A queue that starves by holding the last input is also what makes an idle
kitchen quiet. Since silence already means "carry on", the client stops sending
altogether while a chef stands still: runs of idle input collapse, and only the first idle tick — the
instruction to stop — goes out. A stationary chef cannot drift apart from the
server either, because both integrate the same zero velocity, so there is
nothing for the reconciler to correct. A tick of input is ~115 bytes, so a chef
being run costs **~7 KB/s upstream** and a chef standing still costs the
two-second keepalive and nothing else.

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

**Chefs do not push each other.** A shove is the one thing prediction cannot
guess at: your own chef is simulated *now*, and the chef shoving you is drawn on
the playout clock, a broadcast and half a round trip in the past. Resolving a
push against a body that is not where we think it is is a guess that is wrong
every single frame, and the correction it produces is a correction to *your*
chef, while you are holding a direction — which is what "we desync when we walk
through each other" describes. Measured, as the correction still to be walked
off while two chefs press together (`game/latency.test.ts`):

| round trip | pushing, before | now |
| --- | --- | --- |
| 0ms | 0.21 tiles | **0.01** |
| 30ms | 0.14 tiles | **0.01** |
| 180ms | 0.47 tiles | **0.00** |

The options were: predict the shove (the table's left column), leave it to the
server alone (worse — 1.2 tiles at 180ms, because the client walks through and
the server keeps pushing back), or stop shoving. Bodies do not gate anything in
this game — you interact with the tile you face, not the space you occupy — so
the collision was only ever *worth* what it looked like, and looking is
something the renderer can do on its own. `render/people-views.ts` slides drawn
chefs apart instead: the same picture, none of it on the wire, and every client
free to disagree about it.

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
(`resume`, `restartDay`) go back through ordinary simulation entry points — and
there are two of them rather than four because opening and closing the day left
the menu for the sign by the door, which is an ordinary grab and therefore
ordinary input.

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
