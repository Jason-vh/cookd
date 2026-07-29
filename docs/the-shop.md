<!-- The morning, the market stall, and what a day is worth. -->

# The shop

A day begins in the **build phase**, and outside the door there is a **market
stall**. The two are one feature: money had nowhere to go, so it meant nothing,
and a build phase that arrived as the aftermath of a day was a place to tidy up
rather than a place to decide.

The one-sentence version: **zero new verbs, one new place.** `Grab` does
everything, the stall is the entire interface, and demand following seats makes
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
  opens the day, with the verb that already existed (`Y` / `Enter` / `Start`).
  The save has always discarded mid-day state, so this makes the resume point
  honest instead of papering over it.
- `world.day` advances when service **ends**. The HUD therefore reads "Day 4 —
  preparing", then "Day 4 — service". Cosmetic, and it is the whole reason the
  phase reads as a morning: you are standing in a day that has not happened yet,
  spending money on it.
- Mid-service joins are unchanged. Only where a *room* starts moved.

There is exactly one phase either way — close, build, open is one loop. A second
phase kind for "morning" would have been two states describing one thing.

The banner carries the only tutorial the game has: **"Press Start to open."** A
solo player on day one is standing in a kitchen that will not start until they
press something, and that is the single most important sentence in the product.
It is spent on prominence, not on a new screen.

## The stall

The shop is a **place, not a menu**. Three slots stand on the west apron of the
patio, beside the door: stocked each morning, shuttered during service. The
shutters are not decoration — they are the answer to "can I buy something
mid-rush", given from across the room without a message.

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
and **the stall made it false** — a kitchen can now buy back almost anything. A
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
than prevented.* The stall added a dozen more ways to reach the same place, and
they are all that same sentence.

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
its own. Not from `random(world)`: that stream is consumed by arrivals and
seating, so two rooms on the same seed have diverged within a minute of opening.
Anything that must look identical on every client and is not sent over the wire
has to come from something that does not move.

The *result* is ordinary world state. It lives on the slot appliances and rides
the **layout** message, which is where it belongs: a slot changes three times a
morning and not at all during service, exactly like a counter. What is left in
the slots is not derivable — it depends on what somebody bought — so it is
synced rather than recomputed. A shop that is half-derived and half-synced is a
shop where "my friend sees a different stall" is one missed field away, and no
local test catches that; [two Hosts on one seed](../src/sim/shop.test.ts) do.

Weights live in `data/economy.ts` as `Record<ApplianceKind, number>`, so adding
an appliance is a build error naming the key. `0` means "not sold", and having
to say so is the point — the alternative is a new kind that silently never
appears in a shop.

**The stall stocks for *this* restaurant.** Crates hold ingredients the room's
own [unlocked recipes](the-menu.md) start from — tomatoes from the first
morning, cheese only once something takes cheese — and an appliance kind no
unlocked recipe can use is not offered at all. A fryer before fries exist is an
expensive thing to buy in order to watch it do nothing, which is noise in the
one place the shop is trying to teach you what the kitchen is missing. It is a
**filter at roll time**, never a write to `STOCK_WEIGHT`: the weights are
content, identical in every room, and a shop that edited them would be a shop
whose tuning depended on who had been playing.

One slot every morning is promised to a kind the kitchen owns fewer than two of
*and has a use for*.
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

### Plates are the exception

A single plate is a shop item, and it is the **only path in the game that
creates one**. It goes through `mintPlate` in `sim/plates.ts` — named, exported,
one caller — so that "where do plates come from" stays a question with one
honest answer rather than a `makeItem` call somewhere in a shop.

Conservation means *no destruction*; creation is allowed here and has to be
auditable. Which is also why a bought plate has **no refund**: giving the money
back would mean destroying it.

## The ledger

Prices are the `price` column in `data/appliances.ts`, in three tiers:

| Tier | Items | What it costs you |
| --- | --- | --- |
| Staples | plate $10, bin $10, crate $15, counter $20 | felt on day 1–2 |
| Capacity | table $40, board $40, sink $50, plates stack $60 | a good day's profit |
| Throughput | fryer $120, oven $160 | 2–3 days of *profit* — a saving goal |

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

## The patio ring

The stall needed somewhere to stand that was not the kitchen, and the answer was
to make the paving real. The level grid now carries a **two-tile walkable ring**
all round the building, matching the patio the renderer was already drawing.

**Walkable = paved.** What a player sees, what collision allows and what the
simulation believes are one map rather than three that agree by coincidence —
including the customers' walk up to the door, which now routes over the same
tiles as everybody else's.

- Patio tiles are `placeable: false`. `canPlace` asks the tile, not "is this
  outside", so the ring is refused by the same rule that refuses a wall — and
  outdoor seating one day is some tiles changing their mind about one flag.
- Automatic placement (a leaver's oven going home) already avoided the door; the
  patio falls out of the same `isFreeTile` guard.
- **Wall-embedded ovens are now reachable from behind, and that is left
  working.** Interaction keeps its one rule — face the tile — and the walk
  around the building is the honest cost of using the far side.

The ring shifted every coordinate in the kitchen by two, which no migration can
honestly repair: a layout is relative to walls that have moved. So the level's
**id changed**, and stale saves are dropped cleanly rather than loaded
misaligned. That is what the id is for.

That change also exposed a bug in the server: a save it *refused* used to make
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
