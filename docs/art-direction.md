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
2. **Image-based lighting.** A sky dome, a ground disc and a sun through a
   `PMREMGenerator` give soft directional variation and believable roughness
   response with zero assets, plus a warm key light, a cool fill, and a
   hemisphere wrap. The `enamel` surface finish (low roughness, almost no
   metalness) turns that into the broad soft highlight of a fired enamel mug.
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
- **One material, not one colour per object.** The palette had nine browns,
  four of them within a few percent of each other, because every new object had
  brought its own. Side by side in the gallery the kitchen looked like five
  pieces of second-hand furniture rather than one room. There is now one timber
  in four lights — `wood`, `woodTop`, `woodDark`, `woodShadow` — plus butcher
  block, which is paler than all of them because it has to read *against* a
  worktop. A builder picks a **part**, not a brown; anything in between is
  `shade()` of one of them. The crate is the same timber as the counters, and if
  that were a problem it would mean colour was covering for a silhouette nobody
  had drawn.
- **The top face is what identifies an appliance.** At this camera angle you see
  a lot of it: the oven is a cream enamel range with a charcoal hotplate, the
  fryer terracotta with a golden basin. Body colour alone is not enough.
- **Matte surfaces get a roughness map.** Flat colour with a *perfectly* even
  sheen is what reads as plastic: timber, plaster, cloth and stone all vary in
  how they scatter light across a few centimetres. One shared 128px sheet of
  soft noise (`primitives.ts`) is applied as a `roughnessMap` to those four
  surfaces and to nothing else — fired enamel, glazed ceramic and polished steel
  are supposed to be even, and roughing them up makes them look dusty. It costs
  one texture upload and no draw calls, because every material shares it.
- **Vertex colours where a shape is broad and flat.** A vertical tone baked into
  the vertices (`tonedMesh`) costs nothing per frame, needs no texture and no
  shader, and is the difference between a green ball and a tree canopy. Used on
  foliage, rocks and wall panels. It is not an AO substitute — GTAO does
  contact, this does the broad fall from a bright sky to a dark floor.
- **One dial for mood.** `GradeShader` (`render/grade.ts`) applies saturation,
  warmth and black-lift as a post pass, configured per biome. Tuning the whole
  look is three numbers rather than fifty material colours.
- **Ingredients are modelled, not symbolised.** See below.
- **Silhouette over labels.** Each appliance carries a small identifying detail
  (a knife on the board, an oil basin on the fryer, a glass door on the oven, a
  a lid on the bin), and crates are slatted boxes heaped with 3D samples of the
  ingredient they hold — the gaps between the boards, and stock standing proud
  of the rim, are what say "take from here" rather than "put down here".
  Text labels are **contextual** — only the appliance a chef is facing is named.
  A world full of floating text destroys the diorama illusion.
- **Nothing is square to anything else.** The food was built with `wobble()`
  from the start and the furniture was not, so the ingredients looked handmade
  and the kitchen looked like CAD. Every appliance is now a little out of true —
  crate slats a degree off each other, chairs pushed back and turned, a chopping
  block put down at whatever angle the hand let go at — seeded from the
  appliance id, because a random wobble would twitch every time a mesh was
  rebuilt and would differ between two clients in the same kitchen.
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

Adding a location was claimed to be "a data entry plus, at most, one new prop
builder", and the **beach** was the invoice for that claim: one biome row, three
prop builders (palm, parasol, driftwood), and nothing else in the render layer.
The rest — sand instead of grass, a hard midday sun, clear air, an exposure
pulled *down* because sand throws light back up — is numbers.

Two things are worth stating from having done it:

- **A biome is a mood, and the grade and the ground carry it.** Everything else
  follows from a sentence. "Midday at the coast" decides the sun's height, the
  fog distance and the desaturated bleach in one go; arguing about individual
  colours before that sentence exists is how a location ends up looking like the
  last one with a filter on.
- **Reuse the prop kinds that mean the same thing.** A rock is a rock and a tuft
  of grass is dune grass. A new `PropKind` earns its row when no existing shape
  means what you need — which is why the beach added three and reused three.

The **roadside** was the second invoice, and a cheaper one: one biome row and
*no* new prop builders at all. "A layby off a hot road, late in the day" decides
a low amber sun, long shadows, dry scrub and a warmer grade, and every prop it
needs is a shape the park already had. It is also the first biome with no
`path` — nobody walks up to a [drive-through](drive-through.md), so a run of
paving slabs to the door would be a promise about arrival the lane keeps
instead. The lane itself is not scenery: it is drawn from the same two tiles the
simulation queues cars along, because paving a player can see and a line a car
actually drives must be one fact.

