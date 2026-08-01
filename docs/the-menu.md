<!-- Recipe cards: how a kitchen chooses what kind of restaurant it is. -->

# The menu

Every kitchen starts with **one dish**. Every morning after that, one square of
the [delivery](the-shop.md) holds a **recipe card** with a price on it. Buy it,
carry it inside, put it down: the dish joins the menu, and everything the
kitchen lacks for it — the fryer, the potato crate — arrives free, on the floor,
before service.

The one-sentence version: **the menu and the kitchen grow out of the same till.**
A card is not a schedule any more, it is a thing on a pallet with a price, and
"second board, or fries?" is a question the game did not used to ask.

---

## What this replaced

Twice, and both times for a reason worth keeping.

**`unlockDay`.** A recipe used to carry the first day it could be ordered.
That made the calendar the author of the menu: every room on day three had
pizza, whether it had an oven, whether anybody wanted one, and whether the last
two days had gone well. It is gone, and nothing replaced it inside
`data/recipes.ts` except `tier` — a claim about how much kitchen a dish demands.

**The posters, and the card morning.** Two cards went up on the outside wall
either side of the door, on day 2 and every third morning after it. The wall was
wrong for exactly the reason the market stall and the supply caravan were wrong,
which [the shop](the-shop.md#three-attempts-and-what-was-wrong-with-all-of-them)
had already written down:

> a structure that existed only because the game needed somewhere to put a
> price.

A poster is that sentence with *a recipe* on the end. Every other object outside
the walls is something a restaurant would have anyway, and no restaurant has two
laminated dish adverts pasted either side of its own front door. A recipe turns
up because somebody delivered it — so it stands on a pallet, like the oven.

And the cadence was `unlockDay` again, one level up. The calendar no longer said
*which* dish, but it still said **when**, identically in every room, whatever
had happened in the days between. Days 2, 5, 8, 11 was a schedule with a
different author.

## Day one is the thinnest the game will ever be

One dish, and it is the **Garden Salad**: grab, chop, combine, plate, serve,
bus, wash — every core verb, and nothing that can burn. Day one is therefore
self-paced by construction rather than by a difficulty setting, and the dining
loop is the whole tutorial.

That leans on arrival pacing rather than on content. If day one drags in
playtests, the fix is a slightly faster day-1 arrival floor. That is tuning; it
is not structure.

## A card is a good

It stands in the delivery, it costs money, and it is grabbed, carried and put
down with the verb everything else uses. **Zero new verbs, and no new object** —
the card was already an appliance kind; it has stopped being furniture bolted to
a wall and become something movable.

| You do | What happens |
| --- | --- |
| face the board, `Grab` | money out, and you are **carrying** it |
| put it down inside the kitchen | the dish joins the menu, and its equipment is delivered around the tile you chose |
| put it back where it stood | **full refund** — undo, not commerce |
| turn the sign while holding it | refused, exactly as it is for a held oven |

It is drawn as an **A-frame board** with a photograph of the dish on both faces
— a sandwich board being the thing a restaurant already owns for this, which is
the test everything outside the walls has to pass. It carries no lettering at
all, because at this camera a panel is forty pixels across; the words are on the
card that appears when you face it. See
[a photograph, not a model](art-direction.md#a-photograph-not-a-model).

It is also the one delivery that arrives **without a pallet**, because it stands
on its own feet.

There are only two endings because the paving decides: nothing may be placed
outside, `canPlace` asks the tile, so a card in your hands either goes in or
goes back. Nobody has to be told that, and there is no timer, no confirmation
and no armed state to explain.

That deletes the whole arm-and-confirm dance the easel needed — `ARM_SECONDS`,
`armedBy`, `armTime`, the system that watched for somebody walking away, and the
rule that only one card could be lifted at a time. All of it existed to answer
"did you mean it", and carrying a thing across a room already answers that.

**The tile you choose is the anchor.** `unlockRecipe` takes the position it was
committed from, and the delivery lands on the nearest free interior tiles to it
— so where you set the card down is where the fryer arrives. Setting it down in
the corner you want the fryer in is the same gesture as deciding.

### The one refusal

If there is genuinely nowhere for the equipment to go, the **placement** is
refused out loud and you are still holding the card — which means you are still
holding a full refund. A menu the room cannot cook and cannot diagnose is the
one outcome worth refusing, and this version refuses it before the money is
gone rather than after.

## What a card costs

`TIER_FEE` in `data/progression.ts`, by the same `tier` the roll is weighted by:

| Tier | Fee | Dishes |
| --- | --- | --- |
| 1 | $30 | salad, fries, bread, cheese fries |
| 2 | $60 | cheesy bread, baked potato |
| 3 | $100 | pizza, loaded pizza |

The equipment on top is **free, and only what is missing** — `missingFor` asks
the world, so a kitchen that already owns an oven is not sent a second one, and
a kitchen that sold its board still counts as able to prep because every counter
can.

So a card advertises its own value, and the number is not the whole story.
Standing in front of the board gets you the card itself:

> **Fries** — $30 · +$6 a plate
> *Cut this morning, fried to order, salted while they spit.*
> Delivered with it: fryer, potato crate

The last line is `deliveryLabel`, which was the second half of the poster's face
and now earns its keep as the reason for a price. "Nothing to deliver" is worth
saying out loud: it is the difference between a card that is also a free fryer
and a card that is only a dish. Waiting for the one that ships a fryer is a
smart play, not an exploit — that is what the card *is*.

### Cards buy stations; the shop buys throughput

This is the division, and it is the point of the fee being flat:

- **Your first fryer is free**, and it comes attached to the reason you wanted
  one. A room does not buy an oven and then go looking for something to bake.
- **Your second oven is $160**, and so is the one you buy to stop queueing
  behind the first. Capacity is what the shop sells.
- **Upgrades are never delivered.** A card delivers *the cheapest movable
  appliance that offers the station*, derived from `data/appliances.ts` rather
  than named here. That rule was written as a footnote before upgrades existed
  and it is now load-bearing: it is the only thing standing between a $100 card
  and a $320 bell oven, and it has a test of its own saying so.
- **The scarcity guarantee picks up the rest.** A kitchen with one oven owns
  fewer than two, so the morning after a card lands, the promised slot starts
  offering the second one. The throughput tier did not die; it moved from *your
  first* to *your next*.

## Every morning, and why that is not the calendar again

One of the seven delivery squares holds a card whenever there is anything left
to offer. Not day 2 and every third — **every morning there is a delivery at all**,
which is every morning [but the first](the-shop.md#the-first-morning-is-empty).

The cadence moved from the calendar to the till, which is where the
[rent](the-shop.md#the-rent) already lives. A room that spends on cards runs a
broad menu in a thin kitchen; a room that spends on equipment runs three dishes
fast; a room in debt buys neither and eats the offer. Nothing is scheduled, so
two rooms on the same seed and the same day can have completely different menus
— which is the claim the old two-card choice was making, made by money instead
of by a forced pick.

A missed card is cheap, and that is deliberate. Yesterday's affordable dish is
gone and a different one is standing there this morning, because the roll is a
pure function of `(seed, day)` and nothing lingers. Daily cadence is what makes
that fair: there is another one tomorrow.

The library is eight dishes, seven of them unlockable. **Free daily cards would
exhaust it by day nine** and hand every room the same restaurant — the fee is
the only thing that stops a daily offer being a schedule with extra steps.

The first card a room can buy lands on the morning of day 2: the first morning
anything is delivered at all, and the first morning there is money to spend on
it. That is exactly where `FIRST_CARD_DAY` used to put it — the same morning,
arrived at by having earned a day's takings rather than by reading a calendar.

### One square in seven

The delivery is seven squares — six goods and a card — and two of them are spoken
for: the card, and the [scarcity guarantee](the-shop.md#stock). They are never
the same square, so a morning reads as

> a dish, a thing you are short of, and five wildcards

The card square is rolled like the promised one, so neither is ever sitting in
the same place twice.

At seven the delivery is a **market** rather than a choice, and that is the
honest description of what changed: a lean room can afford one or two things on
it, so most of a morning is deciding what *not* to buy. The scarcity guarantee
is still a single square, so it is proportionally a weaker promise than it was.

When the library runs out there is no card, and the morning is seven goods. That
needed no special case — it is the sentence the stands already said when there
was nothing to choose.

## Cards deliver their needs

Both the appliance kinds and the ingredient crates are **derived from the recipe
data** (`RECIPE_NEEDS` — see [the content model](content.md#what-a-dish-needs-derived)),
never listed on the card. Two opinions about what a dish needs would drift the
day somebody changed a step.

- A station only becomes a delivery if *nothing in the kitchen offers it*. Every
  counter preps and every kitchen has a sink, so in practice that means the
  fryer and the oven.
- Deliveries land on the nearest free interior tile — the same machinery that
  brings a disconnected player's oven home, so never the door and never the
  patio. Each one is logged, by name and by who chose it.
- Players rearrange during the same morning. That is what mornings are for.

## Launch day

On the day a recipe arrives it takes about half the orders, then joins the pool
like anything else. First contact under deliberate repetition: a dish met three
times in an hour is a dish nobody learns, and the weighting is over by the next
morning.

Exactly one number is drawn from the stream either way. Randomness spent
conditionally is randomness that makes two rooms on one seed diverge.

`world.unlockedDay` is what carries it, and it used to do three jobs. It does
two now: the launch share, and stopping a restored save from re-offering
something. "This morning's offer is already spent" is `slot.taken`, like every
other square in the delivery — one fewer special case for having made the card
a good.

## The delivery follows the menu

The shop stocks for *this* restaurant, not for the library:

- crates hold ingredients the room's own recipes start from — tomatoes from the
  first morning, cheese only once something takes cheese;
- an appliance kind no unlocked recipe can use has **no weight at all**. A fryer
  before fries exist is an expensive thing to buy in order to watch it do
  nothing;
- the scarcity guarantee picks from the same filtered set, so it starts covering
  a delivered kind the morning after a card arrives.

It is a filter at roll time, never a write to `STOCK_WEIGHT`: the weights are
content, and a shop that edited them would be a shop whose tuning depended on
who had been playing.

## A card that nobody puts down

It exists only between being bought and being set down, both inside one
morning. Two things can interrupt that, and both answer the same way: **the
money comes back**, because the pallet it came from would have taken it back at
full price anyway, and choosing a dish on the room's behalf is the one thing
worse than a refund.

- **A chef disconnects holding one.** `returnAppliance` pays the fee back and
  the card ceases to be. Every other appliance goes home to a tile; a card has
  no home, because where it goes is *spent*.
- **A save is written while somebody is carrying one.** The card is not
  described in the file and its fee is added to the money that is. Same problem
  `parkFittings` solves for a carried board, in the currency a card has instead
  of a tile — and it keeps `snapshot` free of side effects, which is a rule the
  save format is otherwise very strict about.

## Saving

No schema bump: a card was never in the file. The offers are re-derived from
`(seed, day)` on the way back in, and a square somebody has already bought from
is emptied from `stall` — so a restored room is not offered the dish it has just
paid for, by exactly the machinery that stops it being sold a second oven.

`unlocked` and `unlockedDay` are the room's whole menu history, and they are
saved.

- **Reset keeps them.** Reset un-wrecks the layout; it does not delete history.
  The money spent on those cards was really spent. What it does take back is the
  equipment they delivered — exactly as it takes back everything else bought.
- **Eviction does not**, because a new run inheriting the old menu would open on
  day one with customers ordering pizza in a kitchen with no oven.
- **Pre-card saves are backfilled** with salad, fries and pizza: those kitchens
  were played against `unlockDay`, and their layouts still have the fryer and
  the oven standing in them. A schema bump is not an excuse to take somebody's
  restaurant away.
- A recipe id the content no longer knows is dropped on the way in. The menu is
  the order pool, and a customer asking for a dish that does not exist is one
  nobody can ever serve. The same rule covers the id on an offer arriving over
  the wire: it is checked where it is *used*, so one unknown dish cannot make a
  whole layout unparseable.

## The cookbook is a page of the pause menu

How a dish is *made* — `steps` in `data/recipes.ts` — is listed under *Recipes*
in the pause menu, for the dishes this kitchen has unlocked.

It used to be printed on the card outside, which was the wrong place twice over.
It answered "how is this made" about a dish nobody had bought yet, and it put a
paragraph of instructions on an object whose whole job is to be a picture. A
chef who wants the method is asking about **their own menu**, and the pause menu
is already where the game's other "how does this work" surface lives — the
controls table, which is the page next to it. Both are pages rather than blocks
stacked under the actions: together they made "Resume" something you had to
scroll to find.

Unlocked only, so the list grows as the room does. The whole library would be a
spoiler and a shopping list for dishes the kitchen cannot cook.

## Deliberately not built

- **A menu cap.** Nothing stops a room unlocking everything, and nothing should
  until the library is bigger than about five dishes and "which five" is a real
  decision. Money is a soft cap and may turn out to be enough.
- **Selling a recipe back.** The refund exists because you are still holding the
  card; once it is down, the dish is knowledge and the kitchen has it. A menu
  you can pawn is a menu that is inventory.
- **A card that waits for you.** Today's offer leaves with the morning, because
  a card that lingered would be state that cannot be recomputed from
  `(seed, day)` — and the whole delivery is derived, not stored.
- **Upgrade cards.** Upgrades are bought, never delivered, and that is the rule
  keeping the free station honest.

---

Next:

- [the-shop.md](the-shop.md) — the seven squares a card stands in, and the morning they all arrive on
- [content.md](content.md) — the recipes themselves, and what a dish is made of

[Back to the README](../README.md).
