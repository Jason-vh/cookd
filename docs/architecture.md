<!-- The shape of the codebase, and the one rule that keeps it that shape. -->

# Architecture

The single most important rule in this codebase:

> **`src/sim` is pure. It must never import from `src/render`, `src/ui` or
> `src/input`, and must never touch the DOM.**

The simulation is advanced only by `step(world, inputs, dt)` — a function of the
world and one `PlayerInput` per player. Everything else (rendering, HUD,
gamepads) is an observer or a producer of those inputs.

What follows is a **map, not an inventory**: it is here so you can find the
thing you are looking for, and a module only earns a line if the line says
something the filename does not. A new helper does not need an entry. A path
that has stopped existing does — [a test checks that much](docs.test.ts),
because a tree that points somewhere empty is worse than one that is merely
incomplete.

```
src/
  sim/                    pure simulation — no DOM, no three.js
    types.ts              World, Player, Customer, Item, Appliance, PlayerInput
    world.ts              world construction from a level, tile/collision helpers, PRNG
    items.ts              item identity + canonical keys
    plates.ts             the crockery, and the promise that none of it is ever destroyed
    shop.ts               the stall's stock: rolled from the seed and the day, not from play
    cards.ts              the menu: what a room has unlocked, and the stand that grows it
    pathing.ts            BFS over walkable tiles: customer routes and reachability
    random.ts             the one PRNG — deterministic, shared with the scenery
    step.ts               fixed-timestep tick: runs the systems in order
    queries.ts            read-only questions about the world; safe for the renderer
    systems/
      movement.ts         circle-vs-tile collision, player separation
      interaction.ts      grab/place/combine/deliver, build-phase appliance moving
      appliances.ts       transforms (chop/fry/bake) and burning
      customers.ts        arrivals, seating, patience, eating, leaving, tips
      cards.ts            arming and taking a recipe card
  data/                   content — plain data, no logic
    ingredients.ts        what exists and what it is called
    appliances.ts         appliance definitions, prices, and the ApplianceKind union
    economy.ts            the ledger: what the stall stocks, and what it pays
    progression.ts        the cards: what a kitchen starts with, and how its menu grows
    recipes.ts            transforms, combines, recipes + derived lookup maps
    level.ts              ASCII kitchen layouts, their legend, and the registry
    biomes.ts             locations: sky, sunlight, ground and scenery recipes
    validate.ts           is the content coherent? checked at startup in dev
  game/                   who is running the game, and where
    host.ts               owns a world + its clock; runs in a tab or on a server
    game.ts               the interface the shell talks to (local or networked)
    local.ts              offline play: a Host in this tab
    net.ts                online play: wires the three below together
    connection.ts         the socket, and the business of keeping one
    reconciler.ts         our own chefs, run ahead and corrected when wrong
    protocol.ts           wire format, and the only encode/decode
    wire.ts               the edge of trust: unknown bytes -> validated messages
    snapshots.ts          the received timeline, and the clock that reads it
  input/
    index.ts            keyboard + Gamepad API -> Inputs (keyed by player id)
    latch.ts            a control that must be released before it counts again
  save.ts                 the saved-kitchen format, its parser and its migrations
  identity.ts             what this *browser* remembers: your name, your seat count
  render/                 mirrors the simulation; never writes to it
    view.ts               composition root: renderer, lighting, camera, kitchen shell
    appliance-views.ts    appliance meshes, dials, moving parts, placement ghosts
    people-views.ts       chef and customer rigs, walk cycle, working and eating poses
    table-views.ts        order bubbles, tips, unreachable-table warnings
    item-views.ts         food on counters and in hands, and plates emptying
    highlight-views.ts    the square in front of a chef, and the build-phase yes/no
    anim.ts               the animation maths, with no three.js in it
    scatter.ts            where the scenery goes, also with no three.js in it
    camera.ts             the 3/4 ortho framing, and how it follows the local chefs
    environment.ts        biome rendering: sky, sun, ground, patio, scattered props
    bubble.ts             the order floating over a table: dish model + patience ring
    dial.ts               the work gauge over a busy appliance
    popups.ts             floating "+$12" text
    appliance-meshes.ts   appliance bodies, tops and details
    shell-meshes.ts       the kitchen's own fabric: walls, doorway, floor
    person-mesh.ts        one rig, two costumes: chefs and customers
    overlay-meshes.ts     drawn over the kitchen: tile highlight, tip coins
    sprites.ts            name tags and appliance labels
    models.ts             sculpted models for every ingredient and dish
    primitives.ts         shared geometry/material factories and caches
    text.ts               text as a texture or a sprite, in one place
    palette.ts            every colour and surface finish in the game
    ghost.ts              solid <-> translucent preview, and back
    dispose.ts            giving GPU memory back, without freeing shared caches
    nodes.ts              typed narrowing for scene-graph nodes
    merge.ts              batching the static scenery into few draw calls
    layers.ts             which objects post-processing is allowed to see
    grade.ts              the colour grade, vignette and output shader
    post.ts               post-processing chain (AO, bloom, vignette, AA)
  ui/
    hud.ts                DOM HUD (stats, event log, build banner — no order list)
    menu.ts               the pause menu
    menu-controller.ts    the menu's dealings with the controls, and the latches
    join.ts               the join screen: name, kitchen code, offline
    style.css
  main.ts                 the shell: input in, pixels out; owns no rules
server/
  index.ts                Bun.serve: static files + game socket, rooms
  store.ts                one JSON file per room
```

## Why this shape

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

**Three.js with an orthographic camera, not 2D sprites.** A 3/4 ortho camera at
a fixed angle reads as isometric while remaining real 3D, so depth sorting is
free and primitive shapes give a coherent look with zero art. Swapping in real
models later touches only `render/meshes.ts`.

**Tile-aligned kitchen, free-moving players.** Appliances snap to a grid (which
makes the build phase and pathing trivial), while chefs are circles moving
continuously with per-axis collision resolution so they slide along counters.
The pathing half of that claim came due when customers arrived, and it held:
routing a customer to a chair is a flood fill over tiles, and because the grid
only changes in the build phase, a route cannot go stale while it is walked.

**DOM for chrome, the scene for anything about a place.** Timers, money and
the event log are things browsers are excellent at, and WebGL text is a trap.
But an order belongs to a *table*, and the moment we tried to say that in the
corner of the screen we were describing a location instead of pointing at one.
The rule that fell out: if a piece of UI is about somewhere in the room, it
lives in the room — which is why the order list is gone and the bubbles are
drawn in the 3D scene, out of one cached model and one shader quad each.

The rule costs something, and the cost was taken on purpose: a camera that does
not frame the whole kitchen can leave the only copy of an order off-screen. See
the gotcha under [*Feedback*](art-direction.md#feedback-showing-what-the-sim-knows)
before applying this to anything else.

---

Next:

- [lessons.md](lessons.md) — the rules that came out of getting this wrong
- [multiplayer.md](multiplayer.md) — how the pieces run in two places at once

[Back to the README](../README.md).
