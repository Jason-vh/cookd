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

- **static scenery is baked into one mesh per material** at startup
  (`render/merge.ts`). Authoring still builds loose parts — a tree is a trunk
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

Measured and rejected, so nobody spends the afternoon again: smaller shadow maps
(shadows are 4% of a frame — switching them off entirely saves nothing worth
having), instancing the progress dials (already invisible when nothing is
cooking), merging each appliance's parts (−4%), and ambient occlusion at quarter
resolution (−16%, but it visibly widens every contact shadow, and contact
shadows are the whole point of having AO here).

If appliance counts grow a lot, instanced meshes per appliance kind is still the
next step — not a different language.

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
