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

Plates are items too (`base: "plate"`) and hold their dish in `contents`.

## Transforms (station × item → item)

Transforms are keyed by **station** (`prep` / `fry` / `bake`), not by appliance
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
counter: { stations: ["prep"], speed: 1,    ... }
board:   { stations: ["prep"], speed: 1.75, ... }
oven:    { stations: ["bake"], speed: 1,    ... }
```

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
- `motion` (`chop` / `knead` / `mix`) is a presentation hint. The simulation
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
  back on it. Nothing accepts burnt food except the bin.

## Sources (crates, plate stack)

A source appliance dispenses an `ItemSpec` and **accepts back exactly that
spec** — compared by `specKey`, with the extra condition that a container must
be empty. One rule covers crates and the plate stack, and any source added
later inherits it for free.

The alternative — a crate that swallows anything — would quietly become a
second bin in the corner of the kitchen, and "put it back where you got it" is
a rule players already know from real kitchens.

## Combines (item + item → item)

Placing a carried item onto an occupied counter looks for an order-insensitive
combine rule:

```ts
{ a: flour(),        b: water()          -> dough() }
{ a: dough(kneaded), b: tomato(chopped)  -> pizza(sauced) }
{ a: pizza(sauced),  b: cheese(chopped)  -> pizza(sauced, topped) }
{ a: lettuce(chopped), b: tomato(chopped) -> salad() }
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
until it has been washed — which today means carrying it back to the plate
stack, and will mean a sink in the next patch.

## Current recipes

| Dish | Steps | Reward |
| --- | --- | --- |
| Garden Salad | chop lettuce, chop tomato, combine, plate | $8 |
| Fries | chop potato, fry, plate | $6 |
| Pizza | flour + water, knead, chop tomato **twice** → sauce, chop cheese → top, bake, plate | $16 |

Delivery pays the reward. The **tip** — up to 40% more, proportional to the
patience left when the plate landed — is left on the table and collected by
whoever busses the dirty plate.

## Levels

Kitchens are authored as ASCII so layouts stay readable and diffable
(`data/level.ts`):

```
####################
#......#tlcfwpP===X#
#.T..T.#...........#
#........=B=.......#
D......=...........O
#......=...........O
#.T..T.#.=B=.......#
#......#.......===F#
####################
```

`#` wall · `.` floor · `D` door · `T` table · `=` counter · `B` board ·
`F` fryer · `O` oven · `P` plate stack · `X` bin ·
`t l c f w p` ingredient crates (tomato, lettuce, cheese, flour, water, potato).

The dining room is the western half of the **same grid** — one rectangle, one
collision system, no new concepts.

**The pass is a place, not an appliance.** Those two `=` tiles at `x = 7` are
ordinary counters that happen to stand in the dividing wall, and the gap beside
them at `(7,3)` is how a chef walks round. There *was* a `serving` kind: it made
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

Dough is **made, not found**: flour + water. An ingredient that arrives ready to
use is a crate that exists only to be walked to, and the pizza's first step now
teaches the combine rule that the rest of it depends on.

---

Next:

- [architecture.md](architecture.md) — why content is data and not code
- [dining-room.md](dining-room.md) — who orders it

[Back to the README](../README.md).