Because the biome also owns the lighting, a night or golden-hour variant is
purely a matter of numbers.

## The day

A biome's light is not an hour, it is a **day**: `daylight` is a list of
keyframes from opening to closing, and `render/daylight.ts` samples that curve
against the service clock (`dayProgress`, 0 at open and 1 at close). Three keys
is a whole day. The park opens cool and low, spends the middle of service in the
hazy warm afternoon that was the only light it used to have, and closes amber
and long-shadowed; the beach burns a bright morning up into a hard midday and
leaves it pink; the roadside starts hot and goes down behind the traffic.

What that bought, and what it cost:

- **The service clock was already the drama, and nothing was drawing it.** The
  HUD counts down and the customers arrive in waves, but the room looked the
  same at 0:10 as at 2:30. A shadow that has visibly swung across the patio
  since you opened is the same information without a number on it.
- **It replicates for free.** `dayTime` and `dayLength` are already on the wire,
  so every client works the same hour out of the same world. There is nothing to
  synchronise, which there would have been the moment the sun ran off a
  wall-clock timer instead.
- **The build phase is morning.** It is planning tomorrow, and tomorrow starts at
  opening, so `dayProgress` is 0 in every phase that is not service. Closing time
  therefore hands the sky a target it has to travel the whole day backwards to
  reach: eased over a couple of seconds that reads as a time-lapse rewinding, and
  snapped it reads as a bug.
- **Two things in that pipeline are expensive, and neither is the light.** Moving
  a sun is three numbers a frame. Redrawing the sky gradient is a canvas upload
  and rebuilding the environment map is a PMREM render, so both run on a bucketed
  clock — two dozen times a day rather than sixty times a second. Neither carries
  detail (the gradient is four pixels wide, the environment is blurred to a few
  mip levels), so a step in either is not a thing the eye can catch. The
  environment probe is built once and *mutated*, never rebuilt.
- **Colours cross in linear light.** `THREE.Color` mixing rather than arithmetic
  on hex — the difference between a sun going white-to-amber through warm gold
  and the same sun going through khaki.
- **Two things about authoring a day are silent when wrong**, so
  `data/validate.ts` checks them: the sun's azimuth must move *one way* across
  the keys (crossfading a value that doubles back swings every shadow in the
  kitchen the other way at noon), and no key may put the sun below ~12°, where it
  lays shadows out further than the shadow camera covers and they end in a
  straight line across the grass.
- **The grade moves with the hour too**, which is why `Post` gained a `setGrade`.
  It stays gentle at both ends: the evening should be *warmer*, not more graded,
  and the old warning about desaturating twice applies just as much to a dial
  that is now animated.
- **The gallery takes the light and not the weather.** It stands at midday with
  no sky and no fog, because a turntable is for comparing models to each other
  and that needs the light to hold still.

### A shadow is only as sharp as where the map is spent

The low sun arrived and every shadow edge went chunky — a visible staircase
rather than a line. Worth writing down, because none of it is antialiasing and
an afternoon could be lost looking there.

A shadow comes from a depth photograph the renderer takes from the sun, so the
edge can only be as precise as that photo's pixels. Two things were wasting them:

- **The box was drawn around the kitchen and the camera frames a third of it.**
  22 tiles wide against about eleven in shot, so three quarters of the map paid
  for lawn nobody was looking at. It now follows the camera's own ground
  footprint (`KitchenCamera.footprint`, four frustum corners projected onto the
  floor), which is the same argument as not hand-tuning the view size: the
  camera already knows what it is showing, so nothing else should guess.
- **A low sun smears each texel across the ground** by `1 / sin(elevation)` — a
  factor of 4.4 at 13°. The keys have a floor under them now, checked in
  `validate.ts`, and the map went to 4096² because shadows were measured at 4%
  of a frame and the pass draws a handful of merged meshes.

Together that is about four times the resolution on the part of the world you
can see. Two things it cost:

- **A moving shadow box crawls.** Slide it smoothly and the whole map resamples
  every frame, so every edge shimmers even when nothing is moving. The centre is
  snapped to whole shadow texels, and the box's *size* is quantised too — it
  decides how big a texel is, so a box that resized every frame would move the
  grid the centre is snapped to.
- **The box is tight across the sun's line and generous along it.** A caster
  whose shadow reaches the kitchen from off-screen is up-sun of it, which is
  *depth* to the shadow camera and costs nothing but precision. The two axes
  across it are the expensive ones, and only have to hold the bodies of casters
  standing just out of shot.

