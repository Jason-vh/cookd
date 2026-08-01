<!-- The morning, the delivery outside the door, and what a day is worth. -->

# The shop

A day begins in the **build phase**, and standing on the paving outside there is
a **delivery**: four things on pallets, for sale, drawn as themselves — appliances,
plates, and the [recipe cards](the-menu.md) that used to have a wall of their
own. The two are one feature:
money had nowhere to go, so it meant nothing, and a build phase that arrived as
the aftermath of a day was a place to tidy up rather than a place to decide.

The one-sentence version: **zero new verbs, and zero new objects.** `Grab` does
everything, the goods are the entire interface, and demand following seats makes
every purchase a piece of self-chosen escalation.

Money leaves a kitchen two ways: somebody carries something away from a slot,
and the **rent** at closing time. The rent is the newer of the two and the one
with a history — see [the rent](#the-rent) for what was wrong with the first
version and what is different about this one.

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
to open"**. A solo player on day one is standing in a kitchen that will not start
until they do something, and that is the single most important sentence in the
product. It names a place in the room rather than a button, which is the point of
the sign existing. It is spent on prominence, not on a new screen.

The player's own grab key used to be spelled out underneath it — `Space facing
it, or A on a pad` — and it is gone. It was a keybinding printed over the game
for the life of the run, teaching the one verb the player necessarily used to
walk up to the sign in the first place, and it undercut the sentence above it by
answering a question that sentence had deliberately declined to ask. Keys are
read in the pause menu's controls table, which is also where they are changed.

Prominence is not the same as permanence, though, and the banner used to be both:
a full card sitting over the room for the whole morning, which is the half of the
game that is *about* looking at the room. So it has two forms. It arrives as the
card — report, day, instruction — and shrinks to a pill at the top edge once the
player has answered it, by confirming or simply by walking off. The instruction
never actually leaves, because the day still cannot start without it; it stops
being the biggest thing on screen, and drops the day, which the stats panel is
already saying.

Movement only settles the banner when there is no report left on it: a report is
something to read, and reading it is not a reason to lose it.

## The delivery

The shop is a **place, not a menu** — and, as of the third attempt at it, not an
object either. Four squares of paving outside the door, one thing standing on
each of them, gone the moment the day opens. See
[below](#there-is-no-shop) for why the shop is nothing at all.

Everything it does, it does through `Grab`:

| You are | The slot is | Then |
| --- | --- | --- |
| empty-handed | stocked, affordable | money out, the goods become a **held ghost** |
| empty-handed | stocked, too dear | a log line naming the price, and the label flashes red |
| carrying what you just bought | the slot you bought it from | **full refund** — this is undo, not commerce |
| carrying anything else | empty | sold, for **half** of list price |

A recipe card is bought and carried on exactly those rows: it is a movable good
like the oven, and putting it down *inside* is what spends it. See
[the menu](the-menu.md#a-card-is-a-good).

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

That sentence had a twin from the other side of the pass — the same flood fill
run from the chefs, naming an oven boxed in by a run of counters — and the twin
has been **removed**. It was built on the four-way search the dining room uses,
and a chef reaches *diagonally*, so it fired on kitchens that worked perfectly
well. See [pathing](dining-room.md#pathing-and-why-it-is-allowed-to-be-this-simple)
for the full story;
the short version is that a warning which cannot be trusted is worse than none,
because it is the one that teaches players to read past all the others.

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

### The first morning is empty

Nothing is delivered on day one. No goods, no card, and **no pallets** — the
paving outside is bare paving, exactly as it is during service.

A kitchen opens with $0, so a day-one delivery is four things a room cannot buy,
and the first thing it would ever learn about the shop is a refusal. Worse, it
is four things to walk out and look at on the one morning when everything worth
knowing is inside the walls: one dish, one room, and a sign by the door. Day one
is the thinnest the game will ever be, and that has to include the half of it
that is outside.

It is also just true. A delivery arrives because there is a restaurant to
deliver to, and on the first morning there is not one yet — you open it that
day. The van comes tomorrow, once somebody has ordered something.

So it is one rule, `FIRST_DELIVERY_DAY` in `data/economy.ts`, asked by both the
roll and the renderer: no offers land, the squares stay where the level put them
and nothing is drawn on them. The same shape as the two rent-free days, and for
the same reason — *the days a room has no say in are the days it is not charged
for and not sold to.*

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

Two of the four squares are spoken for. One is promised to a kind the kitchen
owns fewer than two of *and has a use for*, and which is **not an upgrade** —
see below. The other holds a [recipe card](the-menu.md), whenever the library
has anything left to offer. Four duds is a shop players stop walking to, and a
shop nobody walks to is a feature that has quietly stopped existing; the two
promises leave two wildcards, so a morning is legible without being fixed.

They are never the same square, and neither square is fixed: both are rolled,
or a guarantee would always be sitting in the same place and stop reading as
luck. The promised slot is still rolled *by weight* — evenly made a fryer as likely as a counter, because a lean kitchen is
short of nearly everything, and throughput turned up on four mornings in six.

The two rules together do something neither was designed for, and it is worth
keeping. On a lean kitchen the shortlist is most of the catalogue, so the early
shop offers roughly evenly — it shows you what you are missing. As the kitchen
fills up the shortlist empties and the tiers come through as written. Measured
over four hundred mornings, on the three-square delivery — **due a re-measure**
now that there are four squares and one of them holds a card:

| | day one | settled |
| --- | --- | --- |
| staples (counter, crate, table) | ~11% each | ~16% each |
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
| **Steel board** $70 | prep at 2.75x, against the wooden board's 1.75x | speed |
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
  It is load-bearing now that a card is the ordinary way to get your first of a
  station: it is all that stands between a $100 card and a $320 oven, so it has
  a test of its own.
- **As rare as throughput**, and several days dearer. A slot holding one is a
  thing to plan a week around, which is why it is worth seeing before it is
  affordable.

The `upgrades` column names the plain kind an upgrade improves on. It is typed
`string` rather than `ApplianceKind` — the union is derived from the table the
column sits in, and a column typed by its own keys is a circular type — so
`data/validate.ts` checks what the type would have: that it names a real kind,
that it does the same job, that it costs more, and that it is not somehow worse.

### Boards go on counters

A chopping board is a **fitting**: it is set on a counter's worktop, and the
counter then chops at the board's speed. It owns no tile of its own.

That is what a board has always *looked* like — the model is a block let into a
worktop, with a knife lying on it — and making it true costs prep capacity
nothing in floor space, which is the scarce thing in a small kitchen. It also
makes the first board a room buys the first purchase that makes it *faster*
rather than *bigger*, which is the distinction upgrades are about and which a
board-shaped counter blurred.

Three rules, and they are all consequences of "there is no such thing as a board
on the floor":

- **`canPlace` refuses everything but a bare worktop.** A fitting has no state
  in which it stands on a tile, so there is no placement that could produce one.
- **The board comes off before the counter under it.** It is the thing on top,
  it is what the hand reaches, and taking it first is what makes fitting one
  reversible without a second verb. To move the counter itself, swap something
  onto it — the counter comes up board and all, which is also what happens when
  a level, a save or a disconnect has to move one.
- **It is a `topper` on the host, not an entity.** A fitted board is a property
  of its counter, exactly as a crate's stock is a property of the crate. It
  becomes an `Appliance` again only while somebody is carrying it, which is why
  `sim/world.ts` has `fittedDef`: **every** rule about work asks the host what
  is on it rather than what it is.

Because it is only an entity while it is being carried, both of the places that
have to deal with a *carried* appliance deal with it by putting it down on a
worktop rather than on the floor: a player disconnecting (`returnAppliance`) and
a save being written (`parkFittings`). A save otherwise discards everything
mid-flight, and a board in a hand looks like one of those — it is not, it is an
appliance somebody paid for, and losing it to a server restart is the same harm
as losing an oven.

### Plate stacks come stocked

Plates used to be for sale one at a time, and they were the only offer in the
shop that was not an appliance. That made them the only purchase the morning
could not actually put down: the build phase understands *appliances*, so the
grab meant to set a bought plate on a counter lifted the counter instead.

So the shop sells **plate stacks**, and a stack arrives with four plates on it.
Every one goes through `mintPlate` in `sim/plates.ts` — named, exported, one
caller — so that "where do plates come from" stays a question with one honest
answer rather than a `makeItem` call somewhere in a shop.

Conservation means *no destruction*; creation is allowed here and has to be
auditable. The undo is what makes that work both ways: putting the stack back on
the slot it came from deletes it and its plates together, so the till and the
crockery both end up where they started. A stack that no longer holds the plates
it was sold with is refused — otherwise buying, unloading and refunding would
mint four plates for nothing.

## The ledger

Prices are the `price` column in `data/appliances.ts`, in four tiers:

| Tier | Items | What it costs you |
| --- | --- | --- |
| Staples | bin $10, crate $15, counter $20, board $25 | felt on day 1–2 |
| Capacity | table $40, sink $50, plate stack $100 (four plates) | a good day's profit |
| Throughput | fryer $120, oven $160 | 2–3 days of *profit* — a saving goal |
| Upgrades | steel board $70, bell oven $320 | a week of them — a plan |

The **end-of-day card** is a receipt, and it is laid out like one: what the day
did (served, and orders lost *by recipe*), then the money in and out (earned,
tips, rent), then a ruled-off total — `In the till`. Amounts are a right-aligned
column in tabular figures, signed, green in and red out.

It used to be two sentences of dot-separated terms, and the difference is not
decoration: `Earned $40 · Tips $12 · Rent −$20 · Balance $92` makes the reader do
the arithmetic *and* work out which way each number points. A morning is spent
deciding what to buy, and "where did yesterday go" should be answerable by
looking down one column.

Walkouts by recipe are the line that earns its place twice over: "four walked
out" is a number, "four pizzas walked out" is a diagnosis, and the difference is
whether the morning knows what to buy. A row with nothing to say — no walkouts,
no rent yet — is **removed** rather than shown as a zero, because the two cards
that happen on are a clean day and the first days of a run, which are exactly the
cards that want reading quickly.

None of it is recoverable from `money`/`served`/`lost`, which are cumulative, so
the day counts itself as it goes (`world.today`). Dismissing the card is *shell*
state — one player folding it away must not fold it away on everybody else's
screen.

## The rent

The shop used to be a decision with no downside. Money only ever went up, so
buying nothing was always safe, saving was free, and "we can't afford the oven"
was a sentence about patience rather than about risk. The rent is what makes a
morning's spending a **bet** — and it is what turns selling something back at
half price into a move rather than an undo button.

It is charged in `endDay`, before the day number rolls over, so it lands on the
ledger of the day that paid it and the morning opens on a balance that is
already true.

| | |
| --- | --- |
| Days 1–2 | free |
| From day 3 | `$20`, plus `$5` for each day after it |

The two free mornings are the two a room has no say in: day one is one dish and
whatever the level handed you, day two is the first morning with money worth
spending. Charging before a kitchen has made a single decision is charging it
for the tutorial.

The step is deliberately **shallower than the takings curve**. Parties, shorter
arrival gaps and dearer dishes all arrive on their own, so rent is a floor under
the economy rather than a race with it.

### The debt is the whole design

A shortfall is not a refused transaction. The till simply goes **negative**, the
log says so, and the room has until the next closing time to get back to zero.
Only failing *that* ends the run.

So losing takes two closings and a warning in between, and the day in the middle
is a real one: serve well, or walk out to the stall and sell the oven you cannot
afford to keep. Nobody is ever evicted by surprise — the morning card says what
tonight costs before the sign is turned, and a debt is on the card, in the log,
and in the corner of the screen in red.

A kitchen that recovers and then goes under again the following week is a
kitchen living hand to mouth, which is a thing this game should be able to be.
Only two closings in the red *running* is a loss.

### What was wrong with the first rent, and what is different

There was a nightly rent here once and it was removed, for a reason that still
holds: **a number that arrives while nobody is looking is a worse teacher than a
price tag.** That version charged from day one, refused nothing, explained
nothing, and the day it took your last $30 you found out by looking at the till
the next morning.

What is different is not the charge, it is everything around it: it starts after
the kitchen is yours, it is announced on the morning card *before* the day it is
due, a shortfall is survivable, and the failure it eventually causes is named on
screen rather than inferred from an empty balance.

### Eviction

`world.evicted` is the only end state the game has, and it is deliberately
**inert**. Nothing is destroyed, the kitchen stands exactly where it was left,
and the sign simply will not open another day. What ends a run is a rule; what
starts the next one is a player choosing to, from the pause menu — which is the
existing reset, relabelled *Start again*.

That reset is the one place the "a reset keeps the menu" rule is suspended. A
new run inheriting the old menu would open on day one with customers ordering
pizza in a kitchen with no oven and no takings to buy one with.

It is **saved** (schema 6). A repossessed kitchen that comes back from disk able
to open again is not a lose condition, it is a loading screen.

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

Four things make that work, and not one of them is an object:

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
  existed because a stall is a structure and structures are straight. Four
  independent objects can go wherever a delivery lands, so they are **rolled
  each morning**: paving within a few squares of the door, never the row people
  walk in along, each turned by its own `jitter` like everything else in the
  game. The level still lists four squares, because a level says what a kitchen
  has; where they stand is only true of the first morning.
- **A recipe had nowhere better to be.** The posters were the last thing outside
  that existed because the game needed somewhere to put an offer, and the
  delivery is where offers live. One fewer kind of place, one more thing on a
  pallet.

All the renderer draws is a **pallet** under each — about the least a delivery
can stand on, and the one thing that says *this was dropped off* rather than
*this is a display*. An empty one is how a square says the morning's delivery
has already been carried inside, and a lone plate gets something to sit on
instead of a bare slab. Everything vanishes at opening: the goods, the pallets,
the lot.
A delivery not taken in by the time you turn the sign was collected, which is
both the truth about the simulation (the squares re-roll overnight) and the
reason nothing out there needs a closed state at all. The shutters are gone.

### The recipe cards came in from the wall

The card stand was an easel standing a tile away from the stall; then it was a
poster pasted on the outside of the kitchen wall, one either side of the door.
Both said the same thing as the stall and the caravan had: *something about
tomorrow is waiting out here*, in a structure built to say it.

A card is a fourth square in the delivery now, with a price on it, and the wall
is bare. That is the third time the same fault has been fixed in the same place,
and it is the last object outside that existed only to hold an offer — see
[the menu](the-menu.md#what-this-replaced) for what it cost the calendar.

With the posters went `mounted` as a thing anything *outside* needs. The sign
inside the door is the only mounted object left, so `mountSeam` and the
full-height wall piece it asks for now serve one kind rather than two — kept
because the sign genuinely hangs on masonry, not because the shop does.

### What it cost

Nothing, in the end — this version is **smaller than what it replaced.** The
stall meshes, the caravan, its hatch animation, the run query that kept five
slices agreeing, the easel and six palette entries all went; what replaced them
is a pallet and `goodsModel` with the scale taken out. The cards took another
system with them when they moved onto it.

Two things still had to be true, and one is new:

- **A delivery nobody can reach is money nobody can spend.** `validate.ts` flood
  fills from the door and insists every piece of furniture has a square beside
  it somebody can stand on.
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
