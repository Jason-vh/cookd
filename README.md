# cookd

A browser-based, controller-first co-op cooking game. Chefs run around a
tile-aligned kitchen turning raw ingredients into plated dishes, carrying them
out to seated customers before they walk out, and rearranging the restaurant
between days. Three locations so far: a park kitchen, a beach shack with a
bigger deck and a smaller galley, and a highway stop with no dining room at all
— just a hatch, and a lane of cars queueing at it.

Inspirations: **Overcooked** (moment-to-moment chaos, hold-to-chop, plate-and-serve
loop) and **PlateUp!** (kitchen as a thing you design and optimise across days).

Three locations are hand-drawn; a fourth is generated. A seeded template builds
kitchens nobody drew, held to the same standard the hand-made ones are — see
[kitchens nobody drew](docs/content.md#kitchens-nobody-drew).

Status: **playable, and multiplayer.** Multiple chefs, a kitchen that starts with
one dish and buys the rest from recipe cards, burning, a dining room with
customers who walk in — alone or as a party — sit, order, eat and leave, tips
left on tables, a sink and
a kitchen with only four plates to its name, a day loop that begins in the
morning, a market stall on the patio to spend the takings at, a **drive-through**
where the dining room is a queue of cars and every cover comes back as washing-up
— and a server so the chefs can be in different countries.

---

## Quick start

```bash
bun install
bun run dev          # client on http://localhost:5273
bun run server       # game server on :5274 (dev proxies /ws to it)
bun test             # headless simulation + host tests
bun run build        # typecheck + production bundle
bun start            # build, then serve everything from one process
```

Open the client, pick a name, **your chef** — one of eight outfits and four
hats, remembered in this browser and carried into whichever kitchen you walk
into — a kitchen code, and **where the kitchen is** — the
city park, the beach shack, the highway stop, or **Surprise me** for a kitchen
nobody drew — and share the URL — the code lives in the hash (`/#KITCHEN`), so
the link *is* the invite. A surprise kitchen is built from that code, so the
link is the *restaurant* too: `/#PIZZA` is one particular building, the same one
for everybody who opens it. **Play offline** skips the server entirely.

For local development you only need `bun run dev` if you're playing offline; run
the server too if you want online play.

`http://localhost:5273/?gallery` opens the **model gallery** instead of a
kitchen: every appliance, ingredient, dish and rig the game can draw, on
turntables over a one-tile grid, lit and graded exactly as the game lights them.
Drag to pan, scroll to zoom, `r` to stop the spin. Dev builds only.

`http://localhost:5273/?kitchens` opens the **kitchen sheet**: fifty generated
floor plans at once, with the park and the beach drawn first in the same ink,
because "is this any good" is only a question against them. Under each plan is
what a cover costs to walk — and each plan is a room code, so clicking one goes
and cooks in it. `?kitchens=200` for more. Dev builds only.

The gallery answers *what does a fryer look like*. The sheet answers *is that a
restaurant or a shape*, which is a question no single kitchen can be asked.

`bun run check` runs the typechecker, the linter, the formatter and the tests.
It also runs on its own: [lefthook](lefthook.yml) gates commits on the fast
three and pushes on all four, and CI runs the same command again. `bun install`
installs the hooks.

### Controls

| Action | Gamepad | Player 1 keyboard | Player 2 keyboard |
| --- | --- | --- | --- |
| Move | Left stick / D-pad | `W A S D` | Arrow keys |
| Grab / place / deliver / bus / **open up** | `A` (south) | `Space` or `E` | `,` |
| Use (hold to prep) | `X` (west) or `B` | `F` or `Left Shift` | `.` |
| Confirm a menu, put down the report | `Y` (north) | `Enter` | `Enter` |
| Turn the kitchen | `L1` / `R1` | `[` / `]` | `[` / `]` |
| Pause menu (stops the kitchen) | `Start` | `Esc` | `Esc` |
| Close the menu | `B` (east) or `Start` | `Esc` or `Backspace` | — |
| Add a local player | press any button | `P` | — |
| Remove a local player | — | `Shift`+`P` | — |
| Sound on / off | — | `M` | — |

**Every one of those keys can be changed.** The pause menu's *Controls* page is
the game's own binding list rather than a copy of it: click a key, press the
one you want, and it is yours (`Esc` cancels, `Backspace` clears, and holding
`Shift` binds the pair — which is where `Shift`+`P` comes from). Bindings live
in this browser next to your name, so they are yours rather than the room's, and
a key can only ever do one job. The gamepad layout is fixed.

**The pause menu really pauses.** Opening it stops the whole kitchen — the day
clock, the fryer, the dining room — for everybody in the room, and the other
chefs are told whose menu it is. Reading the controls during a rush used to cost
you the rush.

**Nobody wears the same colour.** Your outfit is a request rather than an
instruction: four players on one sofa share a browser, so they share one saved
choice, and the room hands the later ones the colours still free. The hat is
always yours — see [whose chef is whose](docs/art-direction.md#whose-chef-is-whose).

**Press any button to join.** The first pad picks up player 1; any further pad
creates a new chef when *it* is used (up to 4). A pad that is merely plugged in
does not take a seat — [there is a reason for that](docs/lessons.md).

### How to play

The white square in front of your chef is what you'll interact with.

1. Take an ingredient from a crate (`Grab`).
2. Put it on **any counter** (`Grab`), then **hold** `Use` until the dial fills.
   A kitchen starts with three counters and no board — buy a **chopping board**
   at the stall and set it on one, and that counter does the same job 1.75x
   faster. Some things are worth chopping **twice** — a tomato chopped once goes
   in a salad, chopped again it becomes pizza sauce. Keep holding and it keeps
   going, so let go when the dial flashes.
3. Pick it back up and combine it with something else by placing it on top.
4. Cook where needed (fryer/oven run on their own — and **will burn**). A
   working fryer bubbles and an oven's window glows, so you can read the state
   of the kitchen from across it. A new kitchen has neither: heat arrives with
   the recipe that calls for it (step 11).
5. Plate it: carry a plate onto the food, or the food onto a plate — either way
   round works, and you can **assemble on the plate**: drop chopped tomato onto
   a plate of chopped lettuce and you get a salad. Carrying food to the plate
   stack plates it in one move.
6. **Take it to the table that ordered it.** Customers walk in through the park
   gate, sit down, and a bubble appears over their table showing the dish they
   want and a ring counting down their patience. Placing the plate on that
   table feeds them. The two counters standing where the dividing wall stops are
   the **pass** — one player can plate and slide, another can run.

   **Not everybody waits the same.** Somebody hurrying up the path in a dark
   coat has half the patience and pays for it; somebody ambling in will wait,
   and will then sit on your table twice as long. You can tell them apart from
   across the room, which is the point — [who walks
   in](docs/dining-room.md#who-walks-in).

   **They don't always come one at a time.** Later days send **parties** — two
   or three people walking up the path in single file, who sit at *one table*
   and want a dish each at the same time. A table seats as many as it has free
   sides, so a table in the open takes a party of four and the same table shoved
   against a wall takes one: where you put them decides who you can serve. A
   room with no table big enough grows a **line at the door**, served front
   first. The line is a warning
   you can act on: it is standing right next to the market stall that sells
   tables. Nobody waits forever, and the people who leave were the impatient
   ones. See [the line at the door](docs/dining-room.md#the-line-at-the-door).
7. When they finish eating they leave behind a **dirty plate and a tip** — a
   party leaves a whole pile of both, in one place. Pick the plates up and the
   tips are yours. A table with a plate still on it cannot be
   sat at, so clearing up *is* the capacity.
8. **Wash up.** Your kitchen owns four plates and no more, so the dirty ones have
   to come back. Plates **stack in your hands** — up to four — so one sweep
   clears a room: grab from each table in turn, drop the pile in the **sink**,
   and hold `Use` to scrub. One plate per fill of the dial; the pile stays
   dirty until the last one is done. Then carry them to the plate stack.
   Nothing at the sink burns, boils over or catches fire; it is the one calm
   place in the kitchen.

   Ruined a dish? The **bin scrapes it** — the food goes and you keep the plate,
   dirty. There is no way to throw a plate away, and the only way to get more is
   to buy another **plate stack** at the stall — they come with four on board.
9. When the day timer hits zero — or somebody turns the sign to **Closed** — the
   **rent** comes out of the till and you wake into the next day's **morning**
   with what is left. Face any appliance and `Grab` to pick it up. A **ghost** of it
   appears on the tile you're facing, showing exactly where it will land;
   `Grab` again to put it there. Drop it onto another appliance and the two
   **swap**. Tables are appliances too, so where the dining room goes is your
   decision.

   **Rent starts on day 3** at $20 and rises by $5 a day, and the morning card
   says what tonight will cost before you open. You are allowed to come up
   short — the till goes into the red and you have until the *next* closing time
   to clear it. Fail that and the kitchen is repossessed, which is the only way
   to lose. See [the rent](docs/the-shop.md#the-rent).

   **The sign stands against the wall beside the door**, and it is how a day begins
   and ends. Face it, `Grab`, and the restaurant is open — there is no button
   and no menu item for it. Turning it back over mid-service is **last orders**:
   nobody new comes in, and the day ends once the room has emptied, so closing
   early never takes a plate off somebody's table.
10. **Go shopping.** Out of the door, seven pallets of a delivery are dropped
    fresh every morning but the first — day one has an empty patio and a till
    with nothing in it. Face one and `Grab`: the price comes
    out of the till and the thing appears as a ghost in your hands, ready to
    place. Put it straight back on the same slot and you get every penny back;
    put *anything else* on an empty slot and the stall buys it off you for half.
    A **chopping board** goes on a counter rather than on the floor — face the
    counter you want it on and `Grab` — and `Grab` at a fitted counter takes the
    board back off. **Plate stacks** are on sale too, four plates included, and
    they are the only way a kitchen ever gets a fifth one.

    The stall is shuttered during service. Mornings are when a kitchen changes.

    **Buy tables carefully.** Customers arrive faster when there are free seats
    waiting, so a bigger dining room is a busier one. That is the difficulty
    dial, and it is in your hands.

    **Some of the floor is outside.** The paving in front of the restaurant is a
    **terrace**, and a table may stand on it — capacity with no room to extend
    and no wall to build, for the same $40 as one indoors. The catch is the
    **weather**: on a rainy day nobody sits outside, and those tables are
    furniture in a puddle. The morning card says what today will be before the
    stall opens, so how much of your dining room to buy outdoors is a bet you
    place with your eyes open — see [the weather](docs/weather.md).

    **Some things are better rather than more.** A *steel board* chops far
    faster than a wooden one, and a *bell oven* holds a finished pizza three
    times as long before it burns. They cost a week of takings and turn up as
    rarely as an oven does — something to plan around rather than buy. See
    [upgrades](docs/the-shop.md#upgrades).

11. **Choose what you cook.** You start with one dish — a garden salad — and
    that is the whole menu. From day two, one of the seven pallets holds a
    **recipe card** with a price on it. Buy it like anything else, carry it
    inside and put it down: the dish joins the menu.

    Everything the kitchen *lacks* for it comes free — buy the Fries card and a
    fryer and a potato crate are delivered onto the floor, around the tile you
    chose, before service. So your first fryer arrives with the reason you
    wanted one, and the shop is where you buy the second. Change your mind
    while it is still in your hands and the pallet takes it back at full price.

    Ignore it if you like; there is another one tomorrow, and the money is
    better spent on a table. By day 10 no two kitchens are the same restaurant.
    See [the menu](docs/the-menu.md).

Grabbed the wrong thing? Put it back where you got it: a **source takes back
exactly what it hands out**, so an untouched tomato returns to its crate and a
clean plate returns to the stack. Once you've changed it — chopped, cooked or
loaded — the crate won't have it, and ruined food goes in the bin.

**Your kitchen is saved.** Rearrange it in the build phase and it will be there
after a refresh — on the server, per room, along with the recipes you have
unlocked. *Reset kitchen* in the build-phase pause menu restores the original
layout, **for everyone in the room**; the log says who did it. It keeps the
menu: reset un-wrecks the layout, it does not delete the days you spent on
cards.

---

## Documentation

This file is the front door: what the game is, how to run it, how to play it.
Everything else lives in [`docs/`](docs/), because a single 1500-line document
is a place where "what does `applianceAt` mean" is not findable, and where a
file tree can point at modules that moved away months ago without anyone
noticing. [A test](docs/docs.test.ts) now catches that much.

| | |
| --- | --- |
| [Architecture](docs/architecture.md) | The shape of the codebase, and the one rule that keeps it that shape. **Start here.** |
| [Lessons](docs/lessons.md) | Bugs that cost real time, and the rules that came out of them. The conventions live here too. |
| [Multiplayer](docs/multiplayer.md) | Three clocks, prediction, and what happens when a connection drops. |
| [The content model](docs/content.md) | Items, transforms, combines, recipes and levels — everything that is data. Read this to add a dish. |
| [The dining room](docs/dining-room.md) | Customers: arriving, seating, patience, eating, tips. |
| [The weather](docs/weather.md) | What sort of day it is, and the terrace it opens and shuts. |
| [The drive-through](docs/drive-through.md) | The kitchen with no dining room: a hatch, a lane of cars, and why it is a level rather than a window. |
| [The shop](docs/the-shop.md) | The morning, the market stall, and the patio they stand on. |
| [The menu](docs/the-menu.md) | Recipe cards: how a kitchen chooses what it cooks, and the equipment that comes with it. |
| [Art direction](docs/art-direction.md) | The look, the biomes, and the rendering gotchas behind both. |
| [Sound](docs/sound.md) | What the kitchen sounds like, and why there are no audio files. |
| [Performance](docs/performance.md) | The frame budget and the wire budget, and where each one goes. |
| [Testing](docs/testing.md) | What is covered, and what is only ever checked by hand. |
| [Roadmap](docs/roadmap.md) | What is next, and what has deliberately been left out. |
| [Deploying](docs/deploying.md) | Running it anywhere. The `cookd.vhtm.eu` runbook is in [`deploy/README.md`](deploy/README.md). |

Everything in `docs/` explains *why*, not just what. If you are about to change
something and the reasoning looks arbitrary, it is usually written down.
