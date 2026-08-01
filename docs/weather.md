<!-- What sort of day it is, and the seating it opens and shuts. -->

# The weather

Every morning is a different sort of day, and it is the only thing about a
kitchen that changes without anybody deciding it. Fair, overcast or rain, rolled
before the room wakes up and printed on the morning card before a penny is
spent.

It exists because of a piece of the map that was doing nothing. The paving
outside is walked across on the way in and used for nothing else — a ring of
ground the game had already drawn, already lit and already made walkable, with
no reason to be there after the first ten seconds of a day. The **terrace** is
that ground turned into seating, and the weather is what it costs.

## The bargain

Seats outside are the cheapest capacity in the game. There is no wall to build
and no room to extend: a table on the terrace is $40 and a patch of paving that
was already paid for. Seats inside cost the same $40 and a square of the kitchen
floor, which is the scarcest thing a room owns.

So the terrace is not a bonus, it is a **bet**. Buy your capacity outdoors and a
fair week is the best week the kitchen has ever had; buy it outdoors and it
rains, and you own furniture in a puddle while the rent goes out of the till on
the same schedule as ever.

That is the test [lessons.md](lessons.md) sets for anything that gets proposed as
difficulty: *is there an alternative to weigh it against?* There is, it costs
money, and it is the same money. Weather is not a toll because the morning card
says what today is going to be **before** the stall opens, and the decision it
changes — one more table, or a chopping board — is a decision the player was
already making.

## Two dials, and no more

A weather is a row in [`data/weather.ts`](../src/data/weather.ts) with two
numbers that matter:

- **`outdoor`** — may anybody sit outside today? This is the one that does the
  work, and it does it *through the seats* rather than around them. Arrivals
  already scale with free tables (see [the dining room](dining-room.md)), so
  shutting the terrace makes a room smaller and quieter through the mechanism
  that was already there. No new rule about demand, and no second opinion about
  how busy a room is.
- **`trade`** — how much slower the door turns whatever the seating. It carries
  the plain fact that fewer people are out walking, and it is the only thing the
  weather can say to a [drive-through](drive-through.md), which has no chairs to
  take away.

There is deliberately **nothing** about burning, walking pace or patience.
Weather that reached into the kitchen would be a rule you cannot read off the
morning card, and the morning is where the decision it exists to create actually
gets made. A rainy afternoon should change what a room *built*, not how a fryer
behaves.

Three kinds rather than two, and the middle one is the argument for owning a
terrace at all. A game that only swung between "sit outside" and "do not" would
make outdoor seating a coin flip; **overcast** is the ordinary day that costs a
little and takes nothing away, so a terrace pays for itself across a week rather
than on one morning in two.

## Day one is always fair

The same shape as the two rent-free days and the first morning with no delivery:
the days a room has no say in are the days nothing is done to it. A kitchen on
its first morning owns no outdoor table and has no money to buy one, so rain
there could only take something away without ever having offered the choice that
makes it interesting.

## The terrace is one field on a tile

`Tile` has carried two independent facts since the patio existed: `walkable`,
and `placeable`. The apron outside has only ever been the first without the
second, and the note on `placeable` said, before there was any outdoor seating,
that this is the shape it would take when it arrived — *some tiles changing
their minds about one field, rather than a special case in `canPlace`*.

That is exactly what it is. A level names its terrace as rectangles
(`LevelDef.terrace`), `buildRoom` stamps those squares `walkable: true,
placeable: true`, and everything else follows without being told:

- `canPlace` permits it, so the **placement ghost** previews it correctly,
  because the rule and the preview have always been the same function.
- `restore` accepts a saved appliance there, because it tests the same tile flag
  — so a terrace survives a refresh like the rest of the kitchen.
- `landDelivery` will never drop the morning's crates on it, because it looks
  for paving that is **not** placeable. The delivery and the terrace divide the
  apron between them with no rule that mentions either.

**Anything may be built out there**, not only tables. A fryer on the terrace is a
strange kitchen with a long walk, and the build phase's whole promise is that you
may make one. Refusing it would be a rule to explain in exchange for nothing;
what makes the terrace *seating* is the weather, not a list of permitted
furniture.

Whether a table is outdoors is then asked of the **building**, not of the terrace
list: `outdoors()` is "not inside `world.room`". That is the fact the dining room
cares about, and it is the definition that keeps working the day somebody can
carry a table out of the door and put it down on ordinary paving.

### Where each kitchen's is

