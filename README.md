# cookd

A browser-based, controller-first co-op cooking game. Chefs run around a
tile-aligned kitchen turning raw ingredients into plated dishes, serving orders
before customers walk out, and rearranging the kitchen between days.

Inspirations: **Overcooked** (moment-to-moment chaos, hold-to-chop, plate-and-serve
loop) and **PlateUp!** (kitchen as a thing you design and optimise across days).

Status: **playable, and multiplayer.** Multiple chefs, three recipes, burning,
orders with patience timers, a day loop, a build phase where appliances can be
moved — and a server so the chefs can be in different countries.

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

### Controls

| Action | Gamepad | Player 1 keyboard | Player 2 keyboard |
| --- | --- | --- | --- |
| Move | Left stick / D-pad | `W A S D` | Arrow keys |
| Grab / place / serve | `A` (south) | `Space` or `E` | `,` |
| Use (hold to prep) | `X` (west) or `B` | `F` or `Left Shift` | `.` |
| Open the next day | `Y` (north) | `Enter` | `Enter` |
| Pause menu | `Start` | `Esc` | `Esc` |
| Close the menu | `B` (east) or `Start` | `Esc` or `Backspace` | — |
| Add a local player | press any button | `P` | — |
| Remove a local player | — | `Shift`+`P` | — |

**Press any button to join.** The first pad picks up player 1; any further pad
creates a new chef when *it* is used (up to 4).

A single controller once produced **four** chefs, and the reason is worth
keeping. Online, `addLocalPlayer` is a *request*: the server owns player ids, so
it returns nothing and the answer arrives a round trip later. Until then the pad
still had no seat, so the binding code asked again — on every frame, about
eleven times across a 180ms link, each one creating a cook. It was capped only
by the four-players-per-connection limit.

Offline it never happened, because a local `Host` hands back an id immediately.
That is the shape of this whole class of bug: **anything that becomes
asynchronous when it goes online needs a latch, or the frame loop will do it as
many times as latency allows.**

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
   stack plates it in one move. Then carry it to the green serving hatch.
6. When the day timer hits zero — or you pick **Close up early** from the pause
   menu — you enter the **build phase**: face any appliance and `Grab` to pick
   it up. A **ghost** of it appears on the tile you're facing, showing exactly
   where it will land; `Grab` again to put it there. Drop it onto another
   appliance and the two **swap**. `Start` opens the next day (orders arrive
   faster each day).

Grabbed the wrong thing? Put it back where you got it: a **source takes back
exactly what it hands out**, so an untouched tomato returns to its crate and a
clean plate returns to the stack. Once you've changed it — chopped, cooked or
loaded — the crate won't have it, and ruined food goes in the bin.

**Your kitchen is saved.** Rearrange it in the build phase and it will be there
after a refresh — on the server, per room. *Reset kitchen* in the build-phase
pause menu restores the original layout, **for everyone in the room**; the log
says who did it.

---

## Architecture

The single most important rule in this codebase:

> **`src/sim` is pure. It must never import from `src/render`, `src/ui` or
> `src/input`, and must never touch the DOM.**

The simulation is advanced only by `step(world, inputs, dt)` — a function of the
world and one `PlayerInput` per player. Everything else (rendering, HUD,
gamepads) is an observer or a producer of those inputs.

```
src/
  sim/                 pure simulation — no DOM, no three.js
    types.ts           World, Player, Item, Appliance, Order, PlayerInput
    world.ts           world construction from a level, tile/collision helpers, PRNG
    items.ts           item identity + canonical keys
    step.ts            fixed-timestep tick: runs the systems in order
    systems/
      movement.ts      circle-vs-tile collision, player separation
      interaction.ts   grab/place/combine/serve, build-phase appliance moving
      appliances.ts    transforms (chop/fry/bake) and burning
      orders.ts        order spawning, patience, expiry
    sim.test.ts        headless tests that drive the game through PlayerInput
  data/                content — plain data, no logic
    ingredients.ts     ingredient + process definitions (colours, shapes)
    appliances.ts      appliance definitions (size, colour, behaviour flags)
    recipes.ts         transforms, combines, recipes + derived lookup maps
    level.ts           ASCII kitchen layouts and their legend
    biomes.ts          locations: sky, sunlight, ground and scenery recipes
  game/                who is running the game, and where
    host.ts            owns a world + its clock; runs in a tab or on a server
    game.ts            the interface the shell talks to (local or networked)
    local.ts           offline play: a Host in this tab
    net.ts             online play: sockets, interpolation, prediction
    protocol.ts        wire format, and the only encode/decode
    host.test.ts       multiplayer machinery, tested without a socket
  input/index.ts       keyboard + Gamepad API -> Inputs (keyed by player id)
  save.ts              the saved-kitchen format (shared by browser and server)
  identity.ts          what this *browser* remembers: your name, your seat count
  render/
    view.ts            three.js scene, camera, animation, reconciliation
    environment.ts     biome rendering: sky, sun, ground, patio, scattered props
    meshes.ts          appliances, walls, chefs, labels, bars, highlights
    models.ts          sculpted models for every ingredient and dish
    primitives.ts      shared geometry/material factories and caches
    palette.ts         every colour and surface finish in the game
    post.ts            post-processing chain (AO, bloom, vignette, AA)
  ui/
    hud.ts             DOM HUD (stats, order tickets, event log, build banner)
    style.css
  main.ts              the shell: input in, pixels out; owns no rules
server/
  index.ts             Bun.serve: static files + game socket, rooms
  store.ts             one JSON file per room
```

### Why this shape

