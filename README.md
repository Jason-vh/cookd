# cookd

A browser-based, controller-first co-op cooking game. Chefs run around a
tile-aligned kitchen turning raw ingredients into plated dishes, carrying them
out to seated customers before they walk out, and rearranging the restaurant
between days.

Inspirations: **Overcooked** (moment-to-moment chaos, hold-to-chop, plate-and-serve
loop) and **PlateUp!** (kitchen as a thing you design and optimise across days).

Status: **playable, and multiplayer.** Multiple chefs, three recipes, burning, a
dining room with customers who walk in, sit, order, eat and leave, tips left on
tables, a day loop, a build phase where appliances can be moved — and a server
so the chefs can be in different countries.

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

Open the client, pick a name and a kitchen code, and share the URL — the code
lives in the hash (`/#KITCHEN`), so the link *is* the invite. **Play offline**
skips the server entirely.

For local development you only need `bun run dev` if you're playing offline; run
the server too if you want online play.

`bun run check` runs the typechecker, the linter, the formatter and the tests.
It also runs on its own: [lefthook](lefthook.yml) gates commits on the fast
three and pushes on all four, and CI runs the same command again. `bun install`
installs the hooks.

### Controls

| Action | Gamepad | Player 1 keyboard | Player 2 keyboard |
| --- | --- | --- | --- |
| Move | Left stick / D-pad | `W A S D` | Arrow keys |
| Grab / place / deliver / bus | `A` (south) | `Space` or `E` | `,` |
| Use (hold to prep) | `X` (west) or `B` | `F` or `Left Shift` | `.` |
| Open the next day | `Y` (north) | `Enter` | `Enter` |
| Pause menu | `Start` | `Esc` | `Esc` |
| Close the menu | `B` (east) or `Start` | `Esc` or `Backspace` | — |
| Add a local player | press any button | `P` | — |
| Remove a local player | — | `Shift`+`P` | — |

**Press any button to join.** The first pad picks up player 1; any further pad
creates a new chef when *it* is used (up to 4). A pad that is merely plugged in
does not take a seat — [there is a reason for that](docs/lessons.md).

### How to play

The white square in front of your chef is what you'll interact with.

1. Take an ingredient from a crate (`Grab`).
2. Put it on **any counter** (`Grab`), then **hold** `Use` until the dial fills.
   A chopping board does the same job 1.75x faster. Some things are worth
   chopping **twice** — a tomato chopped once goes in a salad, chopped again it
   becomes pizza sauce. Keep holding and it keeps going, so let go when the dial
   flashes.
3. Pick it back up and combine it with something else by placing it on top.
4. Cook where needed (fryer/oven run on their own — and **will burn**). A
   working fryer bubbles and an oven's window glows, so you can read the state
   of the kitchen from across it.
5. Plate it: carry a plate onto the food, or the food onto a plate — either way
   round works, and you can **assemble on the plate**: drop chopped tomato onto
   a plate of chopped lettuce and you get a salad. Carrying food to the plate
   stack plates it in one move.
6. **Take it to the table that ordered it.** Customers walk in through the park
   gate, sit down, and a bubble appears over their table showing the dish they
   want and a ring counting down their patience. Placing the plate on that
   table feeds them. The two counters in the dividing wall are the **pass** —
   one player can plate and slide, another can run.
7. When they finish eating they leave behind a **dirty plate and a tip**. Pick
   the plate up and the tip is yours; carry it to the plate stack to wash it.
   A table with a plate still on it cannot be sat at, so clearing up *is* the
   capacity.
8. When the day timer hits zero — or you pick **Close up early** from the pause
   menu — you enter the **build phase**: face any appliance and `Grab` to pick
   it up. A **ghost** of it appears on the tile you're facing, showing exactly
   where it will land; `Grab` again to put it there. Drop it onto another
   appliance and the two **swap**. Tables are appliances too, so where the
   dining room goes is your decision. `Start` opens the next day (customers
   arrive faster each day).

Grabbed the wrong thing? Put it back where you got it: a **source takes back
exactly what it hands out**, so an untouched tomato returns to its crate and a
clean plate returns to the stack. Once you've changed it — chopped, cooked or
loaded — the crate won't have it, and ruined food goes in the bin.

**Your kitchen is saved.** Rearrange it in the build phase and it will be there
after a refresh — on the server, per room. *Reset kitchen* in the build-phase
pause menu restores the original layout, **for everyone in the room**; the log
says who did it.

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
| [Art direction](docs/art-direction.md) | The look, the biomes, and the rendering gotchas behind both. |
| [Performance](docs/performance.md) | The frame budget and the wire budget, and where each one goes. |
| [Testing](docs/testing.md) | What is covered, and what is only ever checked by hand. |
| [Roadmap](docs/roadmap.md) | What is next, and what has deliberately been left out. |
| [Deploying](docs/deploying.md) | Running it anywhere. The `cookd.vhtm.eu` runbook is in [`deploy/README.md`](deploy/README.md). |

Everything in `docs/` explains *why*, not just what. If you are about to change
something and the reasoning looks arbitrary, it is usually written down.