And what would not have helped: SMAA. It finds high-contrast edges and smooths
them, and a soft shadow edge is a gradient, so it walks straight past. The
staircase was in the data, not in how the data was drawn.

The park deliberately includes **picnic tables**: they were set dressing and the
seed of the dining room, back when there was not one. The beach has parasols for
the same reason — a place should look like it knows what it is for.

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

## The primitive kit

`render/primitives.ts` is the vocabulary every model is written in, and its
shape decides what the game can look like: box, rounded box, sphere, cylinder,
**rounded cylinder**, **capsule**, torus, cone, lathe, **swept tube**, and
extrusion — which may be pierced, because `build` can push holes onto the shape.

The three in bold were added after a survey of what the kitchen kept
approximating. A tap, an oven handle, a fryer basket and a bag strap were each
a cylinder plus a bent cylinder plus a sphere at the elbow: three parts and a
visible joint, where a sweep is one geometry and the curve *is* the drawing.
Every leg, foot and rim ended in a hard circular edge, because rule 1 —
everything is rounded — had no cylindrical form to apply itself to.

The lesson generalises: **a new primitive unlocks a class of objects, a new
model unlocks one.** When something is hard to build, check whether the kit is
missing a word before writing forty lines of parts.

## Proportion, measured

Most of what reads as "low fidelity" is proportion, not detail — and proportion
is checkable, so it was checked rather than argued about.

- **Worktop heights are right.** A chef is 1.27 units tall to the top of the
  toque and a worktop is 0.62, which is 49%. A 90cm counter against a 175cm
  person is 51%. Nothing to do, and worth writing down so nobody spends an
  afternoon rediscovering it.
- **A worktop overhangs its cabinet.** Ours was 10% *narrower* than the body,
  which is the proportion of a lid. It is now 2cm wider on each side, and that
  lip casts the line of shadow that separates top from body.
- **Things defined by a recess must have one.** A sink was a bowl sitting on a
  slab and a fryer was a pool of oil lying on a lid — the one shape neither
  object has. Both are now a pierced deck with a well hanging under it.
- **A handle is bolted to something.** The oven's floated 9cm clear of the top
  of its own door.

## Gotchas discovered the hard way

The ones that are about *rendering*. The rest — worlds sharing arrays,
latches, polling per tick — turned out not to be art direction at all, and
live in [lessons.md](lessons.md).

- **Full metalness renders black.** A `metalness: 1` surface *is* its
  reflections, and against a dark backdrop there is nothing to reflect. Steel
  details turned into black smears, so metalness was capped around 0.3. The
  corollary is the more useful half: *how metallic anything may be is set by how
  much there is to reflect*. Once the environment map became the biome's own
  sky, ground and sun — rather than three.js's white studio room, which was the
  same room on a park lawn, a midday beach and a roadside at dusk — the steel
  could go up to 0.45 and finally reads as steel that is standing *somewhere*.
  It now reflects *when*, too: the same probe is re-baked as the day runs, so a
  sink catches the evening it is standing in.
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
  bubble over a diner's head *is* the ticket, and the HUD's order list was
  deleted because of it. (It hung over the *table* until parties arrived, at
  which point one bubble over three people could no longer say who wanted what.) That worked partly because the camera framed the whole kitchen:
  a chef at the fryer in the south-east corner can no longer see any of the four
  tables. Accepted deliberately — walking to the pass to see what is waiting is
  the same trip you were going to make anyway, and it puts the dining room back
  in view on the way. If it ever stops feeling like a rhythm and starts feeling
  like a blind spot, the fix belongs to the bubble rather than the camera: clamp
  an off-screen one to the edge of the frame, pointing at its table, so it still
  answers "what" and "how far" from anywhere. Bringing the ticket list back would
  only re-split the attention it was deleted to unsplit.
- **The kitchen turns in quarter circles, and the art turns with it.** `[`/`]`
  (shoulder buttons on a pad) swing the view to the next corner; the yaw lives
  in `orientation.ts` so the *controls* turn with the picture, which is the only
  part of rotation a player can get wrong. Everything the art took for granted
  about one fixed angle had to follow it, and each of those is worth naming
  because each was invisible until the room moved: the walls nearest the camera
  are a low lip so they do not occlude the kitchen, so they are rebuilt when the
  camera crosses a corner (`View.buildWalls`); ovens wore glass doors on their
  two visible sides and now wear one on each; the recipe card is the one
  appliance with a readable *face*, so its easel turns to keep it towards you.
  The sun does **not** turn — it is the same time of day from every corner, and
  a shadow that swung round with the camera would say otherwise.

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