**Local co-op first, online too.** Couch co-op is what makes this genre work,
and the browser Gamepad API gives it to us for free. The sim/render split above
is exactly what an authoritative server needs, and when the time came the server
really was `import { step } from "./sim/step"` — `sim/` did not change at all.
The things that made that possible:

- inputs are plain serialisable data, quantised to 1/1000 so identical stick
  positions produce identical floats on every machine;
- randomness comes from a seeded PRNG stored **in the world** (`mulberry32`),
  never `Math.random()`;
- the sim advances in exact `1/60s` ticks, decoupled from frame rate;
- no wall-clock time, no DOM, no `performance.now()` inside `sim/`.

**Three.js with an orthographic camera, not 2D sprites.** A fixed 3/4 ortho
camera reads as isometric while remaining real 3D, so depth sorting is free and
primitive shapes give a coherent look with zero art. Swapping in real models
later touches only `render/meshes.ts`.

**Tile-aligned kitchen, free-moving players.** Appliances snap to a grid (which
makes the build phase and pathing trivial), while chefs are circles moving
continuously with per-axis collision resolution so they slide along counters.

**DOM for UI.** Order tickets, timers and text are things browsers are already
excellent at. WebGL text is a trap.

## Multiplayer

One server, many kitchens. A **room code** picks the kitchen; the code lives in
the URL hash, so sharing the link is the entire invite flow. A room is created
the moment someone uses its code and is kept warm for ten minutes after the last
person leaves, so refreshing your browser doesn't wipe the kitchen.

Any number of players can share one browser — gamepads and the two keyboard
schemes work exactly as they do offline. You join with one chef; more appear by
pressing `P` or **pressing a button on another controller**, which is how couch
co-op actually starts.

A controller that is merely *plugged in* does not join. It used to, and the
first person to open the game with three controllers connected arrived to four
cooks standing in the kitchen — three of them nobody's, and no way to remove
them short of everyone leaving. `Shift`+`P` drops the last local player, because
adding one needed an undo. The join screen deliberately does **not** ask how many of you there are:
it made you answer a question about a game you had not seen yet, and the answer
was already changeable at any moment.

A connection owns its players and may only move those; a buggy client cannot
drive someone else's cook around.

### One `Host`, two places to run it

`game/host.ts` owns a world, its clock and its players, and does not care where
it is running. Offline it lives in the tab; online it lives on the server. There
is deliberately **one implementation of turning the handle**, because two would
drift and the difference would only ever show up as "it works on my machine, in
single player".

`Game` (`game/game.ts`) is what the shell talks to. Both implementations hand
back a real `World` and an `alpha`, which is why the renderer never learned that
multiplayer exists — online the world is assembled from snapshots, offline it is
the live simulation, and `View` cannot tell.

### State, not lockstep

The server is authoritative and sends **state**. The obvious alternative — send
only inputs and let everyone simulate — is tempting because `sim/` is pure, but
*pure* is not the same as *bit-identical across machines*. We have already been
bitten once by floating point in `movement.ts` (`2.32 - 0.32 = 1.9999…`).
Lockstep would promote that class of bug from "annoying" to "two players see
different kitchens and neither is wrong".

Measured, state sync costs **~14 KB/s per player**, which buys a whole category
of impossible bug:

| | bytes |
| --- | --- |
| Whole world, naively | 5264 |
| Split static/dynamic | 1561 |
| Idle appliances omitted | **723** |

Two things get it there. The **layout** (which appliances exist and where) is
~70% of the bytes and changes a handful of times a day, so it rides its own
message and is sent only when it changes. And a frame carries only appliances
that are *doing something* — a kitchen is mostly idle counters, and repeating
"still empty, still zero" twenty times a second for each of them was two thirds
of the frame. Anything missing from the list is idle by definition.

The simulation runs at 60Hz and broadcasts at 20Hz.

### Three clocks

Most of the difficulty in `game/net.ts` is keeping these apart:

- the **server's** clock — authoritative, arriving ~20 times a second, late and
  jittery;
- the **playout** clock — deliberately held ~110ms behind the newest frame so
  there is always a pair of frames to interpolate between. This is the jitter
  budget: a frame late by less than this is invisible;
- the **prediction** clock — our own chefs, running *now*.

Everything is sampled onto tick boundaries before it reaches the renderer, so
`View` still gets a plain `World` and one `alpha`.

Remote chefs are sampled at the current tick *and the one before it*, rather
than simply interpolated. The renderer derives the walk cycle from how far a
chef moved in one tick, so handing it two positions 50ms apart would have every
remote chef permanently sprinting.

### Prediction, because of the distance

Between Europe and South Africa the round trip is ~180ms. Without prediction,
every step you take would arrive a fifth of a second after you asked for it, and
running a kitchen would feel like steering a boat.

So the client keeps a second world, runs its own chefs in it immediately, and
replays anything the server hasn't acknowledged yet on top of each frame that
arrives. Inputs carry a sequence number; the server acknowledges the last one it
applied; everything after that is re-run locally.

For this to work the server must apply *exactly* the sequence the client
predicted against, so inputs are queued and consumed **one per tick** rather
than "latest wins" — otherwise the two would drift under jitter and never
reconcile cleanly. A starved queue repeats the last input instead of stopping
dead: a dropped packet should look like a moment of lag, not a stumble.

Measured against a 180ms latency proxy:

| | |
| --- | --- |
| Local chef responds after | **16ms** (one tick) |
| Position error while running | 0.5 tiles |
| Position error once stopped | **0.000 tiles** |

That half-tile is not error — it is the client correctly being *ahead* of an
observation that is 180ms old. What matters is that it converges to exactly zero
the moment you stop, with no rubber-banding.

#### When the server refuses your input

