<!-- The morning, the delivery outside the door, and what a day is worth. -->

# The shop

A day begins in the **build phase**, and standing on the paving outside there is
a **delivery**: three things on pallets, for sale, drawn as themselves. The two are one feature:
money had nowhere to go, so it meant nothing, and a build phase that arrived as
the aftermath of a day was a place to tidy up rather than a place to decide.

The one-sentence version: **zero new verbs, and zero new objects.** `Grab` does
everything, the goods are the entire interface, and demand following seats makes
every purchase a piece of self-chosen escalation.

**Nothing is ever deducted.** There was a nightly rent here once, and it was
removed: a number that arrives while nobody is looking is a worse teacher than
a price tag, and every day it took ended in the same place the takings did. The
only way money leaves a kitchen is somebody carrying something away from a
slot.

---

## The morning

The build phase is the **morning of the day it precedes**, not the wreckage of
the one before.

- A fresh room and a loaded room both wake into it. Service starts when somebody
  **turns the sign by the door**, with the verb that already existed (`Grab`).
  The save has always discarded mid-day state, so this makes the resume point
  honest instead of papering over it.
- `world.day` advances when service **ends**. The HUD therefore reads "Day 4 —
  preparing", then "Day 4 — service". Cosmetic, and it is the whole reason the
  phase reads as a morning: you are standing in a day that has not happened yet,
  spending money on it.
- Mid-service joins are unchanged. Only where a *room* starts moved.

There is exactly one phase either way — close, build, open is one loop. A second
phase kind for "morning" would have been two states describing one thing.

## The sign

Opening the day used to be a keypress: `Start`, or a pause-menu item, watched
for by the phase system. It was the only verb in the game that was not a chef
doing something to an object — the shop's own lesson, *a shop is a place, not a
menu*, applied to everything except the moment the restaurant opens.

So it is a sign now, standing against the wall beside the door: level furniture
like the delivery outside, immovable, never saved, answering a `Grab` on
its own terms before any other rule can refuse it. **Zero new verbs.** It used
to hang *in* the wall, back when a wall was a solid square there was room to
hang something in; walls are lines between squares now, so it stands on the
first tile inside the door — which is where a chef opening the restaurant was
always walking anyway.

It reads both ways round, which is why it is a sign and not a button:

- **Morning.** It says CLOSED, and turning it opens the day. `beginDay` still
  refuses out loud while somebody is carrying an appliance.
- **Service.** It says OPEN, and turning it calls **last orders**: the clock is
  run out early and the closing beat every ordinary day ends with takes over.
  The room keeps the people in it, which is the whole difference between a sign
  and the "close up early" menu item it replaced — that one emptied the dining
  room mid-meal.

Both faces of the board show the same word, which is not how a real shop sign
works and is right here: the camera turns to any of four corners, so half the
time a player would be reading the back of the board and being told the opposite
of the truth. The turn is the animation; the state is on both sides of it. What
the board shows is read from the *phase*, never from the keypress, so a refused
open and a flip a predicted tick was not allowed to make both draw honestly.

**A guess may not open a restaurant.** Service interaction is predicted on the
client, so the sign checks `World.predicting` — the same idiom `log` and `effect`
use. Without it a client would call last orders on every replayed tick, twenty
times a second, on a kitchen the server still has open.

The banner carries the only tutorial the game has: **"Turn the sign by the door
to open"**, with the player's own grab key underneath it. A solo player on day
one is standing in a kitchen that will not start until they do something, and
that is the single most important sentence in the product. It now names a place
in the room rather than a button, which is the point of the sign existing. It is
spent on prominence, not on a new screen.

Prominence is not the same as permanence, though, and the banner used to be both:
a full card sitting over the room for the whole morning, which is the half of the
game that is *about* looking at the room. So it has two forms. It arrives as the
card — report, day, instruction — and shrinks to a pill at the top edge once the
player has answered it, by confirming or simply by walking off. The instruction
never actually leaves, because the day still cannot start without it; it stops
being the biggest thing on screen, and drops the day and the pad hint, both of
which the stats panel is already saying.

Movement only settles the banner when there is no report left on it: a report is
something to read, and reading it is not a reason to lose it.

## The delivery

