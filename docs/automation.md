<!-- The conveyor: work the kitchen does with nobody standing at it. -->

# Automation

Everything in this kitchen used to need a chef standing at it. An oven cooks on
its own, but somebody had to walk the dough over; a fryer finishes by itself,
but somebody has to be there before it burns. Two appliances now work with
nobody present:

- a **conveyor** carries what is put on it one tile and hands it on;
- a **hopper** draws from the crate behind it and puts what it finds on the
  front of the line.

A crate, a hopper, a belt and an oven in a row are a kitchen that makes a baked
potato with everybody standing still. Most of what follows is about the rules that decide *where* a machine
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
it. While a belt is held, the ghost turns with the chef, so *which way would
this run* is answered at the same moment and in the same place as *where would
this go*.

That was for a long time the *only* way to point one, on the grounds that
rotating is picking it up and putting it down again — a move the build phase
already has. It is right for laying a run and wrong for fixing one: turning the
last belt of a finished run meant lifting its end and finding somewhere else to
stand, which is a walk around a machine to change a compass point. So there is
now a **turn key** as well (`R`, or `X` on a pad — the same button as prep,
which cannot collide with it because prep is a service verb and turning is a
morning one), which turns the machine you are facing a quarter turn clockwise:

```ts
appliance.dir = { x: -y || 0, y: x };
```

It is still not a new *rule*: four presses come back to where they started, so
it is exactly as reversible as the drop it sits beside, and it refuses anything
`pushes()` says has no direction rather than being a button that does nothing
for most of the kitchen. Mornings only, like every other change to the layout —
a run rewiring itself under a plate already travelling it is not a thing service
should be able to do.

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
one column.

```ts
crate:  { dispenses: true, feeds: 0,   price: 15 }
hopper: { dispenses: false, feeds: 2.5, price: 60 }
```

`feeds` is **seconds between items drawn and pushed on**, and it is `travel`'s
twin: one column for a machine that moves what it is given, one for a machine
that fetches.

### It holds nothing

A hopper **draws from the appliance behind it** — opposite its `dir` — and puts
what it finds on the tile ahead. So a line reads crate → hopper → belt → oven,
and `dir` is the flow *through* a machine rather than a property of its front.

It was briefly the other thing: a crate that emptied itself, sold with an
ingredient in it, priced at $75 as an upgrade of the crate it replaced. Drawing
from a crate instead is better on three counts, and none of them is realism:

- **The arrangement is the machine.** A hopper you buy is worth nothing until
  you have stood it between a crate and something that takes items, so what you
  are buying is a *decision about floor space* — four tiles in a row — rather
  than a better crate. Floor is the scarce resource in this kitchen, and every
  other automation cost is already paid in it.
- **One ingredient, one crate.** A self-filling hopper meant a kitchen wanting
  automated tomatoes *and* hand-picked tomatoes bought the ingredient twice.
  Now the crate you already walk to is the crate the machine draws from, and
  pointing a hopper at it is what automates the trip.
- **It is honest about the taxonomy.** A machine that needs the thing it claims
  to improve on was never an upgrade of it. Keeping the old relationship would
  have meant `dispenses: true` on a machine that dispenses nothing at all,
  purely to satisfy the validator's "does the same job" test.

`inlet` is `outlet` written the other way round, wall rule included, and what
qualifies is a **source** rather than "whatever is sitting on the thing behind
it" — see the note on emptying appliances below. Nothing is taken away from the
crate: a crate is infinite by construction, so drawing from one is minting from
its spec exactly as a chef's hands do. And because a plate stack does not
dispense, no machine in this game can create a plate.

Both ends are asked at the **top of the cycle**, never before it, so a hopper
with nothing behind it and a hopper with nowhere to put anything are the same
state: holding at `progress` 1, exactly like a full belt. One reading for every
way a machine can be doing nothing — and minting only once there is room is what
stops a blocked hopper burning an item id sixty times a second, which matters
because ids are what two clients agree about things by.

### And two decisions that are not plumbing

**It costs $60, and a crate costs $15.** Automating one feed is still the $75 it
always was; it is now two purchases, and they can be a week apart.

**It is switched off while the restaurant is shut.** The appliance system runs
in the morning too, so without this a room spent rearranging its kitchen would
open the day with a tomato on every surface a hopper happened to face. It is
also just what a kitchen looks like when the sign says closed.

The shop's `dispenses` column survives all of this with one member again — the
crate. It is kept rather than reverted to `kind !== "crate"` because it asks
what a row *is*, which will still be the right question the next time something
arrives with an ingredient in it. It also earns its keep twice now: it is what a
hopper looks for behind itself, so "sold full" and "a machine may draw from
this" are one fact rather than two lists that have to agree.

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
- **Anything that empties an appliance onto a belt.** A hopper draws from a
  *source*; nothing takes a finished dish *out* of an oven. That is deliberately
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