A stalled link can deliver half a second of input at once. The server drops the
oldest rather than working through the backlog, and **that is correct**: it has
already lived through that half second and cannot spend it again. Replaying it
would put the player half a second in the past and keep them there.

But the client has already predicted those inputs, and the acknowledgement jumps
straight past the dropped ones — so it can never replay the difference. Measured,
that was a **2.24 tile instant teleport** across the kitchen, mid-stride.

So a correction is carried as an **offset that decays to nothing over ~200ms**
rather than applied at once. You keep control the whole time; the chef slides
back into place. Past 2.5 tiles something has gone properly wrong (a reset, a
very long stall) and being in the right place beats being smooth about it, so it
snaps. Measured after the fix: a peak correction of 0.35 tiles, fully absorbed,
settling to exactly zero.

This is the one part of the netcode that only misbehaves on a *bad* link, which
is exactly why it survived the first round of testing — a healthy connection
never drops an input, so the convergence test showed a clean 0.000 and said
nothing about it.

**Only movement and facing are predicted.** Possession is not: an item that
appears in your hands and then snaps back is far worse than 60ms of nothing.
Pressing grab is confirmed by the server, and so is the chopping animation, so
the whole interaction lands together rather than in pieces.

### Dropping out, and coming back

A dropped connection **holds your seat for 25 seconds**. Your chef stays where
it was, faded out and still wearing your name, holding whatever you were
holding. Come back inside that window — same browser, same kitchen — and you
resume the same cook mid-pizza.

The alternative, deleting the player immediately, means a two-second wifi blink
costs you a half-built dish. On a link between Europe and South Africa that is
not an edge case, it is Tuesday.

An away chef is fed **empty input**, not its last input. Without that, the
starved-queue behaviour that normally makes a dropped packet look like lag would
helpfully repeat "walking left" and march an unattended cook into a wall for
twenty-five seconds. Anything queued before they vanished is dropped too, so a
grab held at the moment of disconnection does not fire on their return.

Seats are keyed by a token in `localStorage` — it identifies a *seat*, not a
person, and the worst it can do is take back your own cook. If the same token
reconnects while the old socket is still open (a reconnect that beat the close),
the new connection takes the seats over rather than doubling up.

Once the grace period passes, the seat is cleared exactly as a deliberate
departure would be:

A player who leaves has their food destroyed and their appliance put back —
at the tile it was lifted from, or the nearest free one. Food has no floor to
land on, and a chef vanishing while leaving a pizza hovering in mid-air is a
worse bug than losing an ingredient; an oven lost to someone's wifi would be
unrecoverable.

Player ids are **stable and never reused**. They were array indices until
multiplayer, which is fine when players only ever get added — the first time
someone in the middle disconnects, everyone after them shifts and inherits the
wrong chef.

Use `playerById(world, id)`, never `world.players[id]`. The two look
interchangeable and silently stop being so the moment anyone leaves; two call
sites in the renderer were missed in the conversion and only broke *after a
disconnect*, which no test covered because tests join players in order from
zero, where id and index happen to agree.

### Resetting

Reset wipes the kitchen **for everyone in the room**, so it asks twice. The
menu is driven by whichever button also means "yes" everywhere else in the game,
and one mis-timed press should not cost four people their layout. Arming clears
if you move, close the menu, or leave it for four seconds. The log names who did
it.

### Pausing

`Esc` / `Start` opens the pause menu. **The simulation has no concept of being
paused** — it never did, which turned out to be the right call: online the world
cannot stop because one player opened a menu.

So the menu does not pause anything. It **zeroes your inputs**: your chef stands
still, everyone can see it, and the kitchen carries on burning without you. That
is the honest behaviour online, so it is the behaviour offline too rather than
pause meaning two different things in two places. The menu's actions
(`resume`, `startDay`, `restartDay`) go back through ordinary simulation entry
points.

### The game loop

`src/main.ts` runs a classic accumulator loop:

```
accumulator += frameTime
while (accumulator >= 1/60) { step(world, inputs); accumulator -= 1/60 }
render(world, accumulator / (1/60))   // alpha interpolates prev -> current
```

Players store `prevPos` each tick so rendering interpolates between ticks: the
sim stays at a deterministic 60Hz while the display can be 120Hz.

---

## Art direction: warm enamel miniature

The target is a **photographed miniature in enamelware**: cream and eggshell
bodies, muted sage and dusty teal accents, warm woods, charcoal rims, and a soft
glossy sheen rather than a matte or metallic one. Everything is desaturated and
pushed warm; nothing is allowed to shout. It suits an orthographic camera, is
forgiving of primitive geometry, and needs no art assets at all. Every colour
and surface finish lives in `render/palette.ts`; forms live in `render/meshes.ts`.

The five things doing the work:

1. **Everything is rounded.** `RoundedBoxGeometry` with a 3–7cm bevel on every
   box. Hard 90° edges are the single strongest "programmer art" signal; a
   bevel catches the key light and makes a cube look sculpted. Geometry is
   built at final size and cached — never unit-scaled, which would smear the
   bevel.
2. **Image-based lighting.** `RoomEnvironment` through a `PMREMGenerator` gives
   soft directional variation and believable roughness response with zero
   assets, plus a warm key light, a cool fill, and a hemisphere wrap. The
   `enamel` surface finish (low roughness, almost no metalness) turns that into
   the broad soft highlight of a fired enamel mug.
3. **Ambient occlusion.** `GTAOPass` puts contact shadows in every crevice,
   which is what makes objects feel like they are *resting on* the counter
   rather than floating near it.
