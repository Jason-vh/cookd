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
   diegetically, for free. That is now literally true rather than a hope: see
   [the line at the door](#the-line-at-the-door).

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
    │ (reached seat)              │ (front of the line, a table frees up)
    v                             v
 deciding ──(3s)──> ordering ──(fed)──> eating ──(12s)──> leaving
                       │
                       └──(patience ran out)──> leaving
```

Two of those timers are load-bearing:

- **Dwell time is a throughput constraint.** A table is occupied while somebody
   eats it, so fast service means more covers per day. How long that is belongs
   to the *person* — see [who walks in](#who-walks-in) — so the number below is
   what an ordinary appetite does with it. Table turnover became an
   economic concept without a single new UI element. It is legible without a
   gauge, too: the customer bobs over the plate and the **food on it shrinks as
   they get through it**, so the dirty plate at the end is something you watched
   happen rather than a swap. That is why the plate model keeps its contents in
   a group of their own — emptying the meal must not shrink the crockery.
- **The door queue is the overflow valve.** A short tolerated wait smooths
   spikes; somebody walking away from a full door is the visible cost of not
   having built enough tables. They wait on the paving outside rather than in
   the doorway, which is also where the stall is — so a queue you are failing to
   serve stands next to the thing that would fix it. How the line behaves is
   [below](#the-line-at-the-door).

Patience only starts draining when the order appears, not when the customer
arrives. The walk in is a beat of calm, and the number in `data/recipes.ts`
still means what it says — scaled by how reasonable this particular person is
feeling.

**Which chair is a coin toss**, drawn once, at the moment a seat is actually
taken. A fixed preference order made a full dining room look choreographed —
four customers sitting at the same o'clock of their own tables. The draw lives
in `seat()` and nowhere else on purpose: "is there a chair free here?" is asked
speculatively, of every table, on every tick somebody is queuing at the door,
and spending the seeded RNG on a *question* would make the answer depend on how
many tables happened to exist.

## The line at the door

A full room grows a **line**, up to `DOOR_QUEUE` people long, standing back down
the path they walked in on. Three things make it a queue rather than a crowd:

- **It is served from the front.** Only the person at the head may take a table
  that frees up. This is not a nicety: the tick loop walks the customer list
  backwards (so somebody can be removed mid-loop), which means "whoever asks for
  a table" is *the person who arrived last*. A queue that does that is a lottery
  wearing a line's clothes.
- **It shuffles forward.** Where you stand is a function of how many are still
  in front of you, recomputed every tick, so the line closes up as it is served
  and as people give up. The rank comes from list order — customers are only
  ever appended — so the queue needs no state of its own.
- **It thins from the impatient end.** The door wait is `DOOR_WAIT` multiplied by
  the kind's own `patience`, exactly as the dish's patience is. Somebody on their
  lunch break gives up on a line for the same reason they give up on a kitchen,
  and the coats left standing there are the ones who will wait.

Past the end of the line **nobody new walks up the path at all**. A queue whose
tail can never be seated is a stream of people arriving in order to leave again:
it reads as a room failing, when what actually happened is a room that was full.
The give-up is meant to be the rare, expensive event, not the common one.

## Rushes

An arrival is not always one person. The group size is rolled once per arrival —
mostly one, sometimes two, occasionally three — and the chance of it being more
than one **grows with the day**, to a ceiling of 45%. Day one never rushes: the
room learns the loop before it is asked to hold a line.

A rush is **people, not a faster clock**. Halving the interval and spawning three
at once produce the same number of customers, and only one of them can be seen
coming: a group starts spread out down the path and walks in single file, so
three coats on the paving is a sentence — *stop chopping, plate what you have* —
thirty seconds before the first of them sits down. A shortened interval is
something you can only notice in hindsight.

Two rules keep it from being a difficulty spike with no floor:

- **A group is clamped to what the room can absorb** — free tables plus space in
  the line. The rest simply never set off.
- **The next interval is timed from the room the group leaves behind.** Arrivals
  already track free seats; taking the last three tables and *then* asking
  "when's the next one" is what stops a rush from compounding into a permanent
  queue.

A group is a **party** — see below. Three people who walked in together sit at
one table, and want three dishes inside one another's patience rings.

## Parties

A group takes **one table between them**, a dish each. That is the whole
feature, and almost none of it is new machinery: a party is a shared id and a
chair count, because everything else a party does is something a customer
already did. Each of them keeps their own dish, their own patience, their own
appetite and their own tip.

What it changes is the *job*. Two dishes for one table inside overlapping
patience rings is a different problem from two customers who happen to have
arrived together: it is the first thing in the game that cannot be solved by
doing one thing at a time well, and it is the reason a second chef is worth
having. The coordination flagship the tables were always drawn with four chairs
for.

Three rules make it work:

- **They sit together or not at all.** A party that finds no table with enough
  chairs queues *as a party* and is seated as one. A group that walks in
  together and ends up at three different tables is not a party, it is a
  coincidence. If one of them gives up at the door the rest get easier to seat,
  which is the right way round for a room that is already struggling.
- **A table is as big as its free sides.** Chairs are the walkable tiles around
  a table, so one in the open seats four and the same table shoved against a
  wall seats one. **Where the tables go decides who you can serve**, not only
  how many — a build-phase decision with a consequence you can watch walk back
  down the path. Nobody is ever rolled as a party no table in the room could
  seat: a group that can only ever stand at the door is a walkout with extra
  steps.
- **A diner takes their plate off the table.** A table holds one thing, so the
  second dish would have nowhere to land while the first was being eaten. When
  the food arrives it moves in front of the person who ordered it — which is
  also just what people do — and comes back dirty when they leave. Four plates
  around the edge of one table is what a party looks like from across the room.
- **Food is handed over, not put down.** A dish somebody at this table ordered
  leaves your hands and goes straight in front of them, whatever else is
  standing on the table. It has to work that way, because the first of a party
  to finish leaves their plate behind while the rest are still waiting: the
  table's one surface would otherwise be occupied by washing-up, and the second
  order would sit in your hands with no way to deliver it. Putting a plate
  *down* on a table is what happens when nobody there wants it yet — for a
  customer still making their mind up, who finds it waiting when they finish.

That last one is why `platesInWorld` counts customers: a plate in front of
somebody eating is a plate the kitchen still owns, and a count that missed it
would quietly mint the difference at closing time. A party leaves one **pile**
of dirty plates and one pile of coins — one bussing run, one trip, both tips.

Which of them a plate is for is decided by the dish, and ties go to **the most
impatient match**: with two people at a table waiting for the same thing, the
one whose ring is nearly empty is the one about to walk out, and feeding the
other would lose an order the kitchen had already cooked.

## Who walks in

A customer used to be one set of numbers: every diner waited exactly as long as
the dish said, ate for exactly `EAT_TIME`, and tipped by the same formula.
Demand had a *rate* and no texture.

A **kind**, rolled at the door from `data/customers.ts`, is that texture. Four
dials, each of which multiplies a number the dining room already had:

| | patience | appetite | generosity | pace |
| --- | --- | --- | --- | --- |
| **Regular** | 1 | 1 | 1 | 1 |
| **In a Hurry** | 0.6 | 0.5 | 1.7 | 1.35 |
| **Taking Their Time** | 1.6 | 1.8 | 0.9 | 0.78 |
| **Critic** | 0.85 | 1.1 | 3 | 1 |

They pull against each other on purpose. `patience` is the pressure, but
`appetite` is what happens *after* you succeed — the table is gone for as long
as they sit at it, so the easiest customer in the room can be the most expensive
one to have seated. Somebody in a hurry is the opposite bargain: half the time
to cook it, and the seat comes back twice as fast.

**A kind can only multiply.** It cannot refuse a dish, order two, or do anything
the loop does not already do, which is what keeps a new row from being a new
system — and it is why there is no fifth column for something clever. `patience`
now multiplies two numbers rather than one — the dish's, and the wait at the
door — which is the shape a dial is *supposed* to grow in: a new number the
dining room already had, not a new column. [Parties](#parties) were the thing
that could not be expressed this way, and they arrived exactly as predicted: a
change to the loop, not a fifth column.

**Every kind has to be readable across the room**, without a label and without
the HUD: a coat, a build, and a speed. That is the same rule the patience slump
follows, and it is why the coats live in `data/customers.ts` beside the numbers
rather than in `render/palette.ts` — a kind owns its look, exactly as a
[biome](art-direction.md) does. A dial nobody can see would be a difficulty
change disguised as content, so `pace` earns its place partly by being the one
that is legible before they even sit down.

The critic is the only row that is really an *event*: 4% of arrivals, three
ordinary tips, and the only one with hair of its own so that dropping what you
are doing is a decision you can make from the fryer. Nothing is written to the
event log about it. A person in the room is not news for the corner of the
screen — see [the rule about where UI lives](architecture.md#why-this-shape).

The kind is drawn from the room's own RNG stream, in **one** weighted draw
whatever the dining room looks like, for the same reason `orderFrom` spends
exactly one: randomness spent conditionally makes two rooms on one seed diverge
over who happened to walk in. And it travels on the wire as an id, like a
recipe does — an id the client does not recognise is served as a regular rather
than dropped, because content moves faster than protocols.

## Say yes, and let the failure be visible

**Any plate can be placed on any table.** Wrong dish? The customer does not eat,
and the bubble keeps showing what they actually wanted. The mistake is visible,
harmless, and undone by picking the plate back up. No refusal, no error sound,
no penalty beyond the walk you can see you wasted.

Matching is **by person, not by ticket juggling**. The bubble over a diner's
head *is* the ticket, which is why the HUD's order list is gone rather than kept
alongside: two places to read the same thing splits attention, and only one of
them can also tell you how far you have to walk. The bubble used to float over
the *table*, which was right while a table was one order and became ambiguous
the day three people sat at one — so it moved to the head it belongs over.

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
  with anything except the tiles the flood fill already refused. The line at the
  door is spaced by *arithmetic* rather than by bodies for that reason: rank
  times a gap, down the arrival row. Bodyblocking by
  pathing NPCs is the fastest route to frustration in a game about hurrying, so
  the first version simply does not have it. Gentle "excuse me" soft-collision
  can come later, if the room ever feels too empty without it.

The same flood fill answers the build phase's two questions: **can the door
reach every table**, and **can the chefs walk up to everything else**. A player
*will* wall off the dining room in their first week, and the week after that
they will box the sink into a corner. The rule is not to prevent either —
whatever is stranded pulses red under a warning ring, the log says so when the
day opens, and nobody is ever seated at a table nobody can walk to.

One fill, two origins: `unreachableTables` starts at the door and looks for
chairs, `unreachableAppliances` starts at the chefs and looks for anything they
have to face. Sharing the fill is what keeps the warning and the rule from ever
disagreeing about what "reachable" means.

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
