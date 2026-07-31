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
  and they escalate the loop rather than the demand.
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
- **A menu cap** — [recipe cards](the-menu.md) ship without one: nothing stops a
  room unlocking the whole library. Deferred on purpose until the library is
  bigger than about five dishes, because "which five do we keep" is only a
  decision when keeping one means dropping another. There is no hook for it.
- **More content** — soups (pots + liquids), drinks, sides.
- **Juice.** The [sounds are in](sound.md) — pickup, serve, tip, burn, door
  chime, the day opening and closing, synthesised rather than sampled. What is
  left is the *visual* half: steam and sizzle particles, and screen shake on a
  burn. Both want a particle system, which the renderer does not have and which
  is a bigger commitment than the shake is worth on its own.
- **Chef–customer soft collision** — a gentle "excuse me" nudge, if the dining
  room ever feels too empty with everyone walking through each other.
- **Rendered icons** — render each ingredient once to a texture with an
  offscreen camera, then reuse it on crates. Consistent 3D icons with no
  illustration work.
- **Throwing** — an extra button to toss items across the kitchen.

Bigger:

- **Delta frames and interest management.** Only send what changed, and only to
  players who can see it. Neither is needed at one kitchen per room.
- **Kitchen validation in build mode is done**, both halves. The *content* half
  (`kitchenWarnings`) says at day open when a dish on the room's own menu cannot
  be made here, derived from the recipes rather than from a list of appliances.
  The **reachability** half (`unreachableAppliances`) runs the dining room's
  flood fill from the chefs instead of the door, so an oven walled in behind a
  run of counters is named the same way a stranded table is — and pulses under
  the same red ring. Both stayed warnings: see the note on `ESSENTIAL` for why
  refusing the sale is the wrong instrument. What is *not* checked is anything
  about how far things are from each other: a kitchen may be terribly laid out,
  and that is the game.
- **Procedural kitchens** and a run-based meta layer à la PlateUp.

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