4. **Vignette.** Darkened corners focus attention on the kitchen and sell the
   "photographed object" framing. Deliberately **no depth of field / tilt-shift**
   — it is the classic miniature trick, but the entire kitchen is playable space
   and blurring any of it costs readability for no gameplay benefit.
5. **Diorama framing.** The kitchen sits on a raised paved patio in the middle
   of its biome, so it still reads as a crafted object but belongs to a place.
   Kitchen paving is kept cool and desaturated so it separates cleanly from
   whatever surrounds it.

Supporting decisions:

- **Colour is a gameplay tool** — but *relatively*. Nothing is saturated any
  more, so readability comes from the kitchen being muted enough that food,
  which is only mildly saturated itself, is still comfortably the warmest and
  brightest thing on screen.
- **The top face is what identifies an appliance.** At this camera angle you see
  a lot of it: the oven is a cream enamel range with a charcoal hotplate, the
  fryer terracotta with a golden basin. Body colour alone is not enough.
- **One dial for mood.** `GradeShader` (`render/grade.ts`) applies saturation,
  warmth and black-lift as a post pass, configured per biome. Tuning the whole
  look is three numbers rather than fifty material colours.
- **Ingredients are modelled, not symbolised.** See below.
- **Silhouette over labels.** Each appliance carries a small identifying detail
  (a knife on the board, an oil basin on the fryer, a glass door on the oven, a
  cloche on the serving hatch), and crates show a 3D sample of their ingredient.
  Text labels are **contextual** — only the appliance a chef is facing is named.
  A world full of floating text destroys the diorama illusion.
- **Animation beats geometry.** The chef is simple shapes with clear
  articulation points: a walk cycle, a forward lean proportional to speed, and a
  squash-and-stretch pop whenever what they're holding changes. All of it is
  derived from simulation state in `view.ts` and stored nowhere.

### Biomes

Where a kitchen *is* — sky, sunlight, ground and the props scattered around it
— is data. `data/biomes.ts` defines a biome; `render/environment.ts` builds it.
A level names one:

```ts
export const LEVEL: LevelDef = { name: "Park Kitchen", biome: "park", ... };
```

A biome specifies the sky gradient, fog, sun colour/angle/intensity, fill and
ambient light, tone-mapping exposure, a colour grade, ground and patio colours,
an optional paving path, prop palettes, and a scatter recipe:

```ts
scatter: [
  { kind: "tree", count: 14, minDistance: 3.5, maxDistance: 22, scale: [0.85, 1.45] },
  { kind: "tuft", count: 260, minDistance: 1.4, maxDistance: 26, scale: [0.6, 1.5] },
],
```

Props are placed by **rejection sampling in a ring** around the kitchen, never
on the patio, using a **seeded PRNG** — the park looks identical on every load,
and will look identical on every client once there is online multiplayer.

Props also carry a ground `FOOTPRINT` and are placed largest-first, so nothing
grows through anything else. The footprints are deliberately smaller than the
visual silhouette: tree canopies and bush tops *should* overlap, it is only the
bases that must not collide.

Adding a location (beach, night market, ski lodge, rooftop) is a data entry plus,
at most, one new prop builder in `PROPS`. Because the biome also owns the
lighting, a night or golden-hour variant is purely a matter of numbers.

The park deliberately includes **picnic tables**: they are set dressing today
and the seed of the dining room described in the roadmap.

### Ingredient models

`render/models.ts` holds a sculpted model for every ingredient and dish: a
tomato with a calyx and stem, a head of crumpled lettuce, a bevelled cheese
wedge with holes, a lumpy potato with eyes, pizza built up crust-by-topping,
fries in a paper carton, a lathed plate.

They are **procedural rather than imported GLTF** on purpose:

- they stay automatically consistent with the procedural kitchen in scale,
  palette and shading;
- there is no asset pipeline, no download step and no licence to track;
- a "model" is a dozen readable lines that any engineer can tweak;
- state changes are free — kneaded dough flattens, a baked pizza browns its
  crust, anything burnt collapses to the same charred lump.

Models are registered in a lookup keyed by item state, checked most-specific
first:

```ts
const MODELS: Record<string, Builder> = {
  "tomato|chopped": choppedTomato,   // exact item state
  tomato,                            // falls back to the ingredient base
};
```

So giving any single item state a bespoke look — including swapping in a real
GLTF model later — means adding one entry and touching nothing else. Crates
reuse the same models as their contents marker, so the kitchen stays consistent
for free.

Builder conventions: `y` is the surface the food rests on, keep the footprint
inside a ~0.34 radius so items fit on a plate, take every colour from `PALETTE`,
and use `wobble()` rather than `Math.random()` so a given item always looks the
same.

### Gotchas discovered the hard way

- **A request that takes a round trip needs a latch.** Asking the server for a
  new player returned nothing until the answer came back, so the frame loop
  asked again, and again — one controller filled a four-player kitchen in under
  a second. The offline path returned an id immediately and never showed it.
  Test the *online* shape of anything that changes shape online.
- **A connected gamepad is not a player either.** Binding a seat on connection
  rather than on a button press would hand a chef to a controller nobody had
  touched. Anything that creates should need an actual act — and have an undo
  (`Shift`+`P`).
- **One key, one latch.** Opening and closing the menu used separate edge
  detectors — one against the menu's own nav state, one against gameplay
  input — so *holding* `Esc` closed the menu and immediately reopened it. Any
  control that toggles across a state boundary needs a single release-latch
  spanning both sides, not an edge detector on each.