The shop is a **place, not a menu** — and, as of the third attempt at it, not an
object either. Three squares of paving outside the door, one thing standing on
each of them, gone the moment the day opens. See
[below](#there-is-no-shop) for why the shop is nothing at all.

Everything it does, it does through `Grab`:

| You are | The slot is | Then |
| --- | --- | --- |
| empty-handed | stocked, affordable | money out, the goods become a **held ghost** |
| empty-handed | stocked, too dear | a log line naming the price, and the label flashes red |
| carrying what you just bought | the slot you bought it from | **full refund** — this is undo, not commerce |
| carrying anything else | empty | sold, for **half** of list price |

Buying an appliance hands over a held ghost, exactly as lifting one off the
kitchen floor does — so the thing you have just bought is already answering
"where would this go", with `canPlace` deciding and the tile highlight saying
yes or no. A shop that handed you an appliance and then asked you to go and find
it would be two interactions where one will do.

A purchase is never confirmed with a dialog. Sellback at half is what makes that
safe: buying the wrong thing costs money, which is a price rather than a
punishment. (Reset still asks twice, because reset is not recoverable.)

**A refusal is never silent.** Broke, hands full, nowhere to put it, selling the
last sink — each says so in the log *and* flashes the price on the slot. A
button that does nothing is indistinguishable from a button that is broken.

### What it will not sell you

The last plate stack and the last sink — `ESSENTIAL` in `data/appliances.ts`,
which is also the list the save system backfills from. They are on it for **two
different reasons**, and saying which is which is what stops the list growing
until the shop refuses to buy anything:

- **The plate stack** is the only entry on principle. Selling it *destroys
  something conserved*: the kitchen's plates ride on it while it is held, so the
  sale takes the crockery with it and a replacement arrives empty. Nothing else
  in the game does this.
- **The sink** is judgement. A kitchen without one caps its day at however many
  plates it owns — four covers, about $32, whatever the room was hoping to save
  for — and every day after it earns the same $32 again. Not a lock; a ceiling
  low enough that a room could sit under it for a long time without seeing why.

That list used to justify itself as *"appliances a kitchen cannot run without,
and cannot get back on its own"*. The second clause was true when it was written
and **the shop made it false** — a kitchen can now buy back almost anything. A
rationale that has quietly stopped applying is worse than none, because it is
the sentence the next person reasons from.

### Why the bin is not on it

It looks like it belongs. The bin is the only way food comes off a plate, so a
room without one loses a plate to every ruined dish — and with four plates, that
bites.

It lasts until closing time. `clearService` wipes every item in the kitchen and
counts the plates back onto the stack **clean**, so the burnt pizza evaporates
overnight and tomorrow starts whole. Add that a bin is $10 — the cheapest thing
in the game — and that the scarcity guarantee actively promises kinds you own
fewer than two of, and it is the most re-buyable object there is.

The deeper reason is that "can wedge itself" does not stop at the bin. Sell every
table and nobody can sit down; sell every crate and there is nothing to cook;
sell every counter *and* board and nothing can be chopped. Each of those ends in
zero income, which is worse than a missing bin, and following the criterion
honestly admits most of the kitchen. A list of kinds long enough to be safe is a
list that has banned selling.

So the bin gets what a walled-off dining room has always got: **a warning at day
open, not a refusal at the till** — see below. If `clearService` ever stops
washing up, the bin becomes structural and moves onto the list the same day;
there is a note at both ends saying so, and a test pinning the behaviour it
depends on.

### What the kitchen says is wrong with it

`kitchenWarnings` is read once, at day open, and logged. A healthy kitchen says
nothing at all — the case with the most tests, because a warning that fires on a
working room is one players learn to read past, and then the real one is
invisible.

It was one warning before the shop ("tables can't be reached from the door"), on
an explicit principle: *a dining room nobody can walk into is the one
build-phase mistake that silently ends the run, so it is said out loud rather
than prevented.* The shop added a dozen more ways to reach the same place, and
they are all that same sentence.

That sentence now has a twin from the other side of the pass. The same flood
fill run from **the chefs** rather than from the door answers "can anybody
actually walk up to this", so an oven boxed in by a run of counters is named —
`Can't be walked up to: Oven` — and pulses under the same red ring a stranded
table does. Past three names it becomes a count instead: a chef who has walled
*themselves* in has one problem, not eight, and listing their whole kitchen
would bury the wall they are standing behind.

Measured from where the chefs are standing, not from a spawn point: by day open
they have spent a morning walking around, and the spawn tile is a fact about the
level rather than about the room as it is now. An empty room is asked nothing.

The menu warnings are the ones that earn their place. Customers order from what
the **day** has unlocked, not from what the kitchen can cook — so a room that
sold its oven takes pizza orders it can never fill and watches them walk out
with no explanation. Naming the dish turns a mystery into a shopping list.

Which dishes are unmakeable is **derived from the content**, not listed: start
from what the crates dispense, keep applying every transform whose station is
standing somewhere and every combine whose halves are reachable, and see what
comes out. "Which appliances does a pizza need" is a fact about the recipes, and
any hand-kept copy of it goes stale the day somebody adds a dish.

One fault, one sentence: a kitchen that can cook *nothing* says so once rather
than listing every dish as a separate symptom.

### Stock

Rolled each morning from **the room's seed and the day**, through a generator of
its own — and so is where the delivery lands, from the same stream in a fixed
order, because it is one event: one morning, one delivery, one roll.

Not from `random(world)`: that stream is consumed by arrivals and seating, so
two rooms on the same seed have diverged within a minute of opening.
Anything that must look identical on every client and is not sent over the wire
has to come from something that does not move.

The *result* is ordinary world state. It lives on the slot appliances and rides
the **layout** message, which is where it belongs: a slot changes three times a
morning and not at all during service, exactly like a counter. What is left in
the slots is not derivable — it depends on what somebody bought — so it is
synced rather than recomputed. A shop that is half-derived and half-synced is a
shop where "my friend sees a different hatch" is one missed field away, and no
local test catches that; [two Hosts on one seed](../src/sim/shop.test.ts) do.

Weights live in `data/economy.ts` as `Record<ApplianceKind, number>`, so adding
an appliance is a build error naming the key. `0` means "not sold", and having
to say so is the point — the alternative is a new kind that silently never
appears in a shop.

**The delivery is for *this* restaurant.** Crates hold ingredients the room's
own [unlocked recipes](the-menu.md) start from — tomatoes from the first
morning, cheese only once something takes cheese — and an appliance kind no
unlocked recipe can use is not offered at all. A fryer before fries exist is an
expensive thing to buy in order to watch it do nothing, which is noise in the
one place the shop is trying to teach you what the kitchen is missing. It is a
**filter at roll time**, never a write to `STOCK_WEIGHT`: the weights are
content, identical in every room, and a shop that edited them would be a shop
whose tuning depended on who had been playing.

One slot every morning is promised to a kind the kitchen owns fewer than two of
*and has a use for*, and which is **not an upgrade** — see below.
Three duds is a shop players stop walking to, and a shop nobody walks to is a
feature that has quietly stopped existing. That slot is still rolled *by
weight* — evenly made a fryer as likely as a counter, because a lean kitchen is
short of nearly everything, and throughput turned up on four mornings in six.

The two rules together do something neither was designed for, and it is worth
keeping. On a lean kitchen the shortlist is most of the catalogue, so the early
shop offers roughly evenly — it shows you what you are missing. As the kitchen
fills up the shortlist empties and the tiers come through as written. Measured
over four hundred mornings:

| | day one | settled |
| --- | --- | --- |
| staples (counter, crate, table, plate) | ~11% each | ~16% each |
| capacity (board, sink, plates, bin) | ~12% each | ~7% each |
| throughput (fryer, oven) | ~6% / ~2% | ~4% each |

Those figures are for a kitchen whose menu uses everything. A salad-only room
sees the same rhythm across a smaller catalogue, and heat appears in it the
morning after a card delivers some.

A shop that teaches, and then becomes a rhythm. It falls out of the two rules
rather than being arranged, which is the only reason to trust it.

### Upgrades

Everything the shop sold at first was another one of something: a second board
means two people can chop. An **upgrade** is the other kind of purchase — the
same job done better by one person.

| | | |
| --- | --- | --- |
| **Steel board** $110 | prep at 2.75x, against the wooden board's 1.75x | speed |
| **Bell oven** $320 | bakes slightly faster, and holds a finished dish **three times as long** before it burns | time |

They are built out of columns that already existed — `speed`, and a new
`patience` multiplier on the dish's own burn time — so a better appliance is a
row in `data/appliances.ts` and nothing anywhere else. No upgrade tier, no
levels, no second table of burn times to keep in step with the first.

The two axes are deliberate: service pressure is *how fast you can work* and
*how long you can leave something*, and one upgrade answers each. The bell oven
is the more interesting of the two because it does not make a pizza sooner, it
makes the moment you have to be back at the oven later — which is the whole
subject of the game. It is a longer fuse and not a fireproof one: forget it
entirely and it still burns.

Three rules keep them from disturbing anything already here:

- **Never promised.** The scarcity guarantee is about gaps, and a kitchen that
  owns no steel board is missing nothing. Left in the shortlist an upgrade would
  qualify forever — nobody buys two — and the one slot reserved for what a room
  actually needs would spend every morning showing it a $320 oven.
- **Never delivered.** A recipe card delivers *the cheapest movable appliance
  that offers the station*, which was written before upgrades existed and turns
  out to be exactly the rule that stops a free card handing over the good oven.
- **As rare as throughput**, and several days dearer. A slot holding one is a
  thing to plan a week around, which is why it is worth seeing before it is
  affordable.

The `upgrades` column names the plain kind an upgrade improves on. It is typed
`string` rather than `ApplianceKind` — the union is derived from the table the
column sits in, and a column typed by its own keys is a circular type — so
`data/validate.ts` checks what the type would have: that it names a real kind,
that it does the same job, that it costs more, and that it is not somehow worse.

### Plates are the exception

A single plate is a shop item, and it is the **only path in the game that
creates one**. It goes through `mintPlate` in `sim/plates.ts` — named, exported,
one caller — so that "where do plates come from" stays a question with one
honest answer rather than a `makeItem` call somewhere in a shop.

Conservation means *no destruction*; creation is allowed here and has to be
auditable. Which is also why a bought plate has **no refund**: giving the money
back would mean destroying it.

## The ledger

Prices are the `price` column in `data/appliances.ts`, in four tiers:

| Tier | Items | What it costs you |
| --- | --- | --- |
| Staples | plate $10, bin $10, crate $15, counter $20 | felt on day 1–2 |
| Capacity | table $40, board $40, sink $50, plates stack $60 | a good day's profit |
| Throughput | fryer $120, oven $160 | 2–3 days of *profit* — a saving goal |
| Upgrades | steel board $110, bell oven $320 | a week of them — a plan |

There is deliberately **no fail state** and no standing cost. The pressure is
meant to be "we can't afford the oven", not "we lost", and the till only ever
goes up on its own.

The **end-of-day card** shows earnings, tips, balance, dishes served and
orders lost *by recipe*. The last of those is the one that earns its place: "four
walked out" is a number, "four pizzas walked out" is a diagnosis, and the
difference between them is whether the morning knows what to buy. None of it is
recoverable from `money`/`served`/`lost`, which are cumulative, so the day counts
itself as it goes (`world.today`). Dismissing the card is *shell* state — one
player folding it away must not fold it away on everybody else's screen.

## Demand follows seats

Arrivals used to follow the day and nothing else, which made a table free money:
capacity went up, difficulty did not, and the only reason not to fill the room
with tables was running out of floor.

Now the interval is `max(dayFloor, QUIET − PULL × freeTables)`. The day curve is
a **floor** — it caps how intense a day may get — and free tables are the dial
that decides how close you come to it. A table brings its own customers, so
revenue and chaos arrive in the same purchase, and the shop becomes the
difficulty control.

Counted in *tables*, not as a ratio. An empty room of two tables and an empty
room of six should not feel the same, and a fraction says they do — it would also
make buying a table when the room is already empty change nothing at all, which
is precisely the purchase this exists to give weight to.

A table with a dirty plate on it is not free, which is the same rule seating
already applies. Falling behind on bussing quietly slows the door; catching up
opens it again.

## There is no shop

The shop needed somewhere to stand that was not the kitchen, and the answer was
to make the paving real: a **two-tile walkable ring** all round the building,
matching the patio the renderer was already drawing.

**Walkable = paved.** What a player sees, what collision allows and what the
simulation believes are one map rather than three that agree by coincidence —
including the customers' walk up to the door, which routes over the same tiles
as everybody else's.

- Patio tiles are `placeable: false`. `canPlace` asks the tile, not "is this
  outside", so the ring is refused by the same rule that refuses the paving —
  and outdoor seating one day is some tiles changing their mind about one flag.
- Automatic placement (a leaver's oven going home) already avoided the door; the
  patio falls out of the same `isFreeTile` guard.
- **An appliance against the shell has one side, and it is the inside.** It used
  to have two, briefly: a wall was a square, so an oven standing in one could be
  worked from the paving behind it. A wall is a line now, and interaction keeps
  its one rule — face the tile you can reach.

That claim held for one shape only, and quietly: the grid *was* the building
plus its ring, so "in bounds" and "somewhere to stand" were the same sentence
and `isSolid` never had to ask. **Paving is data** now — `LevelDef.paving`, a
list of rectangles — and everything reads that one list: tiles are walkable
inside it and scenery outside it, the renderer lays one slab per rectangle, and
the prop scatter keeps off exactly the same ground.

### Three attempts, and what was wrong with all of them

The shop was a row of **market stalls** on the apron, then a **supply caravan**
parked on the grass. Both were rebuilt carefully and both were wrong, and it
took two goes to see that they were wrong in the same way, because the fault was
in the thing they had in common rather than in either of them:

> Both were **a structure that existed only because the game needed somewhere to
> put a price.** Every other object outside the walls is something a restaurant
> would have anyway. A market for one restaurant is a shop in a field; a caravan
> parked forever at the same corner is furniture pretending to be a vehicle.
> Restyling could not fix that, and each restyle made it bigger.

So the third answer is to build nothing. **What stands outside is the goods.**
Not a stall with an oven in it — an oven, the same mesh that would stand in
your kitchen, on a pallet on the paving, at whatever angle it was put down at
and a fifth off full size so the pallet under it still reads. You
walk up to it and press `Grab`, and you are carrying it.

Three things make that work, and not one of them is an object:

- **The rule was already there.** Nothing may be placed on the paving, and never
  could be — `canPlace` asks the tile. So *anything standing outside is not
  yours yet*, always, with no exceptions to learn. That fact had been true and
  silent since the ring was built; the shop is the first thing to say it out
  loud, and it says it without a sign, a shutter or a price board.
- **The price is already contextual.** Appliance labels appear only for the one
  a chef is facing. A price is the same sentence with a number on the end, so
  walking up to the oven is what tells you it costs $160 — and the world stays
  free of floating text, which is the rule the whole diorama is built on.
- **They stopped having to be in a row — or in the same place twice.** The row
  existed because a stall is a structure and structures are straight. Three
  independent objects can go wherever a delivery lands, so they are **rolled
  each morning**: paving within a few squares of the door, never the row people
  walk in along, each turned by its own `jitter` like everything else in the
  game. The level still lists three squares, because a level says what a kitchen
  has; where they stand is only true of the first morning.

All the renderer draws is a **pallet** under each — about the least a delivery
can stand on, and the one thing that says *this was dropped off* rather than
*this is a display*. An empty one is how a square says the morning's delivery
has already been carried inside, and a lone plate gets something to sit on
instead of a bare slab. Everything vanishes at opening: the goods, the pallets,
the lot.
A delivery not taken in by the time you turn the sign was collected, which is
both the truth about the simulation (the squares re-roll overnight) and the
reason nothing out there needs a closed state at all. The shutters are gone.

### The recipe posters

The card stand was an easel standing a tile away from the stall, saying the same
thing as it: *something about tomorrow is waiting out here*. It is now a poster
pasted on the **outside of the kitchen wall**, one either side of the door.

Posters are `mounted`, like the sign on the inside of the same masonry — they
hang on a wall rather than standing on a square, so the paving under them is
still paving anybody may walk across, and the level loses two obstacles it never
wanted. `mountSeam` answers which line of shell a mounted thing is on from
either face, so `addWalls` leaves that piece at full height and a poster is
never stuck to a wall the camera has cut down to a lip.

### What it cost

Nothing, in the end — this version is **smaller than what it replaced.** The
stall meshes, the caravan, its hatch animation, the run query that kept five
slices agreeing, the easel and six palette entries all went; what replaced them
is a pallet, a poster, and `goodsModel` with the scale taken out.

Two things still had to be true, and one is new:

- **A delivery nobody can reach is money nobody can spend.** `validate.ts` flood
  fills from the door and insists every piece of furniture has a square beside
  it somebody can stand on — a poster is asked about its own square instead,
  since that is where you stand to read it.
- **Nothing inside the building moved**, so the level ids are unchanged and
  saves survive.

An earlier id bump exposed a bug in the server, and it is worth keeping the
note: a save it *refused* used to make
the room permanently unwritable, whatever the reason. "Stale" and "unreadable"
are different answers — a file we cannot parse is quarantined, a file for a
level that no longer exists is simply replaced. Without the split, an id bump
would have silently stopped every existing room from ever saving again.

---

Next:

- [the-menu.md](the-menu.md) — the other place a kitchen grows, and what it stocks for
- [content.md](content.md) — the items, recipes and levels the shop sells into
- [roadmap.md](roadmap.md) — the save format, and what is next

[Back to the README](../README.md).
