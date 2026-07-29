<!-- Recipe cards: how a kitchen chooses what kind of restaurant it is. -->

# The menu

Every kitchen starts with **one dish**. On the morning of day 2, and every third
morning after it, two recipe cards stand on the apron beside the market stall,
and the room takes one. The card unlocks the dish *and delivers everything the
kitchen lacks for it* — the fryer, the potato crate — free, onto the floor,
before service.

The one-sentence version: **the level is the starting point, the cards are the
progression, the kitchen is the record of every choice** — and by day 10, no two
rooms are the same restaurant.

---

## What this replaced

`unlockDay`. A recipe used to carry the first day it could be ordered, and
before that it was the *position in the array*. Both made the calendar the
author of the menu: every room on day three had pizza, whether it had an oven,
whether anybody wanted one, and whether the last two days had gone well.

It is gone, and nothing replaced it inside `data/recipes.ts` except `tier` — a
claim about how much kitchen a dish demands, which is what the card stand rolls
against. **The order pool is now `world.unlocked`**, and there is no day-slice
anywhere in the simulation.

## Day one is the thinnest the game will ever be

One dish, and it is the **Garden Salad**: grab, chop, combine, plate, serve,
bus, wash — every core verb, and nothing that can burn. Day one is therefore
self-paced by construction rather than by a difficulty setting, and the dining
loop is the whole tutorial.

That leans on arrival pacing rather than on content. If day one drags in
playtests, the fix is a slightly faster day-1 arrival floor, or moving the first
card a day earlier. Both are tuning; neither is structure.

## The stand

Physical, like the stall, and built from the same three rules:

1. **The offer is derived, not stored.** Two cards are rolled from `(seed, day)`
   through their own generator, never from `random(world)` — which play has
   already consumed by the time anybody reaches the patio. Two clients on one
   seed see one pair of cards, and there is a test with two `Host`s that says so.
2. **The result is ordinary world state.** The cards live on the stand
   appliances and ride the layout message, so taking one is a layout change like
   an oven moving.
3. **What cannot be recomputed is written down.** `world.unlocked` is the room's
   whole history and is saved. `world.unlockedDay` is the small companion fact —
   one number doing three jobs, all of them the same fact seen from a different
   side:

   - the newest dish keeps its launch-day share of the orders while it holds;
   - a morning knows its offer has already been taken;
   - a save reloaded into a card morning is not offered the pair it already spent.

The easel is **always standing there** and the card is not. A stand that
vanished entirely would be an invisible thing to walk into on paving every
customer in the park walks over; instead it follows the stall's grammar, where
the place is permanent and whether it is *open* is legible from across the patio.

## Choosing

The reset pattern, and the same two-press shape for the same reason: `Grab` is
the button that means "yes" everywhere else in the game.

| You do | What happens |
| --- | --- |
| face a card, `Grab` | it lifts and sways — "Ada is considering Fries… (needs: fryer, potato crate)" |
| `Grab` again | the dish joins the menu, and its equipment is delivered |
| walk away, look at the other card, or wait 4s | it settles back down |
| nothing at all | both cards leave when the day opens |

**It is a choice between two, not two purchases.** Taking one takes the offer
with it. And the choice is genuinely optional: an unpicked pair simply leaves,
the next offer arrives on schedule regardless, and a room may consolidate on
purpose.

Anyone may choose, like anyone may spend the money or move the oven. The log
names them, which is the trust model this game has everywhere.

## Cards deliver their needs

Picking a recipe delivers, free, every requirement the kitchen lacks: appliance
kinds and ingredient crates. Both are **derived from the recipe data**
(`RECIPE_NEEDS` — see [the content model](content.md#what-a-dish-needs-derived)),
never listed on the card. Two opinions about what a dish needs would drift the
day somebody changed a step.

- A station only becomes a delivery if *nothing in the kitchen offers it*. Every
  counter preps and every kitchen has a sink, so in practice that means the
  fryer and the oven.
- Deliveries land on the nearest free interior tile — the same machinery that
  brings a disconnected player's oven home, so never the door and never the
  patio. Each one is logged.
- If there is genuinely nowhere to put something, **the pick is refused out
  loud** rather than the equipment being dropped on the floor. A menu the room
  cannot cook and cannot diagnose is the one outcome worth a refusal.
- Players rearrange during the same morning. That is what mornings are for.

## Launch day

On the day a recipe arrives it takes about half the orders, then joins the pool
like anything else. First contact under deliberate repetition: a dish met three
times in an hour is a dish nobody learns, and the weighting is over by the next
morning.

Exactly one number is drawn from the stream either way. Randomness spent
conditionally is randomness that makes two rooms on one seed diverge.

## The stall follows the menu

The shop stocks for *this* restaurant, not for the library:

- crates hold ingredients the room's own recipes start from — tomatoes from the
  first morning, cheese only once something takes cheese;
- an appliance kind no unlocked recipe can use has **no weight at all**. A fryer
  before fries exist is an expensive thing to buy in order to watch it do
  nothing;
- the scarcity guarantee (one slot in three holds something the kitchen owns
  fewer than two of) picks from the same filtered set, so it starts covering a
  delivered kind the morning after a card arrives.

It is a filter at roll time, never a write to `STOCK_WEIGHT`: the weights are
content, and a shop that edited them would be a shop whose tuning depended on
who had been playing.

## Saving

Schema 5 carries `unlocked` and `unlockedDay`.

- **Reset keeps them.** Reset un-wrecks the layout; it does not delete history.
  The days spent on those cards were really spent. What it does take back is the
  equipment they delivered — exactly as it takes back everything else bought.
- **Pre-card saves are backfilled** with salad, fries and pizza: those kitchens
  were played against `unlockDay`, which handed out exactly those three by day
  three, and their layouts still have the fryer and the oven standing in them. A
  schema bump is not an excuse to take somebody's restaurant away. Same
  philosophy as the essential-appliance top-up.
- A recipe id the content no longer knows is dropped on the way in. The menu is
  the order pool, and a customer asking for a dish that does not exist is one
  nobody can ever serve.

## Deliberately not built

- **A menu cap.** Nothing stops a room unlocking everything, and nothing should
  until the library is bigger than about five dishes and "which five" is a real
  decision. There is no hook for it.
- **Upgrade appliances and new stations** (a pot, a stove). The delivery rule
  asks the appliance table for the cheapest thing offering a station, so both
  arrive as data when they arrive — but nothing here anticipates them.

---

Next:

- [the-shop.md](the-shop.md) — the other place on the apron, and the morning both stand in
- [content.md](content.md) — the recipes themselves, and what a dish is made of

[Back to the README](../README.md).