- **Poll input once per _tick_, never once per frame.** A frame can legitimately
  run zero ticks (120Hz display, 60Hz simulation), and `InputManager` clears its
  "pressed since last poll" buffer every time it is asked — so polling per frame
  silently eats quick taps. `Game.update` takes a `poll` *function* for exactly
  this reason. This was originally a comment in `main.ts`, and when that file was
  rewritten for multiplayer the comment went with it and the bug came back
  immediately: the first `Grab` of every offline playthrough did nothing.
- **Never `world.players[id]`.** Use `playerById()`. Ids stopped being array
  positions when players could leave, and the two only disagree *after someone
  disconnects* — which no test covered, because tests join players in order from
  zero where id and index happen to match.
- **"Fall back to offline" must mean "we never got in".** The flag marking when
  we started connecting was never cleared on success, so the first disconnect
  after six seconds of play quietly moved the player into a *private offline
  kitchen* while their friends carried on without them. It looked like working
  reconnect logic in testing, because the test happened to drop the socket
  inside the six-second window.
- **Optional parameters in the middle of a signature are a trap.**
  `advance(elapsed, 8)` meant "at most 8 ticks" until polling was added, at which
  point 8 silently became the input function and the server threw every tick.
  `advance` takes an options object now.

These cost real debugging time and will bite again:

- **Full metalness renders black.** A `metalness: 1` surface *is* its
  reflections, and against a dark backdrop there is nothing to reflect. Steel
  details turned into black smears. Stylised scenes want semi-metals
  (`metalness` around 0.15–0.35) — see `SURFACE` in `palette.ts`.
- **Scene fog applies to sprites.** Labels and progress bars faded into the
  background on the far side of the kitchen. Every UI-ish material sets
  `fog: false`.
- **3D UI poisons screen-space effects.** A large dark rectangle appeared
  behind every appliance label. Screen-space effects rebuild the scene into a
  depth/normal buffer using an override material, and UI objects lie to that
  buffer: they ignore depth testing, sit in front of the world, and sprites are
  billboarded *inside their vertex shader*, so an override material draws them
  un-billboarded as phantom geometry. `GTAOPass` skips Points and Lines for
  exactly this reason — but not Sprites. Fix: 3D UI lives on `LAYER.UI`
  (`render/layers.ts`) and the AO pass runs through a camera copy that cannot
  see it.
- **Don't render the UI as a second pass after the composer.** The obvious
  alternative — `clearDepth()` then a second `renderer.render()` with the UI
  camera — made the *world* disappear: three rebuilds its render state (lights,
  shadows, clear behaviour) on every `render()` call, and a pass whose camera
  can see no lights leaves that state behind. Excluding a layer from one
  post-processing pass keeps the entire frame in a single render call.
- **Mipmaps destroy small text.** Minified levels average white text into its
  dark pill and the label becomes an unreadable smudge. Label textures set
  `generateMipmaps = false` with a `LinearFilter`.
- **Detail parts must be children of the part they decorate.** The cheese
  holes were positioned in world space against a rotated wedge and floated off
  into the air. Parent them to the mesh and place them in its local space.
- **Density beats shape for chopped food.** A handful of ribbons reads as
  litter; the same ribbons doubled in count read as a portion.
- **Don't desaturate twice.** Muting the palette *and* pulling saturation down
  in the grade produced a washed-out scene with no value contrast — walls,
  floor and counters all collapsed into one cream mass. Mute the palette, keep
  the grade gentle, and protect value separation (a mid-tone floor under light
  enamel appliances).
- **Menu input must be device-agnostic.** Menu navigation first read the same
  per-player inputs as gameplay, so in a one-player game the arrow keys (which
  belong to player 2) did nothing. `InputManager.pollMenu()` reads every
  keyboard scheme and every pad at once, regardless of who is bound to what.
- **Don't hand-tune the camera's view size.** The frustum is fitted by
  projecting the kitchen's bounding-box corners into camera space
  (`View.frameCamera`), so framing stays correct for any kitchen shape and any
  window aspect ratio.

### Feedback: showing what the sim knows

The simulation emits two kinds of transient signal, and they are deliberately
different things:

- `world.events` — **words** for the HUD log ("Pizza served +$21").
- `world.effects` — **moments** for the render layer: a dish served, something
  binned.

Effects carry an id and expire on a timer rather than being cleared each tick,
because one render frame can span several ticks and must not miss one. The
render layer just remembers the highest id it has already shown. The sim never
knows what an effect looks like — only that it happened, where, and to whom.

That buys three things:

- **Floating `+$12`** above the chef who served. The money counter in the HUD is
  a running total nobody watches mid-service, and a tip for a fast serve is
  invisible there. On the chef, the reward is tied to the action *and* to the
  player who earned it — which matters in co-op.
- **The bin lid flips open** when something goes in.
- Anywhere else a one-shot cue is needed later (sizzles, chop bits, customer
  reactions) already has a home.

#### The work dial

The gauge over a busy appliance is a radial dial (`render/dial.ts`), not a fill
bar. The bar it replaced had three problems:

1. **It looked the same whether you were cooking or burning.** Only its colour
   changed, and colour alone is a weak signal in peripheral vision during
   service — exactly when it matters. The dial keeps the colours (mint for prep,
   gold for cooking, red for burning) but *pulses* when food is burning, so the
   thing that needs attention is the thing moving.
2. **It popped in and out.** Appearing and vanishing instantly reads as a
   glitch. The dial eases in fast and out slow: arriving should feel instant,
   leaving should not snatch the last frame of information away.
3. **It was wide.** A tile-wide bar overlapped its neighbours' bars and the
   appliance labels. A dial is compact and unambiguous about what it belongs to.

Finishing flashes the dial white and expands it, so a completed chop registers
even if you were watching another chef at the time.

