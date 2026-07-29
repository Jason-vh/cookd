<!-- Customers: arrival, seating, patience, eating, tips. -->

# The dining room

The biggest change the game has made: serving stopped being a **sink** (post the
dish through a hatch, done) and became a **loop** (seat → order → deliver → eat
→ bus → wash). It is worth writing down *why*, because three things that used to
be abstract are now physical, and each of them paid for itself:

1. **Order capacity became furniture.** There used to be a constant,
   `MAX_ACTIVE_ORDERS = 5`. Now it is the number of tables you have placed — so
   the players choose their own difficulty during the build phase. More tables
   is more revenue *and* more chaos, which is the PlateUp trick, earned.

   That claim was half true until the stall arrived, and it is worth being
   honest about which half. More tables was more *capacity*; demand followed the
   day and nothing else, so an extra table was free money and the only reason
   not to fill the room with them was running out of floor. **Arrivals now track
   free seats, with the day curve as a floor** — an empty table pulls the next
   customer sooner. A table brings its own customers, so the two halves arrive
   together and buying one is a decision rather than an upgrade. See
   [the shop](the-shop.md#demand-follows-seats).
2. **The patience timer became a person.** The same number, drawn as somebody
   sinking into their chair. A ring going red is information; a customer
   slumping is the same information readable from the fryer, in peripheral
   vision, without looking away from what you are burning.
3. **The queue became visible before it exists.** Customers walk the biome path
   to the door, so you can *see* demand coming. A rush stops being a spawn rate
   and becomes four people on the path — anticipation and prep-ahead decisions,
   diegetically, for free.

   They walk it on **real tiles**. The approach used to be a straight line drawn
   from off-grid to the door, which was fine while outside was painted scenery;
   the [patio ring](the-shop.md#the-patio-ring) made it a place, with a market
   stall standing on some of it, so the walk in is now the same flood fill
   everything else uses.

## The lifecycle

```
         (no free table)
 arriving ──────────────> waiting ──(gave up)──> leaving
    │                             │
    │ (reached seat)              │ (a table frees up)
    v                             v
 deciding ──(3s)──> ordering ──(fed)──> eating ──(12s)──> leaving
                       │
                       └──(patience ran out)──> leaving
```

Two of those timers are load-bearing:

- **Dwell time is a throughput constraint.** A table is occupied while somebody
   eats it, so fast service means more covers per day. Table turnover became an
   economic concept without a single new UI element. It is legible without a
   gauge, too: the customer bobs over the plate and the **food on it shrinks as
   they get through it**, so the dirty plate at the end is something you watched
   happen rather than a swap. That is why the plate model keeps its contents in
   a group of their own — emptying the meal must not shrink the crockery.
- **The door queue is the overflow valve.** A short tolerated wait smooths
   spikes; somebody walking away from a full door is the visible cost of not
   having built enough tables. They wait on the paving outside rather than in
   the doorway, which is also where the stall is — so a queue you are failing to
   serve stands next to the thing that would fix it.

Patience only starts draining when the order appears, not when the customer
arrives. The walk in is a beat of calm, and the number in `data/recipes.ts`
still means what it says.

**Which chair is a coin toss**, drawn once, at the moment a seat is actually
taken. A fixed preference order made a full dining room look choreographed —
four customers sitting at the same o'clock of their own tables. The draw lives
in `seat()` and nowhere else on purpose: "is there a chair free here?" is asked
speculatively, of every table, on every tick somebody is queuing at the door,
and spending the seeded RNG on a *question* would make the answer depend on how
many tables happened to exist.

## Say yes, and let the failure be visible

**Any plate can be placed on any table.** Wrong dish? The customer does not eat,
and the bubble keeps showing what they actually wanted. The mistake is visible,
harmless, and undone by picking the plate back up. No refusal, no error sound,
no penalty beyond the walk you can see you wasted.

Matching is **by table, not by ticket juggling**. The bubble over the table *is*
the ticket, which is why the HUD's order list is gone rather than kept
alongside: two places to read the same thing splits attention, and only one of
them can also tell you how far you have to walk.

## The tip is why bussing is not a chore

Payment is split. The **base reward** lands on delivery, on the chef who ran the
food. The **tip** — proportional to how much patience was left — stays on the
table, and is collected automatically by whoever picks up the dirty plate.

Without this, dirty plates are a toll: pure maintenance work standing between
you and the next order. With it, clearing a table is a decision you *want* to
make — "grab the tip and the plate on my way back from table 3".

That pull is what the sink inherits. Plates are finite now, so the walk to the
table is also the walk that keeps the kitchen able to plate anything at all; the
money is what makes it feel like a move rather than a chore. A pile of up to
four comes up in one pair of hands, and every plate in it brings its table's tip
with it — a sweep of three tables must not pay less than three separate trips.
The rest of that loop is [in the content model](content.md#the-plate-economy).

A table with anything on it cannot be sat at, so the tip and the seat are the
same decision under pressure: leave it and lose capacity, clear it and lose the
time.

## Pathing, and why it is allowed to be this simple

`sim/pathing.ts` is a breadth-first flood fill over non-solid tiles. No A*, no
steering, no avoidance. Two things make that enough:

- **Appliances only move during the build phase.** A path computed when a
  customer sets off cannot be invalidated while they walk it, so it is computed
  once and then followed.
- **Customers are ghosts.** They do not collide with chefs, with each other, or
  with anything except the tiles the flood fill already refused. Bodyblocking by
  pathing NPCs is the fastest route to frustration in a game about hurrying, so
  the first version simply does not have it. Gentle "excuse me" soft-collision
  can come later, if the room ever feels too empty without it.

The same flood fill answers the build phase's question: **can the door reach
every table?** A player *will* wall off the dining room in their first week. The
rule is not to prevent it — stranded tables pulse red under a warning ring, the
log says so when the day opens, and nobody is ever seated at one.

## The closing beat

Arrivals stop 30 seconds before the clock runs out, and the day does not end
until the last customer has eaten and left — `dayTime` simply goes negative
while the room empties, and the HUD clock says `last orders` and then `closing`.
"Kitchen's closed" arrives for free, and finishing the stragglers fast becomes
something to care about. A 60-second grace period is the backstop: nobody can
hold a day open forever.

---

Next:

- [content.md](content.md) — what they order
- [the-menu.md](the-menu.md) — how a room decides what that list is
- [art-direction.md](art-direction.md) — how a customer's patience is drawn

[Back to the README](../README.md).
