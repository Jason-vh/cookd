<!-- Frame budget and wire budget, and where each one goes. -->

# Performance notes

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
  textured quad. Text textures are **measured and fitted to the string** rather
  than drawn into a shared box: a fixed box clips anything longer than it (which
  is how `walked out` first reached the screen as a smear) and wastes texture on
  anything shorter;
- the HUD updates by diffing text, never by re-rendering, and it no longer
  renders a per-order row at all — the order bubbles live in the 3D scene,
  where they cost one shader quad and one cached model each;
  rewriting `innerHTML` per frame.

The bottleneck was draw calls, not logic — and it was worse than it looked. The
park is *authored* as ~1,700 separate meshes (260 grass tufts of three blades
each, 70 flower clusters, trees, rocks, path slabs), every one a draw call, and
each was drawn three times a frame: once into the shadow map, once into the
ambient-occlusion G-buffer, then once for real. On a 120Hz panel all of that ran
twice as often as anything could show.

| | before | after |
| --- | --- | --- |
| Draw calls / frame | 3,818 | **335** |
| Triangles / frame | 633k | **184k** |
| CPU per render | 4.6ms | **0.7ms** |
| Main thread idle | 12% | **90%** |

What changed:

- **static scenery is baked into one mesh per material** when the kitchen is
  built (`render/merge.ts`). Authoring still builds loose parts — a tree is a trunk
  and four blobs — and only what reaches the scene changes. The trade is
  per-object frustum culling, which was worth nothing when the camera framed the
  whole diorama, and is worth little now it follows: the park is a handful of
  batched draws either way;
- **grass stopped being expensive.** `roundedBox` subdivides into a 7×7×7 grid
  to carry its corner radius: 588 triangles, which is right for an oven door and
  absurd for a blade of grass four pixels wide. 780 blades were 459k of the
  scene's 633k triangles;
- **the AO pass reuses the depth `RenderPass` already drew** instead of
  rendering the scene again into its own G-buffer. This is GPU-neutral on Apple
  silicon — making depth sampleable costs a store that tile memory would
  otherwise discard — but it halves the draw calls and the CPU that submits
  them;
- **drawing is capped**, at 60fps focused and 10fps unfocused.

That last number is why the shadow map was later *raised* to 4096² rather than
left alone: shadows cost 4% of a frame, the pass draws a handful of merged
meshes rather than 1,700 loose ones, and the resolution was the cheapest half of
fixing a staircased shadow edge — the other half being to stop spending the map
on ground the camera never shows. See
[art direction](art-direction.md#a-shadow-is-only-as-sharp-as-where-the-map-is-spent).

Measured and rejected, so nobody spends the afternoon again: smaller shadow maps
(shadows are 4% of a frame — switching them off entirely saves nothing worth
having), instancing the progress dials (already invisible when nothing is
cooking), merging each appliance's parts (−4%), and ambient occlusion at quarter
resolution (−16%, but it visibly widens every contact shadow, and contact
shadows are the whole point of having AO here).

If appliance counts grow a lot, instanced meshes per appliance kind is still the
next step — not a different language.

## Building a kitchen

The one place in the renderer that is allowed to block. `render/profile.ts`
times it, and the numbers print to the console in development.

Swapping kitchens — picking "surprise me", or being told the room you joined
stands somewhere else — used to be `view.dispose()` and `new View`, and the cost
of that was almost entirely invisible. `WebGLRenderer.dispose` empties three's
program cache and its record of what has been uploaded, but it neither deletes
the GL objects nor drops the context, and a second renderer built on the same
canvas is handed that same context straight back. So a kitchen swap recompiled
every shader in the game, re-uploaded every shared geometry and texture, threw
away the eight dish photographs, rebuilt the whole post chain, and leaked the
previous copy of all of it into a context that never went away — worse each
time.

So `View` now owns two lifetimes. The **renderer's**: the context, the post
chain, the shader cache, the photo studio, the PMREM probe, the camera rig and
the daylight. And the **kitchen's**: the baked shell and scenery, the camera's
bounds, the biome's sky, and every view keyed by a simulation id. `setLevel`
replaces the second and keeps the first.

The id-keyed views have to be replaced wholesale rather than left to prune
themselves. Each drops meshes for ids that have *gone*, which is the right
answer for a reset and the wrong one for a different building: ids are reused
between worlds, so appliance 3 would go on being drawn as the park's counter in
a beach kitchen whose appliance 3 is a fryer.

Shaders are compiled with `compileAsync` as soon as the scene is built, rather
than by the first frame that happens to need them. Linking is what costs, the
driver does it off-thread, and on a kitchen swap it is now free — the cache
those programs live in is no longer thrown away with the renderer.

What was left after that was the merge, and it was paying for the library's
calling convention rather than for the work. `mergeGeometries` needs every input
handed to it *already* sitting where it belongs, and geometry here is shared out
of the cache in `primitives.ts` — every blade of grass in the park is the same
`BoxGeometry` — so each of ~1,700 parts had to be deep-copied before it could be
moved into place, and the merge then copied all of it a second time into an
output buffer whose size was known before either copy started. `mergeStatic`
now sizes that buffer up front and transforms each part straight into it: one
copy, no garbage, same batches out.

| CPU, main thread | before | after |
| --- | --- | --- |
| Page load: scenery + shell | 80.7ms | **36.3ms** |
| Kitchen swap: scenery + shell | 32.5ms | **10.3ms** |
| Kitchen swap: shader compile | full recompile | **0.9ms** |

Measured under headless Chromium, which renders through SwiftShader — so those
numbers are CPU-representative and every GPU number in the same run is not.

## Post-processing

The chain is GTAO → bloom → grade+vignette+output → SMAA. Two things keep it
cheap. Ambient occlusion and bloom render at **half the framebuffer**, which is
invisible on effects that are already blurs and measures 59% off the AO pass;
and the grade, the vignette, tone mapping and the sRGB conversion share a single
shader, because every extra pass is a full-screen read, a write and a target
swap in exchange for a few instructions' work.

Drawing is capped at 60fps — see [the game loop](#the-game-loop). Add `?fx=off`
to the URL to bypass post-processing when profiling or on a weak GPU.

---

Next:

- [art-direction.md](art-direction.md) — what is being drawn
- [multiplayer.md](multiplayer.md) — what is being sent

[Back to the README](../README.md).