It's drawn as a shader on a quad rather than as geometry, because the fill is a
single uniform — no geometry rebuild per frame, one draw call per appliance. The
camera never rotates, so the quad is oriented to it once at build time.

Unattended appliances advertise themselves instead: a frying basket bobs and its
oil boils and brightens, and an oven's window glows with an uneven ember heat.
They have to, because the progress bar only appears when a player is stood at
the appliance — and the whole point of a fryer is that you walked away from it.

The oven glow is kept deliberately dim. Pushed hard, the emissive washes the
dark glass out to flat orange paint; it should read as embers behind a window.

### Performance

The full chain (GTAO + bloom + vignette + SMAA) runs at a display-capped
**120fps at 1440×900**. Add `?fx=off` to the URL to bypass post-processing when
profiling or on a weak GPU.

---

## The content model

### Items

An item is **an ingredient base plus the ordered list of processes applied to
it**:

```ts
{ base: "tomato", processes: [] }                         // raw tomato
{ base: "tomato", processes: ["chopped"] }                // chopped tomato
{ base: "pizza",  processes: ["sauced", "topped", "baked"] }
```

Matching is **exact** — same base, same processes, in the same order. That's
deliberate: doing steps in the wrong order genuinely fails, which is where the
difficulty comes from. `specKey()` flattens an item to a string like
`pizza|sauced,topped` so every lookup is a single `Map.get`.

Plates are items too (`base: "plate"`) and hold their dish in `contents`.

### Transforms (station × item → item)

Transforms are keyed by **station** (`prep` / `fry` / `bake`), not by appliance
kind. Appliances declare which stations they offer and how fast they work, so
you can prep on any counter and a chopping board is simply better at it. This
keeps the convenience without making the dedicated appliance pointless — and
adding "a hob that can also bake, slowly" is one line of data.

`data/recipes.ts`:

```ts
{ station: "prep", mode: "hold", motion: "chop", duration: 2.0,
  input:  { base: "tomato", processes: [] },
  output: { base: "tomato", processes: ["chopped"] } }

{ station: "bake", mode: "auto", duration: 8.0, burnAfter: 8.0,
  input:  { base: "pizza", processes: ["sauced", "topped"] },
  output: { base: "pizza", processes: ["sauced", "topped", "baked"] } }
```

`data/appliances.ts`:

```ts
counter: { stations: ["prep"], speed: 1,    ... }
board:   { stations: ["prep"], speed: 1.75, ... }
oven:    { stations: ["bake"], speed: 1,    ... }
```

- `mode: "hold"` requires a player to stand there holding `Use` (chopping).
  Progress decays slowly if they walk away.
- `mode: "auto"` runs on its own once loaded (fryer, oven).
- Transforms **chain**: a tomato chops to `chopped` (salad) and chops again to
  `chopped, crushed` (pizza sauce). One ingredient reaching two dishes by depth
  rather than by branching keeps the crate count down and gives the prep station
  something to decide about.

**Holding `Use` runs straight through a finished step into the next one.** This
was briefly the other way round — a finished transform latched until the chef
let go, so you could not over-chop by accident. It was removed, and the reason
is worth keeping:

> The latch created a **dead state**. The chef stood there holding the button
> with the animation stopped and the dial gone, and nothing on screen explained
> why. That reads as a bug, not as a rule. "Hold to work" has to mean holding
> works, or the contract the whole prep station rests on stops being true.

The accident it prevented is handled with a number instead of a rule: the second
chop is the slowest prep step in the game (3s), and **that duration is the window
you have to let go** — 1.7s on a board, 3s on a counter. It was 1.8s at first,
and a scripted playthrough holding `Use` for a very natural 2.2s over-chopped
every time; doubling it made the mistake hard to make without removing the
ability to make it.

The mistake is cheap anyway: an over-chopped tomato is still a pizza ingredient,
and the bin is right there. Tuning a duration is balance. A latch would have cost
a legible interface.
- `motion` (`chop` / `knead` / `mix`) is a presentation hint. The simulation
  treats every hold-transform identically, but new content brings its own
  animation with it rather than needing a change in the render layer.

#### Working animations

While a hold-transform is actually progressing, the appliance carries
`motion`, and three things animate off **one shared phase per appliance**:
the chef's arms and body, the knife on the board, and the food itself
(squashing on the beat). Sharing a phase is what makes it read as a single
action rather than three loops that happen to overlap. The phase is offset by
appliance id so two chefs working side by side don't look like a chorus line.

**A chop is not a sine wave.** `Math.max(0, Math.sin(phase))` rises and falls at
the same speed, which reads as waving, not chopping. `chopLift()` lifts over
~55% of the cycle easing *out* into a hang at the top, strikes in ~17% easing
*in* so it accelerates, then rests on the board for the remainder — the pause at
the bottom is what makes the next strike read as a strike. At 3.8Hz that's
roughly 10 frames up, 4 down, 5 still. A separate `chopImpact()` spikes on
landing and drives the chef's recoil and the food's squash together.

The arms **flare wide** on the way up. Anatomically that lets go of the knife,
but a chef working a counter to the north faces away from a fixed camera, and
arms held together simply vanish behind their own torso — at the previous 43°
sweep only one hand ever cleared the silhouette. Swinging them out (and up to
100°) is what makes the action visible at all.

Kneading stays a sine: slow and heavy, pushing with the whole body.

The food's squash matters more than it sounds. With a fixed camera a chef on the
far side of a counter is half-hidden, so the *thing being worked* has to carry
the read — which is also why the knife swings rather than sitting there as
decoration.

