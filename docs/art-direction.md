<!-- The look, and the reasoning behind it. -->

# Art direction: warm enamel miniature

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
  a lid on the bin), and crates show a 3D sample of their ingredient.
  Text labels are **contextual** — only the appliance a chef is facing is named.
  A world full of floating text destroys the diorama illusion.
- **Animation beats geometry.** The chef is simple shapes with clear
  articulation points: a walk cycle, a forward lean proportional to speed, and a
  squash-and-stretch pop whenever what they're holding changes. All of it is
  derived from simulation state in `view.ts` and stored nowhere.
- **Customers share the chef's rig**, minus the toque and the apron — which are
  exactly what say "staff". Same creature, same world, same walk cycle for free,
  and never a moment's doubt about who works here. Their colours are
  deliberately a softer, cooler family than the four chef colours, so the people
  you control stay the brightest people on screen.
- **Animate the part the camera can see.** Eating was first built properly: a
  fork raised to the mouth on a bite cycle, a hold at the top, chewing after.
  Almost none of it reached the screen. Somebody at a table faces the table,
  which from a fixed camera means facing away, so the whole performance played
  out behind their own back — the same trap the chop animation had already hit
  and solved by flaring the elbows clear of the silhouette. Here even that was
  not enough, and the answer was to stop miming: a head bob, the largest part of
  them and the only one reliably clear of the tabletop. Cheaper, and it reads
  from across the room.
- **A seated customer sits *higher* than a standing one.** Their hips land on
  the chair, not on the floor. Getting that backwards put every head level with
  the tabletop, where a customer read as a lump behind their own plate.

## Biomes

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

## Ingredient models

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

## Gotchas discovered the hard way

The ones that are about *rendering*. The rest — worlds sharing arrays,
latches, polling per tick — turned out not to be art direction at all, and
live in [lessons.md](lessons.md).

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
- **Don't hand-tune the camera's view size.** Everything in `render/camera.ts`
  is computed by projecting world points into camera space — the kitchen's
  bounding-box corners for the limits, the local chefs for the target — so
  framing stays correct for any kitchen shape, any window aspect ratio and any
  camera angle.
- **Framing the whole kitchen was correct and unreadable.** A 20x9 grid on a
  16:9 screen leaves a chef about eighty pixels tall and the food they carry far
  smaller, which is the thing you are actually tracking. The camera now sizes
  itself to a fixed world height (`FOLLOW_HALF_HEIGHT`, ~2x closer) and follows
  the players this browser drives.
- **Couch co-op shares one camera, so the camera has to give.** Two local chefs
  at opposite ends of the kitchen cannot both be centred, so the view zooms out
  until it holds them both — at worst reaching the old whole-kitchen framing,
  which makes the previous behaviour a special case rather than a mode. The pan
  is quick and the zoom deliberately slow: a view size that reacts as fast as
  players separate and rejoin is nauseating.
- **A following camera must not pan off the diorama.** The view rect is clamped
  inside the kitchen's bounds, so hugging a wall never fills half the screen
  with empty park.
- **Order bubbles can now be off-screen, and that is the trade we took.** The
  bubble over a table *is* the ticket, and the HUD's order list was deleted
  because of it. That worked partly because the camera framed the whole kitchen:
  a chef at the fryer in the south-east corner can no longer see any of the four
  tables. Accepted deliberately — walking to the pass to see what is waiting is
  the same trip you were going to make anyway, and it puts the dining room back
  in view on the way. If it ever stops feeling like a rhythm and starts feeling
  like a blind spot, the fix belongs to the bubble rather than the camera: clamp
  an off-screen one to the edge of the frame, pointing at its table, so it still
  answers "what" and "how far" from anywhere. Bringing the ticket list back would
  only re-split the attention it was deleted to unsplit.
- **The art still assumes one camera angle.** `KitchenCamera.setYaw` works and
  the framing maths is orientation-agnostic, but turning the camera would expose
  what the art takes for granted: the walls nearest the camera are built as a low
  lip so they don't occlude the kitchen (`View.buildKitchenShell`), ovens only
  wear glass doors on their two visible sides (`render/meshes.ts`), and the sun
  is fixed. Rotation is a lighting and modelling job, not a camera one.

## Feedback: showing what the sim knows

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

### The work dial

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
quad is turned to face the camera on every frame it is visible: one quaternion
copy per busy appliance, and the dial cannot go edge-on if the camera ever gains
a yaw control.

Unattended appliances advertise themselves instead: a frying basket bobs and its
oil boils and brightens, and an oven's window glows with an uneven ember heat.
They have to, because the progress bar only appears when a player is stood at
the appliance — and the whole point of a fryer is that you walked away from it.

The oven glow is kept deliberately dim. Pushed hard, the emissive washes the
dark glass out to flat orange paint; it should read as embers behind a window.

---

Next:

- [performance.md](performance.md) — what the look costs
- [lessons.md](lessons.md) — the non-rendering half of the gotchas

[Back to the README](../README.md).
