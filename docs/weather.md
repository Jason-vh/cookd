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
light so the frame does not simply go dark, and soften what is left.

### Weather takes contrast, not colour

The rule every number in the table is tuned against, and it was arrived at by
getting it wrong first. The obvious way to draw a wet day is the way a photograph
of one looks: desaturate hard, pull the warmth out, drop the sun, bring the fog
in. Do all four and the result is *miserable* — and misery is the one thing this
game must not say about a rainy morning, because **the mechanics are already
charging for it**. The terrace shuts and the door slows down. That is the cost,
and it is enough. A picture that piles on top turns a rainy day into something to
sit out rather than something to play.

So what a shift takes is **contrast**: the hard sun goes, the shadows fill in,
the distance softens. What it keeps is **colour** — the grass stays green, the
tomatoes stay red, and the kitchen stays warm against a wet world. A rainy day
should read as cosy, not as bleak.

For anybody turning these: `sun` down and `fill` and `ambient` up **in the same
edit**, `saturation` barely moved, and `lift` raised so shadows stay soft rather
than crushing — heavy shadow is most of what "depressing" actually is. If a change
makes the frame greyer *and* darker, it has gone the wrong way. A test holds the
floor: colour survives every kind of day, some sun always gets through, and what
the sun loses the flat light gains.

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

## It actually rains

And it rains **outside the walls only**, which is the whole reason it is worth
drawing. You can watch the terrace get wet while the kitchen stays dry, so the
rule the weather is playing by is a thing you can see rather than a sentence on
a card. A picture that teaches the mechanic beats one that decorates it.

[`render/rain.ts`](../src/render/rain.ts) is one instanced mesh and two uniforms
a frame, because **rain is not a particle system**. Nothing is born and nothing
dies: a drop's height is `fract(seed + time × speed)`, its ground position is
fixed, and when it reaches the floor it is the same drop starting again at the
top. That is arithmetic, and arithmetic belongs in a vertex shader.

Worth being precise about, because the roadmap listed rain beside steam and
sizzle as though they were one job. They are not. A burst of steam is a few dozen
particles with lives, spawned by something that *happened*, and it wants a pool
and a CPU update loop — the shape [`render/popups.ts`](../src/render/popups.ts)
already has. Rain is a whole field of drops that are always there. Running the
second through the first would mean writing a matrix per drop per frame to
reproduce a `fract()`.

How hard it comes down is three constants — how many drops, how visible, and how
long the streaks are — and they are worth turning **together**. Rain is the one
effect in this game that sits behind everything the player is trying to read, so
the way it fails is not that it looks wrong but that the kitchen got harder to
see. Dense short faint rain and sparse long bright rain are both weather; dense
long bright rain is a curtain.

Three details carry it:

- **The box follows the camera; the drops do not.** Enough rain to fill a
  22-tile park is mostly rain nobody is looking at, so the field is a box around
  the ground in shot — the same corners the shadow map is aimed with. The drops
  inside it are wrapped into world space with a `mod` rather than carried along,
  because a drop that moved when the camera did would read as a windscreen.
- **A drop breaks when it lands.** Over the last few percent of its fall the
  streak flattens into a tick and fades. It costs one `mix`, and it is the
  difference between rain that hits the ground and rain that passes through it.
- **Density and opacity together.** The count says how hard it is raining and
  the alpha carries the crossfade between two days. Fading alone leaves a full
  downpour of ghosts on a drizzle; thinning alone makes the last few drops pop
  out one at a time.

How much water falls is `Weather.rain`, which sits beside `sky` rather than
inside it: a `SkyShift` is what the weather does to a biome's *lamps*, and this
is water. Keeping them apart is also what leaves room for a drizzle — fully
overcast and barely wet is two numbers, not a fourth row. The simulation never
reads it: whether the terrace is open is `outdoor`, and a rule that depended on
how many drops the renderer happened to be drawing is a rule the server could
not answer.

`?weather=rain` in development holds the sky at one kind of day, because the
alternative is playing until it rains. It writes the world's own field rather
than overriding the *drawing*, so the terrace shuts when the picture says it has
— a debug flag that let the sky and the rules disagree would be worse than none,
given that what the rain is for is showing where the rule falls.

## And the ground takes it

Rain that leaves nothing behind is rain in front of the picture rather than on
it. So the ground under it **darkens and shines** while it falls, and dries out
afterwards — and the reason this is a section rather than a line is that it was
filed under *deliberately not built* for months, with a good reason:

> "the ground" is grass, sand, tarmac and paving depending on where you are
> standing, and only some of those shine.

That is still true. What changed is that it stopped being an objection to the
feature and became the **shape** of it: how a surface takes water is content,
not a constant in the renderer.

### Two numbers, because wet is two things

[`Soak`](../src/data/biomes.ts) is `darken` and `gloss`, and they are not the
same thing in different amounts:

- **`darken`** is water soaking *in*. Everything does it, and it is most of
  what the eye actually reads as wet.
- **`gloss`** is water sitting *on top*, taken off the surface's roughness. Only
  the hard flat things do it.

Wet sand goes much darker than anything else in the game and hardly gleams at
all — the tide line is that number. A paving slab goes a little darker and turns
into a mirror for the sky. A lawn does neither very much, because a shiny lawn
is a putting green. One dial for all four gives you a glossy meadow, which is
exactly what the old bullet was predicting.

So a biome owns the soak of *its* ground beside the colour of it, and the
renderer owns one shared `PAVED` for everything laid on top — slabs, the path,
the drive-through's tarmac — because a slab is a slab wherever it is laid.

### Nothing here is water

No reflection pass, no second render, no normal map. A wet surface is a darker,
less rough one, and the *sheen* is the biome's own sky arriving through the
environment map the lighting already builds. Which is why a rainy day gleams
grey: the thing being reflected is the weather.

[`render/wet.ts`](../src/render/wet.ts) is therefore a registry rather than an
effect. It hands out materials with one job — being **owned**. Materials in
`primitives.ts` are shared by colour and finish, which is what keeps the kitchen
down to a handful of draw calls and is also what would make darkening the patio
darken every other object that ever asked for the same greige. One copy per
colour and finish, so the merge still batches the paving into a single draw.

### It soaks faster than it dries

The wetness follows `Weather.rain`, the same number the drops are drawn from —
so a drizzle leaves the paving damp and a downpour leaves it shining, with no
second opinion about how wet the day is.

It is eased in over a couple of seconds and out over the best part of a minute,
and the asymmetry is the point: rain stops at a **day boundary**, and paving
that was bone dry the moment it did would say the last day never happened. The
morning after a wet day should look like the morning after a wet day.

The ease also settles: within a fraction of a percent it snaps onto the number
it was heading for, so a kitchen that has seen rain goes back to being
byte-identical to one that has not, rather than carrying a wetness of 0.0006 for
the rest of the week.

### What stays dry

The **kitchen floor**, which is the whole point — the rule the rain is drawing
is "indoors is dry", and a gleaming kitchen would contradict the drops that are
carefully not falling on it. And the **props**: a wet bush is topiary, and
nobody was ever going to read a shiny tree as weather.

## Deliberately not built

- **Puddles and ripples.** A step further than wet ground and a different
  problem: a ripple is a ring on a flat wet *surface*, and the park is mostly
  lawn. Water that pools also has to pool *somewhere*, which is a fact about the
  shape of the ground that nothing in the game currently knows.
- **Rain on the customers.** Umbrellas coming up the path would be lovely, and
  they are a wardrobe change rather than a weather one — see `data/chefs.ts` for
  the shape that would take.
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
