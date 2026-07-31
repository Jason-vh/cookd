<!-- The kitchen with no dining room: a hatch, a lane, and why it is a level. -->

# The drive-through

The **Highway Stop** is a kitchen with no chair in it. One serving hatch in the
outside wall, a lane of cars queueing at it, and no table, no seat, no bussing
run. It is the third level, and the first that is not a rearrangement of the
first two.

## Why it is a level and not a window

The first version of this idea was a hatch added to the park kitchen, serving
cars in the patio ring while the dining room carried on beside it. That version
has two problems it cannot solve, and both go away when the drive-through is a
*kind of kitchen* instead:

- **A window beside a dining room is a faucet.** It stands on the patio, so it
  costs no floor; it takes no table, so it costs no capacity. Whatever it earns
  is added to a room that was already earning, and no amount of tuning makes an
  addition into a decision. A whole room earns *instead*.
- **A window beside a dining room is a regression stood next to the thing it
  regresses from.** [The dining room](dining-room.md) opens by saying the best
  change this game ever made was serving ceasing to be a **sink** (post the dish
  through a hatch, done) and becoming a **loop**. A hatch in the park kitchen is
  that sink coming back, with the loop still standing beside it as the better
  option. A room built entirely on the hatch is not a regression: it is a
  different game, chosen from the join screen on purpose.

The two inspirations in the README split along exactly this line, which is the
best argument for building it this way:

| | Park Kitchen / Beach Shack | Highway Stop |
| --- | --- | --- |
| Serving | seat → order → deliver → eat → bus → wash | order → cook → hand over → wash |
| Capacity | tables you buy and place | the lane, and how fast you cook |
| Pressure | parallel: a slow table costs that table | **serial: a slow car costs every car behind it** |
| Feels like | PlateUp | Overcooked |

**The level type chooses which half of the game's ancestry the room leans on.**

## Tables are parallel; a lane is serial

Four tables are four independent orders, and a slow one costs you that table.
Four cars are a queue: the car at the hatch is standing between every car behind
it and the road, so one dish nobody has started holds up all of them. Nothing in
a dining room does this — a diner who waits forever inconveniences one table —
and it is the reason the room exists.

Two consequences are designed *for* rather than around:

- **The order arrives at the back of the lane and is served at the front.** A
  car's bubble appears when it stops, wherever it stopped, so the length of the
  lane is how much warning the kitchen gets. It is the "see demand coming" the
  path to the door already gives, as a dial the level sets.
- **The queue closes up.** Where a car stands is a function of how many are
  still in front of it, recomputed every tick — so a car being served, or giving
  up, pulls the whole lane forward. The rank comes from list order, exactly as
  the [line at the door](dining-room.md#the-line-at-the-door) does, and needs no
  state of its own.

## The loop that replaces the dining room's

With no tables there is no bussing, no tip left behind and no walk. Something
has to be the back half of the loop or this is a sink with extra steps. It
already existed, and it is the sink:

```
plate ─> cook ─> plate up ─> hand it through ─> keep the dirty plate ─> sink ─> stack
```

**The car takes the food; the plate stays.** One rule, and it is load-bearing
twice over. Plates are [conserved](content.md#the-plate-economy) — a car driving
off with one would be a hole in a count the save then writes down — and a
drive-through with no washing-up would be a kitchen with no loop at all. Every
cover comes back as a dirty plate, immediately, in the hands that served it.
Four plates and one sink is the rhythm of the whole room, which makes **plates
and sinks what tables were**: the thing the stall sells you more of when the
lane starts backing up.

The plate is scraped where it lies. Handed over from a chef's hands, it stays in
them; taken off the sill, it stays on the sill. Whoever owned it still owns it,
and the washing-up is a decision about when rather than whether.

## The hatch

A `hatch` is an appliance standing on the tile inside a gap in the shell — the
same trick the doorway plays, and it makes its own hole as it is placed, from
the placement rather than from a second field that would have to agree with it.
Being an appliance is what makes it work: the tile is solid, so nobody walks
through the wall; it accepts items, so it is a sill; and a chef facing it is
facing something the interaction rules already understand.

It is **level furniture** — immovable, never saved, rebuilt from the level like
the stall and the sign. That is deliberate and it is where the feature stops:
wall tiles are not placeable, so a *buyable* hatch would need a wall-mounted
concept in `canPlace`, in the ghost preview and in the save format. A room with a
hatch is a room that was built with one.

Two ways to serve it, and the second is the one that makes a lane playable by
one chef:

- **Hand it over.** Face the hatch carrying the dish the front car ordered, and
  `Grab`. The food goes, the plate stays, dirty.
- **Leave it on the sill.** A dish put down on the hatch is handed to whoever
  pulls up to it next. Plating ahead of the queue is how a single chef runs a
  window at all, and with two it splits the room into a cook and a server
  without either of them being a role the level assigned.

Anything else put on the hatch just sits there, exactly as it would on a
counter. Nothing is ever refused — the wrong dish waits on the sill for the car
it belongs to, which is a mistake you can see and undo.

## Arrivals

The same shape as the dining room's, counting a different noun. A dining room
pulls the next customer nearer for every free table; the lane does it for every
car-length of empty road, with the day curve as a floor. Past the end of the
lane nobody sets off at all — a queue whose tail can never be served reads as a
room failing when what happened is a road that was busy.

**One order per car.** A party in a car is three bubbles over one roof and a
single vehicle blocking the lane until every one of them is cooked: harder to
read than it is to build, and the lane is already the pressure this room is for.

## Money

There is no table for a tip to sit on, so the whole cover is paid at the hatch:
the reward, and the tip on the same "how much patience was left" formula the
dining room uses. Working it out in one place is what stops a fast cover being
worth a different amount depending on where it was served.

## What it is built out of

Almost nothing is new, which is the point.

| | |
| --- | --- |
| `sim/lane.ts` | Where the lane is, and where the `n`th car stops. Arithmetic, not pathing — the lane is straight, and `validate.ts` insists on it |
| `sim/systems/customers.ts` | `laneSystem`: arrivals, the queue, serving the front, driving off. A car is `arriving → ordering → leaving`, which is the existing state machine with `deciding` and `eating` never entered |
| `sim/walls.ts` | `edgeSeam` — the seam an edge tile stands against, asked by the door and the hatch alike |
| `data/level.ts` | `lane` on a level. **A level has a lane or it has a dining room**, so one field says which; there is no `service` flag to disagree with the furniture |
| `render/car-mesh.ts`, `render/car-views.ts` | The cars, painted out of the coats in `data/customers.ts` — a kind announces itself here too |

Nothing was added to the wire. A customer carries no "is a car" flag, because
`world.lane` already says it and both ends of a connection compile the same
level registry: a room is one kind of restaurant or the other, and a customer
who could be either would be a second answer to a question already answered.

## What it deliberately does not have

- **A speaker separate from the hatch.** Ordering at one tile and collecting at
  another doubles the per-car state to buy a beat the lane length already gives.
- **Cars that block each other physically.** Customers are ghosts to each other
  everywhere in this game; a car that gives up drives forward past the queue
  rather than reversing through the one behind it.
- **A dining room in the same room.** If a level ever wants both, it should want
  it after a Highway Stop has been played, not before.

---

Next:

- [dining-room.md](dining-room.md) — the loop this one is the alternative to
- [content.md](content.md#the-highway-stop) — the kitchen itself
- [the-shop.md](the-shop.md) — what a room with no tables spends its money on

[Back to the README](../README.md).
