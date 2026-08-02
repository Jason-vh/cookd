<!-- What is next, and what has deliberately been left out. -->

# Roadmap

Near term:

- **The door queue is done**, and so are [rushes](dining-room.md#rushes): a full
  room grows a line that is served from the front and thins from the impatient
  end, and arrivals come in groups that grow with the day. What is left of that
  bullet is *presentation* — the line is people standing on paving, with nothing
  saying how long they have been there. A patience ring at the door would be the
  obvious answer and is probably the wrong one: it would put a second countdown
  on screen for something you are meant to read as a crowd.

- **Parties are in.** One table, a dish each, all wanted at once — and it landed
  as predicted: a change to the loop (a group id, a chair count, and a diner who
  takes their plate off the table) rather than a fifth column in
  `data/customers.ts`. See [the dining room](dining-room.md#parties). What is
  left of the idea is the *ordering* of a party's dishes — courses, or a table
  that will not start until every plate has landed — which is a rule about
  waiting, and this game has enough of those for now.
- **A second kitchen exists**: the [Beach Shack](content.md#the-beach-shack), a
  big deck and a small galley, in a beach biome. It cost one biome row, three
  prop builders and a `<select>` on the join screen — the level registry and the
  wire's level id were already there, waiting. What is left is *more* of them
  (night market, ski lodge) and the harder half nobody has needed yet: a room's
  level is fixed when it is created, so there is no way to move a kitchen you
  have already built.
- **The drive-through is in**, as a *level* rather than as a window: the
  [Highway Stop](drive-through.md) has no dining room at all, one hatch in the
  wall and a lane of cars queueing at it. It cost a `lane` field, a hatch that
  makes its own hole in the shell, and a second arrival loop in the customer
  system that mostly *deletes* branches — no seat draw, no dwell, no plate left
  on a table. What is left of the idea is everything a first version should not
  have: a speaker separate from the hatch, a party in one car, and a room that
  is both kinds of restaurant at once. The open design question is the one a
  dining room answers with furniture — **what a lane's difficulty dial is**, now
  that there are no tables to buy. Plates and sinks are the honest answer today,
  and they escalate the loop rather than the demand. The [weather](weather.md)
  reaches it too, through `trade` — but that is a dial the *day* turns rather
  than one the room does.

- **The weather is in**, and with it the [terrace](weather.md): the paving
  outside is somewhere a table may stand, and a rainy day is a day nobody sits
  at one. It cost a content table, a roll from `(seed, day)` beside the shop's,
  one field on `LevelDef` and one line in the layout message — because the tiles
  were already carrying `walkable` and `placeable` as separate facts, and
  outdoor seating turned out to be exactly what the note on `placeable`
  predicted it would be: some of them changing their mind about the second one.
  **And it rains**, outside the walls only, so the rule is a thing you can see
  rather than a sentence on a card. That turned out *not* to need the particle
  system it was filed under: a drop has no state anybody asks about, so the
  whole field is one instanced mesh and a `fract()` in a vertex shader. What is
  left is the ground — wet paving, puddles, a ripple where a drop lands — and it
  is held up by the fact that "the ground" here is grass, sand, tarmac and
  paving, and only some of those shine.
- **Verify the gamepad mapping** on real hardware, add per-player join/leave UI
  and rumble on burn/serve.
- **Multiplayer polish:** there is still no spectator mode and no proper
  "kitchen full" screen — just an error line and a closed socket. A player who
  stays away past the grace period also loses their name colour on return.
- **Binary frames.** JSON is ~1.3 KB a frame with four chefs in the kitchen, or
  28 KB/s to each of them, and the cost per player rises with the players
  because everybody is sent the whole world. That is fine for a room; it is
  ~105 KB/s of egress for a room of four, and the box holds 200 of them. If that
  ever becomes the limit, the encoder is one file and the format is already
  split static/dynamic. See the table in [multiplayer.md](multiplayer.md).

- **Upgrade appliances are in**, two of them: a [steel board and a bell
  oven](the-shop.md#upgrades), one buying speed and one buying time. They cost a
  `patience` column and three rules in the shop, because a better appliance is a
  row rather than a tier. What is left of the bullet is the kind that cannot be
  spelled in the existing columns — a **double fryer**, which is two baskets and
  therefore an appliance holding two items. Everything in the game assumes
  `appliance.item` is one thing or nothing, and that assumption is worth more
  than the dish.
- **The rent is in**, and with it the game's only lose condition: a standing
  cost at closing time, a debt you may carry for exactly one day, and eviction
  if you cannot clear it. See [the rent](the-shop.md#the-rent). It cost a curve,
  twenty lines in `endDay`, a flag on the world and a schema bump — because the
  hard part was never the rule, it was deciding what losing is allowed to *do*
  to a kitchen somebody built. It does nothing: the room stands, and reset is
  the only way out, taken on purpose. What is left of the idea is the half a
  run-based game would want next — a **score to beat** on the closed-down card,
  and somewhere to keep it. Right now a lost run leaves nothing behind but a
  fresh kitchen.

- **Automation has started**, with a [conveyor](automation.md): a belt carries
  what is put on it one tile and hands it to whatever is at the far end, which
  makes it the first appliance in this kitchen that works with nobody standing
  at it. It cost a `travel` column, an `Appliance.dir`, and a branch in the
  appliance system — because a belt has no station, so `progress` was free to
  mean something else and nothing on it can burn.

  `dir` is the more interesting half: it is the first *orientation* anything
  here has had, and it is set from the facing of whoever puts the belt down
  rather than from a rotate button, so laying a run is walking the route.

  The **hopper** followed immediately, and had to: a belt that can only be
  loaded by hand saves the carry rather than the trip, so automation began in a
  chef's hands and went nowhere. It is a crate that empties itself onto the tile
  it faces — one row, an upgrade of the crate, and it reuses the belt's `dir`,
  its `progress` and its backpressure rule outright. A hopper, two belts and an
  oven now make a baked potato with everybody standing still.

  What is left is in two piles, and they are not the same size. The small one is
  **taking things out** of an appliance rather than putting them in, which is
  one column and one large balance question: an oven that ejects onto a belt is
  an oven that never burns anything, and it obsoletes the bell oven. The large
  one is everything that decides **where things go** rather than moving them —
  splitters, junctions, a belt that sorts — which is a much bigger feature
  wearing this one's clothes and should not be smuggled in on the back of it.

  The thing to watch is the **drive-through**: a belt to the hatch is the first
  honest answer to what a lane's difficulty dial is, now that there are no
  tables to buy. It is also the first thing in the game that can serve a
  customer without a chef in the room, so it wants a day of play before anybody
  builds more on top of it.

- **A menu cap** — [recipe cards](the-menu.md) ship without one: nothing stops a
  room unlocking the whole library. Deferred on purpose until the library is
  bigger than about five dishes, because "which five do we keep" is only a
  decision when keeping one means dropping another. Cards cost money now, which
  is a soft cap and may well be enough.
- **More content** — soups (pots + liquids), drinks, sides.
- **Juice.** The [sounds are in](sound.md) — pickup, serve, tip, burn, door
  chime, the day opening and closing, synthesised rather than sampled. What is
  left of it was the *visual* half, and **most of that is in**: a working fryer
  or oven steams, and anything burning smokes — which is the half that was
  actually about the game rather than about the polish, because burning is the
  failure state and the dial was the only thing saying so. See [art
  direction](art-direction.md#steam-and-smoke).

  [Rain](weather.md) turned out not to need the same machinery at all: a
  downpour is a `fract()` with no lifetimes in it, and a puff is a pool of
  things that are born, rise and go. What is left is **screen shake** on a burn,
  which is a change to the camera rather than to the kitchen and is still not
  obviously worth it now that smoke does the same job without touching the
  frame; and **chop bits**, which are decoration on an action you are already
  looking at.
- **Chef–customer soft collision** — a gentle "excuse me" nudge, if the dining
  room ever feels too empty with everyone walking through each other.
- **Rendered icons** — render each ingredient once to a texture with an
  offscreen camera, then reuse it on crates. Consistent 3D icons with no
  illustration work.
- **Throwing** — an extra button to toss items across the kitchen.

Bigger:

- **Delta frames and interest management.** Only send what changed, and only to
  players who can see it. Neither is needed at one kitchen per room.
- **Kitchen validation in build mode is done**, in the one form that survives
  contact. `kitchenWarnings` says at day open when a dish on the room's own menu
  cannot be made here, derived from the recipes rather than from a list of
  appliances, and `unreachableTables` says when the door cannot reach a chair.
  Both are warnings: see the note on `ESSENTIAL` for why refusing the sale is
  the wrong instrument.

  There was a third, and it was **removed rather than tuned**: a warning about
  appliances the *chefs* could not walk up to, built on the dining room's
  four-way flood fill while a chef reaches diagonally. It fired on kitchens that
  worked. A check written against a different actor's rules than the thing it is
  checking is not a tuning error. The level content is still held to it
  (`levelProblems`), where the question is about a building nobody has
  rearranged yet.

  What is *not* checked is anything about how far things are from each other: a
  kitchen may be terribly laid out, and that is the game.
- **A run-based meta layer** à la PlateUp. [Procedural
  kitchens](content.md#kitchens-nobody-drew) are in — one template, seeded from
  the room code — but they are worth much less on their own than they look. A
  room keeps its kitchen for ever and it is saved, so today a generated building
  is a one-time coin flip whose only visible effect is that some rooms got a
  worse restaurant than others. Randomisation pays rent when you get a *new*
  kitchen each run, which is the half that is missing. The generator was still
  worth doing first: it is where the second template, and any notion of a
  kitchen being *good* rather than merely legal, has to be worked out.

## The build phase

The build phase is the **morning of the upcoming day**, and it is where the shop
lives. [the-shop.md](the-shop.md) covers the delivery outside the door, the
end-of-day card and the paving both stand on; what follows is the part that
predates all of it.

A held appliance is drawn as a **ghost standing on the tile it would go to**,
not carried on the chef's head. Balancing an oven on someone's hat is funny
once; it also puts the thing you are deciding about in the one place you are not
looking. The decision here is "does it go *there*", so the preview belongs
there — and because the ghost slides between tiles rather than snapping, it
doubles as a readout of which tile you are actually pointing at.

The ghost always answers "where would this go". Whether it **settles** onto the
tile or **hovers** above it answers "can it" — two questions, two channels, with
the highlight underneath turning red as a third. Off the grid entirely there is
no tile to point at, so it stays with the chef.

Ghosting clones the object's materials once per appliance and caches them.
Materials are shared between appliances of the same kind, so making one
see-through by editing its material would make every counter in the kitchen
see-through.

Dropping onto an occupied tile **swaps**: theirs comes up as yours goes down.
Rearranging a kitchen is mostly exchanging two appliances, and making that a
single action beats hunting for a free tile to park one on. Swapping rather than
destroying also keeps it reversible — and now that the stall will buy an
appliance back at half price, reversible is a thing the whole phase promises
rather than a property of one interaction.

`canPlace()` lives in `sim/queries.ts` and is used by both the rule and the
ghost, so the preview and the placement can never disagree. It asks the *tile*
whether it is placeable rather than asking where the building ends, which is
what keeps the paving out of the kitchen without the function growing a
concept of "outside".

## Saving

`src/save.ts` defines the format; **where** a save is kept is deliberately not
decided there. The server writes one JSON file per room (`server/store.ts`), and
the browser keeps nothing about the kitchen at all.

That split arrived with multiplayer, and it is the right one. A layout stored
per-browser would mean four players each holding a different opinion about where
the oven is. What genuinely belongs to a person rather than to a kitchen — your
name, how many of you share this screen, your appearance later — stays in the
browser, in `src/identity.ts`.

Only what a *player* changed is stored: appliance layout, money, day, how many
plates the kitchen owns, and which stall slots have been emptied. Items
mid-flight, orders and timers are deliberately discarded: a save that restores a
half-chopped tomato and a ticking order is a save that can restore a broken
game, and none of it is worth resuming.

**Immovable appliances are not stored at all.** Walls and the market stall are
furniture of the *place*, not of anybody's build, so `restore` rebuilds them from
the level itself. Storing them would mean every save carrying a copy of the
level — and a save written before a stall existed describing a kitchen with none.

The stall's *stock* is not stored either, because it is a pure function of the
room's seed and the day. What cannot be recomputed is what somebody already
bought, and without it "restart the server" would be a way to reroll the shop.

Plates are the exception that proves it. They are finite, so they cannot simply
be dropped with the rest of the crockery in flight — but *where* they were lying
is exactly as worthless as a half-chopped tomato. So the save stores a **count**
and the load puts them all back clean on the stack. Restoring the washing-up is
nobody's idea of resuming a game.

It lives outside `sim/` on purpose. The simulation must not know storage exists.

Not a database, and it should not become one: a save is under 2 KB, is written a
few times a day, and being able to read or delete one with `cat` and `rm` is
worth more than any query ability we would ever use.

Two guards stop a stale save corrupting a session:

- `schema` — bumped when the snapshot shape changes. Older saves are migrated
  one version at a time, never dropped.
- `level` — the level's id, so a layout change is a deliberate act with a name
  rather than a side effect of touching the file.

A third rule covers what those two cannot: **a restored kitchen is given back
any essential appliance its file has none of.** There is no way to sell an
appliance, so a kind the level provides and the save never mentions means the
save *predates* it — which was harmless when new content meant a new crate, and
stopped being harmless with the sink. Every save written before it existed
describes a kitchen where a dirty plate can never be used again, and with plates
finite that room stops working partway through a day and then writes that state
back to disk.

The alternative was to rename the level and throw every existing kitchen away:
a real cost, paid by real people, to avoid twenty lines. "Essential" is
deliberately a short list (`plates`, `sink`) rather than "everything the level
ships" — a save with no oven is a player who moved their oven, and one day it
will be a player who sold it.

The same rule now covers the **menu**. A save written before the [recipe
cards](the-menu.md) existed cannot say what a room had unlocked, because rooms
did not have menus — recipes arrived on a day number. Those kitchens were played
with salad, fries and pizza, and their layouts still have the fryer and the oven
standing in them, so that is what they are backfilled with. A schema bump is not
an excuse to take somebody's restaurant away.

A room is written when what it would save **differs from what is on disk** —
compared with `saveSignature`, which covers the layout, the money, the day, the
plates, the stall and the menu.
Checking that rather than "did someone move an appliance" matters: with only the
layout watched, a room could reach day five with money banked and never be
written, because nobody had rearranged anything.

The write points are:

| When | Why |
| --- | --- |
| An appliance moves | The layout is the thing people care about losing |
| The phase flips | Day boundaries are when money and the day change |
| The last player leaves | Last chance before the room goes quiet |
| A room is evicted (10 min empty) | Final flush before it leaves memory |
| Reset | It is destructive and deliberate |

Buying and selling ride the first of those: a purchase changes the layout (a
slot empties) as well as the money, so it is already a write point. Both are
things people would be upset to lose.

A save the server **refuses** is not always a save it must preserve. "We cannot
parse this" is quarantined; "this belongs to a level that no longer exists" is
stale, and describes coordinates that have stopped meaning anything. Those used
to get the same answer, which meant a level id bump would have silently left
every existing room unable to save again for as long as it was played.

Deliberately *not* every serve: losing the day in progress to a crash is fine,
losing five days of takings is not.

A kitchen nobody has touched is byte-identical to a fresh one, so it is never
written at all — otherwise every room code anyone ever typed would leave a file
behind forever.

Writes are **atomic and serialised** per room: to a temporary file, then
renamed, one at a time. Two saves can be triggered in the same tick (a layout
change and the last player leaving), and interleaved writes can leave truncated
JSON — which `loadSave` swallows, so the symptom would be a kitchen silently
reverting to the default layout. That is the worst possible way to lose
someone's build.

Failures — a full disk, a bad path — are swallowed and the game runs unsaved
rather than taking the kitchen down with it.

---

Next:

- [content.md](content.md) — what exists today
- [lessons.md](lessons.md) — what we have decided not to do again

[Back to the README](../README.md).
