<!-- What is next, and what has deliberately been left out. -->

# Roadmap

Near term:

- **The sink.** Closes the plate economy the dining room opened. Dirty plates,
  bussing and the tip already exist; today the plate stack washes up for free,
  which is a hand-wave with an obvious shape to replace — a `sink` appliance
  with a hold-to-scrub transform from `plate|dirty` to `plate`, and a plate
  count that can actually run out.
- **Door queue and rushes.** Customers who find the room full wait at the door
  and give up; the next step is showing that queue properly and weighting
  arrivals into visible **groups** so a rush is four people on the path rather
  than a spawn rate.
- **Parties** — one table, several dishes, wanted together. The coordination
  flagship ("table 2 wants a pizza *and* two fries"), and the reason tables are
  drawn with four chairs already.
- **Customer variety** — patience and appetite as data, like biomes are.
- **More biomes** — beach, night market, ski lodge. Mostly a data exercise now.
- **Verify the gamepad mapping** on real hardware, add per-player join/leave UI
  and rumble on burn/serve.
- **Multiplayer polish:** there is still no spectator mode and no proper
  "kitchen full" screen — just an error line and a closed socket. A player who
  stays away past the grace period also loses their name colour on return.
- **Binary frames.** JSON is 723 bytes a frame and entirely fine at eight
  players; if a room ever gets busy, the encoder is one file and the format is
  already split static/dynamic.

- **Shop phase** — spend money on new appliances between days (appliance prices
  already exist in `data/appliances.ts`).
- **More content** — soups (pots + liquids), drinks, sides.
- **Juice** — pickup/serve/burn sounds, steam and sizzle particles, screen shake
  on burn.
- **Chef–customer soft collision** — a gentle "excuse me" nudge, if the dining
  room ever feels too empty with everyone walking through each other.
- **Rendered icons** — render each ingredient once to a texture with an
  offscreen camera, then reuse it on crates. Consistent 3D icons with no
  illustration work.
- **Throwing** — an extra button to toss items across the kitchen.

Bigger:

- **Delta frames and interest management.** Only send what changed, and only to
  players who can see it. Neither is needed at one kitchen per room.
- **Kitchen validation in build mode, part two.** The dining room half is done
  (stranded tables are flagged, and never seated at); the kitchen half — can a
  chef still reach the pass, the crates, the oven — uses the same flood fill and
  is not written yet.
- **Procedural kitchens** and a run-based meta layer à la PlateUp.

## The build phase

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
destroying also keeps it reversible — there is no way to buy an appliance back
yet.

`canPlace()` lives in `sim/systems/interaction.ts` and is used by both the rule
and the ghost, so the preview and the placement can never disagree.

## Saving

`src/save.ts` defines the format; **where** a save is kept is deliberately not
decided there. The server writes one JSON file per room (`server/store.ts`), and
the browser keeps nothing about the kitchen at all.

That split arrived with multiplayer, and it is the right one. A layout stored
per-browser would mean four players each holding a different opinion about where
the oven is. What genuinely belongs to a person rather than to a kitchen — your
name, how many of you share this screen, your appearance later — stays in the
browser, in `src/identity.ts`.

Only what a *player* changed is stored: appliance layout, money, day. Items
mid-flight, orders and timers are deliberately discarded: a save that restores a
half-chopped tomato and a ticking order is a save that can restore a broken
game, and none of it is worth resuming.

It lives outside `sim/` on purpose. The simulation must not know storage exists.

Not a database, and it should not become one: a save is under 2 KB, is written a
few times a day, and being able to read or delete one with `cat` and `rm` is
worth more than any query ability we would ever use.

Two guards stop a stale save corrupting a session:

- `schema` — bumped when the snapshot shape changes.
- `level` — an FNV-1a hash of the level ASCII itself. Edit the layout and old
  saves are dropped rather than restoring appliances into a kitchen that has
  moved around them. Size alone is not enough: two different layouts can share
  dimensions.

A room is written when what it would save **differs from what is on disk** —
compared with `saveSignature`, which covers the layout, the money and the day.
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