A pose must reset every channel it touches in the baseline pose above it, or it
sticks — a chef who kneaded once leant forward forever.
- `burnAfter` is derived into a reverse index, so a finished item left on a hot
  appliance gains the `burnt` process — including if a player puts a cooked item
  back on it. Nothing accepts burnt food except the bin.

### Sources (crates, plate stack)

A source appliance dispenses an `ItemSpec` and **accepts back exactly that
spec** — compared by `specKey`, with the extra condition that a container must
be empty. One rule covers crates and the plate stack, and any source added
later inherits it for free.

The alternative — a crate that swallows anything — would quietly become a
second bin in the corner of the kitchen, and "put it back where you got it" is
a rule players already know from real kitchens.

### Combines (item + item → item)

Placing a carried item onto an occupied counter looks for an order-insensitive
combine rule:

```ts
{ a: flour(),        b: water()          -> dough() }
{ a: dough(kneaded), b: tomato(chopped)  -> pizza(sauced) }
{ a: pizza(sauced),  b: cheese(chopped)  -> pizza(sauced, topped) }
{ a: lettuce(chopped), b: tomato(chopped) -> salad() }
```

Plating is a special case of the same interaction: **any** food item placed on
a plate — or a plate placed onto any food item — goes into the plate's
`contents`. It is deliberately not restricted to finished dishes: "why won't
this go on the plate?" is a worse experience than plating the wrong thing,
which is obvious, harmless and undone with the bin.

**A plate is a workspace.** Food that combines with something already on the
plate becomes the combined dish in place, so a salad can be assembled directly
on the plate — the move players reach for first, and refusing it taught them
nothing. Food that combines with nothing simply sits alongside, which is
exactly what stops it being served: a dish is *one* item, so a plate holding
two things is refused at the hatch.

### Current recipes

| Dish | Steps | Reward |
| --- | --- | --- |
| Garden Salad | chop lettuce, chop tomato, combine, plate | $8 |
| Fries | chop potato, fry, plate | $6 |
| Pizza | flour + water, knead, chop tomato **twice** → sauce, chop cheese → top, bake, plate | $16 |

Serving pays the reward plus a tip proportional to the time left on the ticket.

### Levels

Kitchens are authored as ASCII so layouts stay readable and diffable
(`data/level.ts`):

```
#############
#tlcfwpP===X#
#...........#
#.=B=.......#
S...........O
S...........O
#.=B=.......#
#.......===F#
#############
```

`#` wall · `.` floor · `=` counter · `B` board · `F` fryer · `O` oven ·
`P` plate stack · `S` serving hatch · `X` bin · `t l c f w p` ingredient crates
(tomato, lettuce, cheese, flour, water, potato).

Dough is **made, not found**: flour + water. An ingredient that arrives ready to
use is a crate that exists only to be walked to, and the pizza's first step now
teaches the combine rule that the rest of it depends on.

---

## Performance notes

The simulation is a few dozen entities at 60Hz — microseconds of work. **WASM is
not needed and would be premature.** What actually keeps this fast:

- the world is **mutated in place**; immutable updates would allocate thousands
  of objects per second for zero benefit at this scale;
- recipe/transform/burn resolution is precomputed into `Map`s at module load, so
  the tick never scans arrays;
- the render layer **reconciles** against sim state: meshes are keyed by entity
  id and reused, and an item's mesh is only rebuilt when its canonical key
  changes (`tomato` → `tomato|chopped`);
- geometries, materials and label textures are shared/cached; the floor is one
  textured quad;
- the HUD updates by diffing text and reconciling order rows, never by
  rewriting `innerHTML` per frame.

The realistic bottleneck is draw calls, not logic. If appliance counts grow a
lot, the next step is instanced meshes per appliance kind — not a different
language.

---

## Testing & debugging

`src/sim/sim.test.ts` drives the game the way a player does — by feeding
`PlayerInput` into `step()` — which is only possible because the sim is pure.
The tests cover the full pizza pipeline end to end, hold-to-chop semantics,
burning, collision regressions, and the day/build loop.

`src/game/host.test.ts` covers the multiplayer machinery **without a socket in
sight**: stable ids across a departure, what happens to what a leaver was
holding, one-input-per-tick consumption and acks, reset, and a full
encode/decode round trip proving a client that has only ever seen frames ends up
with the same kitchen. `Host` is the same class the server runs, so anything
proved here is proved for hosted play.

They double as executable documentation.

```bash
bun test
```

In dev builds the live state is exposed on `window.cookd` for console poking:

```js
cookd.world.players[0].pos
cookd.world.money = 500        // offline only — online the server owns this
cookd.world.dayTime = 1        // fast-forward to the build phase
cookd.game.status              // "local" | "connecting" | "online" | "offline"
cookd.game.ping
```

Online, **writing to `cookd.world` does nothing lasting**: the next frame
overwrites it. That is the authority model working, but it does mean debugging
recipes is much easier offline (`?local`).

`?server=ws://host/ws` points the client at a different server — used below to
test against a latency proxy, and handy for running a local client against a
deployed kitchen.

### Testing multiplayer by hand

Two browser contexts against one room is enough to catch most things. For
latency, put a proxy in front:

```js
// delays every message in both directions
const LAG = 90;   // one way, so 180ms round trip
```

**Use a fresh room code per test run.** Rooms persist to disk, so a second run
of the same test starts from the kitchen the first one left behind — which shows
up as a test that passes once and then reports "nothing changed" forever.

**Two menu presses in the same frame count as one.** Menu navigation is
edge-triggered, so a script sending `ArrowDown` twice with no delay moves the
selection once. Humans cannot press twice in 8ms; Playwright can.