| | |
| --- | --- |
| **Park Kitchen** | Two rows of paving south of the dining room, eight squares wide. Out of the door and round the corner, so an outdoor cover costs a walk an indoor one does not — and a table out there has three free sides. |
| **Beach Shack** | One row of boardwalk along the south face. The sea wall is at its back, so a table seats a couple where the same table inside seats a party of four: the beach sells space and charges for it, outdoors as well as in. |
| **Highway Stop** | None. Nobody gets out of the car, so there is nothing a table could be for. The weather still reaches it, through `trade`. |
| **Generated** | The outer row of paving in front of the dining half. Not rolled — outdoor seats are capacity, and capacity is the shop's dial rather than the seed's. |

A terrace square may not have any of the level's own **immovable furniture**
standing on it, and `validate.ts` refuses a level that does. A delivery square
marks its tile unbuildable for ever, which everywhere else is right and on a
terrace is a hole nobody can build on and nothing on screen can explain — the
pallets it belongs to move every morning and will never stand there again. The
park's and the beach's own squares were moved off their terraces for exactly
this, which is safe: those positions are only ever the *first* morning's, and
there is no delivery on the first morning.

## It is derived, and it is sent anyway

The roll is a pure function of `(seed, day)` through a stream of its own, exactly
like the morning's delivery and for the same reason: `random(world)` is consumed
by play and has diverged between two clients within a minute of opening, so
anything that must be identical everywhere has to come from something that does
not move.

Unlike the delivery, nothing a player does can change it — so the obvious move is
to derive it on each screen and put nothing on the wire at all. It is **stored on
the world and sent in the layout message** anyway, and the reason is worth
writing down because the arithmetic argument is genuinely tempting.

`world.seed` is the single input, every caller of `createWorld` currently passes
the default, and the day somebody wires a real per-room seed on the server
without doing it on the client, a purely derived sky quietly disagrees. That
would not be a cosmetic bug: the terrace is a **rule** as well as a look, so a
table that is open on one end of the link and shut on the other is a customer
walking to a chair the other screen believes is empty. The layout is where facts
like this already live — structural, a handful of changes a day, never during
service — beside the room's menu and the stall's leftovers.

It also means `setWeather` bumps the layout version itself rather than trusting
its callers, which is the lesson `restockStall` learned the hard way: **nothing
has moved** when the weather changes, so it is the easiest resend in the game to
forget, and forgetting it is a client playing a whole day under yesterday's sky.

Nothing is saved. The seed and the day both come back from the file, so the roll
comes back with them — a room that woke into a different sky from the one it went
to bed under would make restarting the server a way to reroll the weather.

## The sky

A biome keyframes its own day and `render/daylight.ts` samples that curve against
the service clock. Weather is a **shift** applied to the sampled result: three
moves over ten numbers — take the sun out, put the difference back into the flat
light so the frame does not simply go dark, and pull every colour toward one
grey.

A shift rather than a second set of keyframes per biome per weather, which would
be nine days to keep in step in order to say the same thing three times. What
"overcast" means is the same subtraction wherever you are standing.

The sun's **direction** is deliberately untouched. It is still up there, the
shadows still fall the way the hour says, and the shadow camera still has a light
to aim at. An overcast sky with no shadows at all reads as a renderer that has
stopped working rather than as weather.

The change is crossfaded rather than cut, over about a second and a half. It
happens once, between two days, and a hard cut from a bright afternoon to a grey
one is the one moment in the game that would look like a bug. While the fade is
running the sky gradient and the environment map are rebuilt every frame instead
of on their usual bucketed clock — neither is keyed on anything the weather
moves, so without it the sky behind the kitchen would hold yesterday's colour
until the hour happened to tick over.

## Deliberately not built

- **Rain.** As in: falling water. It wants a particle system, which the renderer
  does not have — the same thing standing between the game and steam over a
  fryer, and a bigger commitment than either effect is worth on its own. Today a
  rainy day is a grey one, and the morning card is what names it.
- **Wet ground.** A darker, shinier floor under rain is one material property and
  would be lovely. It is also the sort of thing that wants the rain above it to
  exist first.
- **Weather during a day.** It is rolled per day and holds for the whole of it,
  because a terrace that shut at three o'clock would evict people from tables
  they were already eating at — and the alternative, grandfathering the ones
  already seated, is a rule about waiting in a game that has enough of those.
- **A forecast.** The card says today, not tomorrow. Today is what this morning's
  spending is a bet on, and a week of known weather would turn the whole thing
  into a spreadsheet.
- **Per-biome weather.** The beach and the park roll from the same table. A
  location that could not rain would be a location whose terrace is simply
  better, and biomes are a mood rather than a difficulty setting.

---

Next:

- [dining-room.md](dining-room.md) — the seats the terrace is adding to
- [the-shop.md](the-shop.md) — the morning where the bet is placed
- [art-direction.md](art-direction.md) — the daylight curve the shift bends

[Back to the README](../README.md).
