<!-- The conveyor: work the kitchen does with nobody standing at it. -->

# Automation

Everything in this kitchen used to need a chef standing at it. An oven cooks on
its own, but somebody had to walk the dough over; a fryer finishes by itself,
but somebody has to be there before it burns. Two appliances now work with
nobody present:

- a **conveyor** carries what is put on it one tile and hands it on;
- a **hopper** — a crate that empties itself — puts something on the front of
  the line.

Together they are a kitchen that makes a baked potato with everybody standing
still. Most of what follows is about the rules that decide *where* a machine
may put something, because each of them is a place one could quietly become a
second, invisible set of kitchen rules.

## A belt is a row, not a kind

It is one line in `data/appliances.ts` like every other appliance, plus one
column:

```ts
belt: { stations: [], travel: 1.2, acceptsItems: true, height: 0.58, price: 30, ... }
```

`travel` is **seconds to carry an item one tile**, and `0` everywhere else. A
faster belt is therefore a number rather than a branch, which is the same
bargain `speed` and `patience` struck for the [upgrades](the-shop.md#upgrades).

It has **no station**, and three things fall out of that without being written
down: nothing is cooked on it, nothing burns on it, and the shop will always
offer it (`unlockedKinds` treats a station-less appliance as useful to every
menu — a belt is as relevant to a salad as to a pizza). The middle one is worth
saying out loud as a design decision rather than an omission: **a run of belts
is the one safe place in the kitchen to leave a finished dish.** Buying floor
space to buy time is a trade this game did not have before.

## Which way it runs

`Appliance.dir` is the first *orientation* anything in this game has had, and it
is deliberately not a new verb. A belt is pointed **the way the chef who put it
down was facing**, snapped to a compass point:

```ts
appliance.dir = cardinal(player.facing);
```

So laying a run is walking the route dropping belts, and each one points along
it. Rotating one is picking it up and putting it down again — which is a move
the build phase already has, and it is reversible, which a rotate button on a
held ghost would also have had to be. While a belt is held, the ghost turns with
the chef, so *which way would this run* is answered at the same moment and in
the same place as *where would this go*.

The alternative was inferring direction from the neighbours — a belt beside a
belt joins the line. It is cleverer and it is worse: two belts placed facing
each other have no answer, and a run would silently rewire itself when somebody
put a counter down at the end of it.

`dir` rides the **layout** message rather than the frame, because it is decided
in the morning and never changes during service — the same reasoning as a
counter's `topper`. It is in the save for the same reason, and in
`saveSignature`, because turning a belt round changes nothing else about a
kitchen: same kind, same tile, and a run that now carries the other way.

Which appliances *have* a direction is `pushes()`, and it answers three
questions that coincide by construction rather than by luck: these are the ones
with a `dir` worth saving, the ones drawn turned rather than square to the room,
and the ones whose `progress` is a countdown rather than a transform — so also
the ones that must not be given a work dial. One cause, three consequences.

## What a machine will hand over to

One rule, `outlet`, shared by both: at the end of its travel a belt — or at the
end of its cycle a hopper — gives its load to the appliance one tile along if
and only if that appliance **accepts items, is empty, is not in somebody's
hands, and has no wall between**. There is no list of exceptions, and that is
the point:

- It is the **plain put-it-down**, not a chef's hands. Neither machine scrapes
  into a bin, takes a plate off the stack, or combines what it is carrying with
  what it meets. Those are special verbs `serviceGrab` performs, and a machine
  quietly performing them would be a second answer to "what goes with what".
- It **can** reach a table and a hatch, and food landing in front of somebody
  who ordered it is served. That is the dining room's rule and the
  [drive-through](drive-through.md)'s rule, and it stays theirs: a belt pointed
  at a hatch is a long arm, not a new kind of service. It is also the most
  interesting thing a lane can be built around, which is the open question the
  [roadmap](roadmap.md) has been holding.
- It does **not** pass through the shell or a dividing wall (`wallBetween`). A
  hatch is reachable because a hatch stands in a hole somebody already punched.

## Loading the line

A belt that can only be loaded by hand saves the *carry*, not the *trip* — a
chef still walks to the crate. The **hopper** is the other end of it: one row,
two columns.

```ts
crate:  { dispenses: true, feeds: 0,   price: 15 }
hopper: { dispenses: true, feeds: 2.5, price: 75, upgrades: "crate" }
```

`feeds` is **seconds between items pushed out**, and it is `travel`'s twin: one
column for a machine that moves what it is given, one for a machine that
produces. `dispenses` is "sold with an ingredient in it", and it exists because
the shop used to ask `kind !== "crate"` — one hardcoded name deciding what
arrives holding a tomato, which stopped being a question about crates the moment
a second appliance held one.

It reuses everything the belt established: `dir` for which way it faces,
`progress` for the countdown, and the same `outlet` rule — so a full belt stops
a hopper dead, and an infinite crate cannot flood a kitchen. It mints only once
it knows there is room, because a blocked hopper that made a tomato and threw it
away would burn an id sixty times a second, and ids are what two clients agree
about things by.

Two things about it are decisions rather than plumbing:

**It is an upgrade of a crate**, not a kind of its own. That is what keeps it
out of the shop's [scarcity guarantee](the-shop.md) — a kitchen owning no
hoppers is missing nothing, and the one slot reserved for what a room actually
needs must not spend every morning showing it a luxury. Saying so cost one line
in `validate.ts`: "the same job" was *sharing a station*, and neither a crate
nor a hopper has one, so it is now "shares a station, or both dispense".

**It is switched off while the restaurant is shut.** The appliance system runs
in the morning too, so without this a room spent rearranging its kitchen would
open the day with a tomato on every surface a hopper happened to face. It is
also just what a kitchen looks like when the sign says closed.

## When a machine cannot hand over

The load stays where it is — at the far end of the band, or at the top of the
hopper's cycle — with `progress` at 1.

**Backpressure and "this belt goes nowhere" are the same state on purpose.** A
run that has backed up is a run whose last belt is full, and a belt pointing at
a wall is a belt whose item never leaves — one rule, and the thing a player sees
is identical in both cases, which is right, because in both cases the answer is
"the far end is not taking anything".

Nothing is ever dropped. There is no such thing as an item on the floor in this
game, and a belt that ran off the end of its run would be inventing one — which
for a plate would mean inventing a way to destroy something
[conserved](the-shop.md).

### A jam is a thing you have to be able to find

Backpressure has one consequence worth stating on its own, because it is how
every automated line in this game will fail: **a line stops at whatever went
wrong at the end of it.** The obvious one is burning. Feed an oven from a belt
and nobody takes the food out, and the oven ruins it; a burnt item is still an
item, so the oven can accept nothing more, so the belt backs up, so the hopper
stops. One burnt potato and the whole line is dead.

That is the right *behaviour* — it fails safe and wastes one item rather than
sixty — and it was, until recently, completely silent. `overcook` counts up to
the moment something burns and is then reset, so a ruined dish sitting in an
oven left it looking exactly like an idle one. **Burnt food now smoulders**, for
as long as it sits there, which is what turns a machine that has quietly stopped
paying into a jam with a plume over it. See `plumeOf`.

This is the house rule rather than a special case: a badly arranged kitchen is
allowed, and the game's job is to make it *legible*, not to refuse it.

## Reusing `progress`

A belt spends `Appliance.progress` on how far along the band its load has got.
That field is documented as the progress of a transform, and a belt has no
station, so nothing else was ever going to write to it — reusing it is what
keeps the wire, the save and the render layer from each growing a second number
meaning the same thing.

It costs exactly one line elsewhere: the appliance system has to take the belt
branch **before** the transform search, which would otherwise zero `progress`
every tick on its way to deciding a conveyor cannot cook.

**And the belt has no dial.** The gauge every other appliance shows is
suppressed for anything that travels, because the item sliding across the tile
is already the readout — a ring counting the same thing down would be a second,
worse drawing of something on screen and moving.

## Ordering, and why there is none

A belt handing to a belt looks like it needs the run to be advanced in the right
order, and it does not. Handing over sets the receiver's `progress` to 0, so a
belt that has just been given something cannot pass it on until a full `travel`
later, whichever order the map happened to be walked in. The worst case is that
an item waits one extra tick — 16ms — before starting its next tile.

Two belts pointed at each other will pass an item back and forth for ever. That
is allowed. The build phase's promise is that you may arrange your own kitchen
into something silly, and this is a cheaper way to find that out than a rule
refusing to let you.

## What is deliberately not here

- **Merging on a belt.** A conveyor that assembled salads would be the whole
  prep loop automated by four purchases, and it would need its own opinion about
  which of two items is the base. Assembly is what a chef is for.
- **Corners and junctions.** A belt is a tile with a direction; a turn is two
  belts. Splitters and mergers are a machine that decides *where things go*,
  which is a much larger idea than a machine that moves them, and it should not
  be smuggled in on the back of this one.
- **A speed upgrade.** Both columns exist (`travel`, `feeds`), so a fast belt or
  a quick hopper is one row whenever it is wanted. Neither is wanted until
  anybody has a run long enough to be impatient with.
- **Anything that empties an appliance onto a belt.** A hopper produces from a
  `source`; nothing takes a finished dish *out* of an oven. That is deliberately
  not a column: an oven that ejects onto a belt is an oven that can never burn
  anything, and burning is this game's failure state. It would also obsolete the
  [bell oven](the-shop.md#upgrades), which is an upgrade sold on exactly that.
  It is a balance decision and should be made as one, priced, rather than
  falling out of "machines should work at both ends".
- **Powering anything.** There is no electricity, no fuel and no upkeep, and
  there should not be: the cost of a belt is the **floor space** it stands on,
  which is the resource this kitchen has always been short of, and adding a
  second currency would be a way of avoiding that.

---

Next:

- [the shop](the-shop.md) — where a belt is bought, and what a morning costs
- [the content model](content.md) — the appliance table this is one row of

[Back to the README](../README.md).