Anything that walks a chef to a fixed position by *timing* keypresses will fail
online — the harness has to wait on state instead, because a 180ms link makes
"press right for 500ms" land somewhere different every run. This is a good
property, not a nuisance: it is the same reason the tests drive `step()` rather
than the clock.

### Verified so far

Keyboard play has been driven end to end in a real browser: crate → chop →
combine → plate → serve pays out, food burns if left on the fryer, and
appliances can be picked up and re-placed in the build phase.

The server is written so that **one bad room cannot take the others with it** —
the per-room tick is wrapped, and a room that throws is evicted and logged
rather than aborting the sweep. This is not theoretical: a signature change
during development made `advance` throw every tick, and the isolation contained
it to one room while the rest of the server carried on. In Bun an uncaught throw
in a timer callback can end the process.

Multiplayer has been driven end to end too, against a **180ms latency proxy**:
two browsers in one room see each other move and collide; picking up, placing
and chopping all confirm across the link; a build-phase move propagates and
lands on disk; a reset reaches every client and names who did it; a room
survives a server restart; and an unreachable server falls back to offline play
after six seconds with the game still playable.

Also exercised: a dropped player reclaims the same chef, still carrying, inside
the grace period and is cleared away after it; reset asks twice and a single
press changes nothing; a full kitchen turns the ninth player away instead of admitting
them with no chef; a room nobody touched leaves nothing on disk; junk traffic
(input before hello, malformed JSON, an unauthenticated reset) is ignored rather
than crashing anything; and a dropped socket reconnects to exactly one client
and one chef, with the stale session's frames and input history discarded.

**Gamepad input has not been tested against physical hardware yet** — the
mapping assumes the standard layout (`A`/south = grab, `X`/west = use, `Start` =
next day).

---

## Deploying

One process serves everything:

```bash
bun install
bun run build          # produces dist/
PORT=8080 bun run serve
```

`server/index.ts` serves `dist/` and the game socket from the same origin, so
there is no CORS, no second host and no separate static bucket. Put it behind
TLS (Caddy, nginx, a tunnel — anything that upgrades websockets) and point a
domain at it.

- `PORT` — listen port (default 5273).
- `COOKD_SAVE_DIR` — where room saves are written (default `./saves`).
- `GET /health` — rooms, player counts and the day each is on.

Unknown paths fall back to `index.html`, so `/#KITCHEN` links work on a cold
load. A single instance is a single point of failure, which is fine at this size
as long as it restarts: saves are on disk and a room reloads itself when the
first player rejoins.

In Docker:

```bash
docker compose up -d --build
```

**Mount a volume at the save directory.** Every deploy rebuilds the container,
and without one each push silently resets everyone's kitchen — the single most
important line in `docker-compose.yml`.

The live deployment is `cookd.vhtm.eu`; its runbook, ports and first-time setup
are in [`deploy/README.md`](deploy/README.md).

**Anyone in a room can reset it.** That is deliberate — see the note above — but
it does mean a room code is the only thing standing between a stranger and your
kitchen. Codes are four characters from an unambiguous alphabet; treat a shared
link like a shared document.

## Roadmap

Near term:

- **Dining room.** The intended shape, so nothing gets built that blocks it:
  extend the level grid with a seating area on the far side of the serving
  hatch (one grid, one collision system, no new concepts). Add a `table`
  appliance that accepts a plate and holds it; customers become simple entities
  that walk the biome path, occupy a seat, spawn the order, and free the seat
  once served. Serving then means *carrying the plate to the right table*
  rather than posting it through a hatch, which turns delivery into real
  floor-planning pressure. The natural follow-on is dirty plates and a sink,
  which closes the loop and makes the build phase much more interesting.
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
- **More content** — soups (pots + liquids), a sink and dirty plates, serving
  windows with seated customers.
- **Juice** — pickup/serve/burn sounds, steam and sizzle particles, floating
  `+$8` text, screen shake on burn, a customer walk cycle.
- **Rendered icons** — render each ingredient once to a texture with an
  offscreen camera, then reuse it on crates and in HUD tickets. Consistent 3D
  icons with no illustration work.
- **Throwing** — an extra button to toss items across the kitchen.

Bigger:

- **Delta frames and interest management.** Only send what changed, and only to
  players who can see it. Neither is needed at one kitchen per room.
- **Kitchen validation in build mode** — prevent layouts that wall off the
  serving hatch (flood fill from spawns).
- **Procedural kitchens** and a run-based meta layer à la PlateUp.

### The build phase

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

### Saving

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

## Design guidelines we hold ourselves to

**Friction is only worth it when it creates a decision.**

Carrying an appliance during the build phase used to slow you to 60% speed. It
looked like a cost, but the build phase has no clock and nothing competing for
your attention — so the slowdown created no decision, only delay between the
player and the layout they had already pictured. It's gone.

The same test applies to anything that gets proposed as "weight" or "realism":
if the player has no alternative to weigh it against, it is not a trade-off,
it's a toll. Service-phase friction (a fryer that burns, a plate you must fetch)
passes the test — there is always something else you could be doing instead.

**Say yes and let the failure be visible.** Plating the wrong thing, combining
on a plate, putting a tomato back in its crate: all allowed. The player learns
from a result they can see and undo, not from an interaction that silently
refuses. Serving is where the game says no, and by then the mistake is obvious.

## Conventions for future contributors

- Content goes in `src/data` as plain data. Adding a recipe should never require
  touching engine code.
- Anything time-based inside `sim/` must use the passed `dt`, never wall clock.
- Anything random inside `sim/` must use `random(world)`, never `Math.random()`.
- New systems get their own file in `sim/systems/` and are called in an explicit
  order from `step.ts`.
- The render layer may read the world; it must never write to it.
