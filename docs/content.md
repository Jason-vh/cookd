<!-- Items, transforms, combines, recipes and levels: everything that is data. -->

# The content model

## Items

An item is **an ingredient base plus the ordered list of processes applied to
it**:

```ts
{ base: "tomato", processes: [] }                         // raw tomato
{ base: "tomato", processes: ["chopped"] }                // chopped tomato
{ base: "pizza",  processes: ["sauced", "topped", "baked"] }
```

Matching is **exact** — same base, same processes, in the same order. That's
deliberate: doing steps in the wrong order genuinely fails, which is where the
difficulty comes from. `specKey()` flattens an item to a string like
`pizza|sauced,topped` so every lookup is a single `Map.get`.

Plates are items too (`base: "plate"`) and hold their dish in `contents` — or,
when `contents` is more plates, they *are* a pile of plates. See
[the plate economy](#the-plate-economy).

## Transforms (station × item → item)

Transforms are keyed by **station** (`prep` / `fry` / `bake` / `wash`), not by appliance
kind. Appliances declare which stations they offer and how fast they work, so
you can prep on any counter and a chopping board is simply better at it. This
keeps the convenience without making the dedicated appliance pointless — and
adding "a hob that can also bake, slowly" is one line of data.

`data/recipes.ts`:

```ts
{ station: "prep", mode: "hold", motion: "chop", duration: 2.0,
  input:  { base: "tomato", processes: [] },
  output: { base: "tomato", processes: ["chopped"] } }

{ station: "bake", mode: "auto", duration: 8.0, burnAfter: 8.0,
  input:  { base: "pizza", processes: ["sauced", "topped"] },
  output: { base: "pizza", processes: ["sauced", "topped", "baked"] } }
```

`data/appliances.ts`:

```ts
counter:     { stations: ["prep"], speed: 1,    ... }
board:       { stations: ["prep"], speed: 1.75, ... }
steel_board: { stations: ["prep"], speed: 2.75, upgrades: "board", ... }
oven:        { stations: ["bake"], speed: 1,    ... }
bell_oven:   { stations: ["bake"], speed: 1.15, patience: 3, upgrades: "oven", ... }
```

An **upgrade** is a row like any other: it offers the same station and is better
at it, either in `speed` or in `patience` — the multiplier on how long finished
food survives on it before burning. What makes it an upgrade rather than a
second appliance is the `upgrades` column naming what it improves on, which the
[shop](the-shop.md#upgrades) reads so that a luxury is never mistaken for a gap.

- `mode: "hold"` requires a player to stand there holding `Use` (chopping).
  Progress decays slowly if they walk away.
- `mode: "auto"` runs on its own once loaded (fryer, oven).
- Transforms **chain**: a tomato chops to `chopped` (salad) and chops again to
  `chopped, crushed` (pizza sauce). One ingredient reaching two dishes by depth
  rather than by branching keeps the crate count down and gives the prep station
  something to decide about.

**Holding `Use` runs straight through a finished step into the next one.** This
was briefly the other way round — a finished transform latched until the chef
let go, so you could not over-chop by accident. It was removed, and the reason
is worth keeping:

> The latch created a **dead state**. The chef stood there holding the button
> with the animation stopped and the dial gone, and nothing on screen explained
> why. That reads as a bug, not as a rule. "Hold to work" has to mean holding
> works, or the contract the whole prep station rests on stops being true.

The accident it prevented is handled with a number instead of a rule: the second
chop is the slowest prep step in the game (3s), and **that duration is the window
you have to let go** — 1.7s on a board, 3s on a counter. It was 1.8s at first,
and a scripted playthrough holding `Use` for a very natural 2.2s over-chopped
every time; doubling it made the mistake hard to make without removing the
ability to make it.

The mistake is cheap anyway: an over-chopped tomato is still a pizza ingredient,
and the bin is right there. Tuning a duration is balance. A latch would have cost
a legible interface.
- `motion` (`chop` / `knead` / `mix` / `scrub`) is a presentation hint. The simulation
  treats every hold-transform identically, but new content brings its own
  animation with it rather than needing a change in the render layer.

### Working animations

While a hold-transform is actually progressing, the appliance carries
`motion`, and three things animate off **one shared phase per appliance**:
the chef's arms and body, the knife on the board, and the food itself
(squashing on the beat). Sharing a phase is what makes it read as a single
action rather than three loops that happen to overlap. The phase is offset by
appliance id so two chefs working side by side don't look like a chorus line.

**A chop is not a sine wave.** `Math.max(0, Math.sin(phase))` rises and falls at
the same speed, which reads as waving, not chopping. `chopLift()` lifts over
~55% of the cycle easing *out* into a hang at the top, strikes in ~17% easing
*in* so it accelerates, then rests on the board for the remainder — the pause at
the bottom is what makes the next strike read as a strike. At 3.8Hz that's
roughly 10 frames up, 4 down, 5 still. A separate `chopImpact()` spikes on
landing and drives the chef's recoil and the food's squash together.

The arms **flare wide** on the way up. Anatomically that lets go of the knife,
but a chef working a counter to the north faces away from a fixed camera, and
arms held together simply vanish behind their own torso — at the previous 43°
sweep only one hand ever cleared the silhouette. Swinging them out (and up to
100°) is what makes the action visible at all.

Kneading stays a sine: slow and heavy, pushing with the whole body.

The food's squash matters more than it sounds. With a fixed camera a chef on the
far side of a counter is half-hidden, so the *thing being worked* has to carry
the read — which is also why the knife swings rather than sitting there as
decoration.

A pose must reset every channel it touches in the baseline pose above it, or it
sticks — a chef who kneaded once leant forward forever.
- `burnAfter` is derived into a reverse index, so a finished item left on a hot
  appliance gains the `burnt` process — including if a player puts a cooked item
  back on it. Nothing accepts burnt food except the bin. How long a *dish*
  survives is content; how forgiving an *appliance* is is its `patience`
  multiplier, so a bell oven is a factor on this number rather than a second
  table of burn times to keep in step with it.

## Sources (crates)

A source appliance dispenses an `ItemSpec` and **accepts back exactly that
spec** — compared by `specKey`, with the extra condition that a container must
be empty. Any source added later inherits the rule for free.

The alternative — a crate that swallows anything — would quietly become a
second bin in the corner of the kitchen, and "put it back where you got it" is
a rule players already know from real kitchens.

Ingredients are infinite; **plates are not**. The plate stack used to be a
source like any crate and is no longer one — see below.

## Combines (item + item → item)

Placing a carried item onto an occupied counter looks for an order-insensitive
combine rule:

```ts
{ a: flour(),        b: water()          -> dough() }
{ a: dough(kneaded), b: tomato(chopped)  -> pizza(sauced) }
{ a: pizza(sauced),  b: cheese(chopped)  -> pizza(sauced, topped) }
{ a: lettuce(chopped), b: tomato(chopped) -> salad() }
{ a: fries(fried),   b: cheese(chopped)  -> cheesefries() }
{ a: potato(baked),  b: cheese(chopped)  -> bakedpotato() }
```

Plating is a special case of the same interaction: **any** food item placed on
a plate — or a plate placed onto any food item — goes into the plate's
`contents`. It is deliberately not restricted to finished dishes: "why won't
this go on the plate?" is a worse experience than plating the wrong thing,
which is obvious, harmless and undone with the bin.

**A plate is a workspace.** Food that combines with something already on the
plate becomes the combined dish in place, so a salad can be assembled directly
on the plate — the move players reach for first, and refusing it taught them
nothing. Food that combines with nothing simply sits alongside, which is
exactly what stops it being eaten: a dish is *one* item, so a plate holding two
things is not what anybody ordered.

A **dirty plate** is the one plate that is not a workspace. Nothing goes on it
until it has been washed, at the sink.

That refusal looks like it contradicts "say yes", and it is the one worth
keeping: plating onto a dirty plate is a mistake you would not discover until
the delivery bounced, by which point it is too late to be information. It is
fair because the plate *looks* dirty — the model is a different colour with
leftovers on it, legible across the room. A refusal is only allowed when the
thing refusing says why.

## The plate economy

A plate is the only thing in the kitchen there is a **fixed number of**. A level
says how many (`plates: 4` for the park kitchen — one per table, plus two), they
start clean on the plate stack, and from then on the game's job is to never lose
one.

```
  delivered    ->  the diner takes their plate in front of them
customer eats  ->  dirty plate back on the table (with the tip)
     bus       ->  a pile of up to four in your hands
     sink      ->  hold Use: one plate per 1.5s
 plate stack   ->  clean, and back in circulation
```

The first line is there for [parties](dining-room.md#parties): a table holds one
thing, so a diner takes their dinner off it and the next dish has somewhere to
land. It means a plate can be **in front of somebody eating**, which is a place
`platesInWorld` has to count — a count that missed it would under-report during
service and mint the difference the next time a day closed.

**A pile of plates is a plate holding plates.** One representation, not three:
carrying a bussed sweep, the queue in the sink and the stock on the stack are
all the same item shape, so there is one thing to audit rather than three. The
**head** of the pile is its identity — what `isDirty` reads, what is drawn on
top, and the last plate the sink washes, so a half-washed pile still behaves
like a dirty one.

Batching matters more than it looks. Carrying one plate per trip is a toll, not
a decision: it makes the correct play obvious and tedious. Four per sweep makes
"clear those three tables on the way back from the pass" a route worth planning.

The sink is the one station with no failure state — nothing burns, nothing
overflows, nothing spills. The pressure is scarcity, not hazard, and a game this
noisy needs one place a player can catch their breath. It takes as many plates
as you can bring it, too: four is a limit on *hands*, and had no business
becoming the capacity of a sink.

The one thing it refuses is dirty plates on top of clean ones. The head of a
pile is what the sink reads to decide there is work to do, so a clean-headed
pile with dirty plates buried in it is washing-up nobody can ever reach.

### Nothing may destroy a plate

Everything that could is routed through `sim/plates.ts`:

| Where | What happens |
| --- | --- |
| The bin | **Scrapes**: the food goes, the plate stays in your hands, dirty |
| A customer finishing | Scrapes the plate they took, and stacks it back onto the table — or sends it home clean if somebody has since left something else there |
| A player disconnecting | Their plates go back on the stack, washed |
| Closing time | The kitchen is wiped — then counted back onto the stack |
| Lifting an appliance in the build phase | Its plates go home; the plate stack's travel with it |
| Saving | The *count* is saved, not where they were lying |

The cost of getting this wrong is not a lost plate. It is a room that cannot
serve anybody, in a state that gets written to disk, that nobody can repair from
inside the game. `sim.test.ts` counts plates across every one of those paths.

Conservation means **no destruction**; it has never meant no creation. There is
exactly one creation path — buying a plate at the stall — and it goes through
`mintPlate` in the same file, so that "where do plates come from" has one answer
rather than a `makeItem` call somewhere in a shop. `shop.test.ts` follows a
bought plate through a full day loop. See [the shop](the-shop.md#plates-are-the-exception).

There is deliberately **no plate counter in the HUD**. The stack is in the
kitchen, in front of you, and visibly empties — the same reason orders are
bubbles over tables rather than tickets in the corner.

## Current recipes

| Dish | Steps | Reward | Tier | Needs first |
| --- | --- | --- | --- | --- |
| Garden Salad | chop lettuce, chop tomato, combine, plate | $8 | 1 | — |
| Fries | chop potato, fry, plate | $6 | 1 | — |
| Bread | flour + water, knead, bake, plate | $7 | 1 | — |
| Cheese Fries | fries + chopped cheese | $9 | 1 | Fries |
| Cheesy Bread | kneaded dough + chopped cheese, bake | $10 | 2 | — |
| Baked Potato | bake a potato whole, + chopped cheese | $10 | 2 | — |
| Pizza | flour + water, knead, chop tomato **twice** → sauce, chop cheese → top, bake, plate | $16 | 3 | — |
| Loaded Pizza | a built pizza + chopped cheese → `loaded`, bake | $22 | 3 | Pizza |

Delivery pays the reward. The **tip** — up to 40% more, proportional to the
patience left when the plate landed — is left on the table and collected by
whoever busses the dirty plate.

Both numbers are what an *ordinary* customer does with the dish. Patience, dwell
time and the tip are each multiplied by the kind of person who ordered it
(`data/customers.ts`) — see [who walks in](dining-room.md#who-walks-in).

**A kitchen does not have this menu; it has the part of it that it bought.**
Every room starts with the salad and picks the rest from [recipe
cards](the-menu.md), so `tier` is what the card stand rolls against and `needs
first` is what stops a dish being offered before the dish it builds on. Nothing
here is a day number: the calendar decides only *when a choice is offered*, not
what is on the menu.

### What a dish needs, derived

`RECIPE_NEEDS` walks the transforms and combines backwards to answer "what would
a kitchen have to have before it could make this" — a set of stations and a set
of raw ingredients, per recipe. It is the same fixed point `makeableHere` runs
forwards, and it exists for the same reason `RAW_INGREDIENTS` does: a card
delivers what a recipe needs, and a hand-written list of that is a second
opinion about the content that goes stale the day somebody changes a step.

## Levels

Kitchens are structured data (`data/level.ts`): a rectangle for the building, a
list of walls, and a list of what stands where.

```ts
size: { width: 22, height: 11 },
room: { x: 2, y: 2, width: 18, height: 7 },
door: { x: 2, y: 5 },
walls: [wall(8, 2, 8, 4), wall(8, 7, 8, 9)],
appliances: [
  ...run("stall", 0, 2, 3, "y"),
  at("sign", 2, 4),
  crate("tomato", 9, 2),
  at("plates", 15, 2),
  at("sink", 16, 2),
  ...run("counter", 17, 2, 2),
  at("table", 3, 3),
  ...
],
```

The shell comes from `room` and `door` punches its one hole, so the only walls
worth writing down are the interior ones — here, the divider either side of the
walk-through gap.

### Walls are between blocks

A wall is a **line on the seam between two tiles**, not a tile of its own:
`wall(8, 2, 8, 4)` runs down the lattice line at `x = 8`, past the two tile rows
2 and 3, and the far end names the corner it stops at rather than the last
square it covers. Runs meet end to end, because that is how a wall is drawn on
a floor plan.

They used to be **solid squares**, and it cost a square everywhere the building
had an edge: a dividing wall as wide as the counters either side of it, and a
ring of floor around the kitchen that existed only to be a wall. Moving them
onto the seams handed all of it back — the park kitchen is the same size on the
outside and a column and a row bigger on the inside.

What it costs is that walls stop being a thing a *tile* can be, so nothing can
ask `isSolid` about them: they are a fact about a **step**, and every rule that
moves or reaches goes through `sim/walls.ts` instead. Pathing, the seat search
and collision all say where they are coming from now, and one rule had to be
added that a tile wall gave away free — a chef facing a wall can no longer chop
on the board standing behind it (`canReach`).

The door is the **absence** of a segment: `door` names the tile just inside it,
the seam it stands against is the one left open, and the frame the renderer
draws straddles that seam. Two facts that have to agree would be one too many.

They **used to be ASCII pictures**, and a picture is a lovely thing to read
right up until it has to say something that is not one-thing-per-cell.
Everything that was not a cell got bolted on: a flag so the sign could live in a
wall, six characters for crates that differ only by what is in them, and content
checks that counted `$` in the source text because the grid could not be asked
how many stall slots it had. `data/validate.ts` now builds the world and asks
*it* — which is also how a spawn point inside a counter, or two appliances on one
tile, became things a level cannot ship with.

### The rest of the map

The dining room is the western half of the **same grid** — one rectangle, one
collision system, no new concepts. So is the **paving** the level lists,
walkable and never placeable, which is the apron round the building and where
the morning's delivery stands. Walkable is paved and paved is walkable, so there
is one map rather than a floor plan and a backdrop that agree by coincidence —
and "nothing may be built on the paving" is what makes the goods out there
legible as goods, see [the shop](the-shop.md#there-is-no-shop).

**The level is a starting point, not an endpoint.** It has one board, two
tables, four plates — and no fryer, no oven, and two crates, because a kitchen
contains only what its menu needs and the menu is one salad. Heat and
ingredients arrive with the [recipe cards](the-menu.md) that call for them; a
second board or a third table comes from [the stall](the-shop.md). Both are the
same idea: a shop nobody needs to visit teaches nothing, and a kitchen nobody
chose is the same kitchen in every room.

Saves written against the older, richer park kitchen keep every appliance they
had: a level says what a *new* room gets.

### The Beach Shack

The second kitchen, and the reason the level registry exists: a fourteen by
eight room with the galley east of a divider on the seam at `x = 9`, and the
same rules to an opposite bargain — **a big deck and a small galley.** Three tables
standing in the open against six columns of kitchen, where the park has two
tables and eleven columns. Seats pull customers in, so the shack is busier from
day one and has less floor to solve it with — the dials the shop hands a player,
set differently before they arrive.

Every table has four free sides on purpose. This is the room that seats
[parties](dining-room.md#parties), and a kitchen that cannot cook two dishes at
once is exactly the wrong one to be handed three orders at a table.

**Which kitchen a room is, is decided once**, by whoever creates it: the choice
rides the handshake, an existing room keeps the level in its save, and a guest
who picked something else quietly loads the room's own. A level id is also what
makes a save portable — see [the roadmap](roadmap.md#saving).

**The pass is a place, not an appliance.** Those two counters at `x = 8` are
ordinary ones standing against the dividing wall where it stops, and the gap
beside them is how a chef walks round. There *was* a `serving` kind: it made
sense when food vanished through a hatch, and when that stopped being true it
was left describing nothing — a counter you could not chop on and could not
move, painted a special colour that promised a rule which no longer existed.
Deleting it cost nothing and bought a decision: the divider is now something
players can rearrange, lifting the counters for a wide opening between the rooms
or filling the gap for a single narrow one.

What the place does earn is the co-op shape. A surface at the boundary lets one
player plate-and-slide while another runs food, but the gap means nobody is
*forced* through a bottleneck — so cook, runner and busser stay things a group
discovers rather than roles the level assigns.

### Kitchens nobody drew

`data/generate.ts` builds a `LevelDef` from a seed. There is **one template** —
the *split room*, which is the shape the park and the beach already share:
patio, dining room, a divider with a walk-through and a pass in it, a galley,
patio again. The seed moves walls around inside that shape; it does not invent
shapes. Uniform-random rectangles would give three good kitchens and infinitely
many mediocre ones, and each hand-made level exists to *say something* — a big
galley against a small dining room, or the reverse.

The line between what is rolled and what is not is the whole design:

> **Seed what a player can see and change; freeze what sets the difficulty
> before they have touched anything.**

So table *placement* is rolled — free sides per table decide which parties can
be seated ([the dining room](dining-room.md)), and the build phase can undo it.
Table *count* is not: customers arrive faster when seats are free, so the count
is the difficulty dial, and [the shop](the-shop.md) is where that dial is meant
to live. Starting equipment is not rolled either — a kitchen begins on one salad
and grows through [recipe cards](the-menu.md), and a generator scattering ovens
would be fighting a system that already works.

**`levelProblems` is the specification it is written against.** A generated
kitchen is legal by exactly the standard the hand-made ones are held to:
reachability, a sign with a wall to hang on, three stall slots, plates against
tables. It earns its keep — the first draft put a table in the divider's
walk-through on one seed in ten, sealing the galley off from the dining room.
There is deliberately **no retry-on-a-bad-roll loop**: a constraint that only
holds most of the time is a bug, and a retry is how you never find out.

### Legal is not the same as good

`levelProblems` says a kitchen *works*. It says nothing about whether it is
worth cooking in, and it should not — "badly laid out" is a thing a player is
allowed to do to their own restaurant, and the build phase is where they undo
it. But that tolerance does not survive the room being generated: nobody chose
this layout, so nobody can be blamed for it.

So the walks are measured instead, in `generate.test.ts`, against the two
hand-drawn kitchens as the reference: crate to board, board to plate stack,
plate stack to the far table, table to sink, sink back to the stack. That found
a fault no validator could. The chopping board was rolled across the whole
galley, in both axes, which put it up to **ten** squares from the crate run
against a hand-made **two** — a twenty-step round trip per tomato, on day one,
before there is any money to fix it with. Both hand-made kitchens sit their
board two squares from the crates, and once the generator did too the worst seed
came back to six.

Two numbers are pinned, and only two:

- **crate to board**, for every seed, because chop-and-gather is walked for
  every ingredient of every dish and is the one loop that must not be left to
  luck;
- **the median full loop**, which has to land between the beach shack's and the
  park kitchen's. The *median*, not every seed: some rooms being harder than
  others is the point of a seed, and every appliance in that loop can be picked
  up and moved in the morning.

The rest of the spread is left alone on purpose. A kitchen whose sink is a long
way from the dining room is a harder kitchen, not a broken one, and the sink is
movable.

### A generated kitchen is a fact, not a function

The id of a generated level is a **hash of the built room** (`gen-b104fdc2`),
not of the seed. That is the `park-kitchen-3` rule enforced instead of
remembered — *changing where the walls are invalidates saves, touching the file
does not* — and two seeds that happen to produce the same kitchen share an id,
which is correct: it is the same kitchen, and a save from one belongs in the
other.

More importantly, the room's geometry is **written down** rather than
recomputed. It rides the `welcome` message and it is stored in the save. This
looks like duplication and is not:

- An id is enough when both ends compile the same registry, because the client
  already holds an independently correct copy and any drift is a reviewed source
  edit. A generator inverts that. There is no copy to point at, so the id stops
  pinning the geometry and the *bundle* pins it — a client on yesterday's deploy
  and a server on today's would build different walls from the same id, in
  silence. That is exactly the failure the id was chosen to prevent.
- It is what makes the generator **safe to retune**. Nothing ever asks the code
  what a room's walls used to look like, so tomorrow's `generateLevel` cannot
  move the walls of a room already playing — or its saved appliances with them.
- It makes `snapshot`'s rule honest. Immovable furniture is not saved because it
  is rebuilt "from the level itself, the only place that can still be right
  after the level changes". For a generated kitchen, the stored def *is* the
  level itself.

The cost is a few KB once per connection — measured at **1.4 KB**, about a frame
and a half on a link that then carries ~900 bytes twenty times a second. Both
the socket and the save file parse it back through `parseLevelDef` and then run
`levelProblems` over the result: structure and sense are two questions, and a
level can be structurally fine and still be a building with no door.

The seed comes from the **room code**, so the link that invites somebody is the
restaurant. Pick *Surprise me* on the join screen and `/#PIZZA` is a particular
kitchen, the same one for everybody who opens it.

### The Highway Stop

The third kitchen, and the first with **no dining room at all**: a long galley,
one serving hatch in the south wall, and a lane of cars coming to it. It is not
a third arrangement of the same furniture — it is the other half of what this
game is made of. See [the drive-through](drive-through.md).

The reason it is a *level* rather than a window added to the park kitchen is
that a window beside a dining room would be free money: it stands on the patio,
so it costs no floor, and it takes no table, so it costs no capacity. A whole
room built on it earns instead of adding, and the player chooses it from the
join screen knowing what they are choosing.

**Tables are parallel; a lane is serial.** Four tables are four independent
orders and a slow one costs you that table. Four cars are a queue: the one at
the hatch is standing between every car behind it and the road, so a dish nobody
has started holds up all of them. That is the one pressure a dining room cannot
express, and the whole room is built to apply it.

The loop keeps its back half in the one place there was room for it. **The car
takes the food and the plate stays**, dirty, in the hands that served it — so
every cover is a wash, immediately, and the sink is what a table was: the thing
the kitchen buys its way out of. A drive-through with no washing-up would be a
kitchen with no loop, which is exactly what [serving through a hatch used to
be](dining-room.md).

Which raises the obvious question, because a `serving` appliance was deleted two
sections ago for being a chute food vanished into. **A hatch is not a chute when
there is somebody on the other side of it.** The old one had nothing behind it
but the edge of the map; this one has a car with a face, a patience ring and
three more behind it, and it hands you back a plate. The rule that killed the
first one — a delivery has to be to *somebody* — is the rule this one is built
on.

A hatch is level furniture, like the stall and the sign: immovable, never
saved, and it makes its own hole in the shell as it is placed, exactly as the
door does. Nothing about the build phase changes, and no existing room does
either.

Dough is **made, not found**: flour + water. An ingredient that arrives ready to
use is a crate that exists only to be walked to, and the pizza's first step now
teaches the combine rule that the rest of it depends on.

---

Next:

- [the-menu.md](the-menu.md) — how a room ends up with some of these recipes and not others
- [architecture.md](architecture.md) — why content is data and not code
- [dining-room.md](dining-room.md) — who orders it

[Back to the README](../README.md).
