import * as THREE from "three";
import { isSingleMesh } from "./nodes";

/**
 * Two effects, one material slot.
 *
 * Ghosting and glowing both work by swapping an object's materials for tinted
 * clones, because the real ones are shared by colour and surface across the
 * whole kitchen (`primitives.ts`) and editing one counter's material would
 * change every counter in the room.
 *
 * They used to keep a cache each, and each recorded "the original" as whatever
 * was on the mesh the first time *it* ran. Hover an appliance and pick it up in
 * the same breath and the ghost recorded the **glow's** clones as the
 * originals, so putting it down restored a lit appliance — one that stayed lit,
 * because the glow's own cache thought it was already off and its per-frame
 * clear did nothing. The player got an appliance that would not un-hover until
 * they walked back and hovered it again.
 *
 * So the material slot has one owner. It remembers the material a mesh arrived
 * with, keeps a clone per layer, and paints the topmost active layer — which
 * makes the two effects composable rather than mutually destructive, and means
 * the order they are called in no longer matters.
 */

export type MaterialLayer = "glow" | "ghost";

/** Later wins: a carried appliance is a preview first and a target second. */
const ORDER: MaterialLayer[] = ["glow", "ghost"];

type Entry = {
  mesh: THREE.Mesh;
  /** The material this mesh was built with — never one of ours. */
  original: THREE.Material;
  /** A clone per layer, or null where a layer declined this mesh. */
  clones: Map<MaterialLayer, THREE.Material | null>;
};

type State = {
  entries: Entry[];
  active: Set<MaterialLayer>;
};

const states = new WeakMap<THREE.Object3D, State>();

/**
 * Turn a layer on and hand back its materials, so the caller can animate them.
 *
 * `clone` is asked once per mesh and may return null to leave that mesh alone —
 * a dial's shader material has no emissive to push, a textured sign face would
 * lose its paint.
 */
export function setLayer(
  object: THREE.Object3D,
  layer: MaterialLayer,
  clone: (original: THREE.Material) => THREE.Material | null,
): THREE.Material[] {
  let state = states.get(object);
  if (!state) {
    state = { entries: [], active: new Set() };
    states.set(object, state);
  }

  // Only on the way on, which is a pickup or the start of a hover — not the
  // frames in between, where a traverse per appliance per frame would be a real
  // cost for a tree that almost never changes.
  const turningOn = !state.active.has(layer);
  if (turningOn) refresh(state, object);

  const materials: THREE.Material[] = [];
  for (const entry of state.entries) {
    if (!entry.clones.has(layer)) entry.clones.set(layer, clone(entry.original));
    const material = entry.clones.get(layer);
    if (material) materials.push(material);
  }

  if (turningOn) {
    state.active.add(layer);
    apply(state);
  }
  return materials;
}

/** Take a layer off, dropping back to whatever is still on underneath. */
export function clearLayer(object: THREE.Object3D, layer: MaterialLayer): void {
  const state = states.get(object);
  // The common case by far — every appliance nobody is looking at, every frame
  // — so it touches no material and builds no cache.
  if (!state?.active.has(layer)) return;
  state.active.delete(layer);
  apply(state);
}

/** A layer's materials without turning it on, for per-frame tweaks. */
export function layerMaterials(object: THREE.Object3D, layer: MaterialLayer): THREE.Material[] {
  const state = states.get(object);
  if (!state) return [];
  const materials: THREE.Material[] = [];
  for (const entry of state.entries) {
    const material = entry.clones.get(layer);
    if (material) materials.push(material);
  }
  return materials;
}

/**
 * Release an object's clones.
 *
 * Called by `disposeSubtree`, not by callers: a layer that is off is not
 * reachable from the scene graph, so nothing walking the tree would find it.
 */
export function disposeLayers(object: THREE.Object3D): void {
  const state = states.get(object);
  if (!state) return;
  for (const entry of state.entries) {
    for (const clone of entry.clones.values()) clone?.dispose();
  }
  states.delete(object);
}

/**
 * Catch up with the meshes actually hanging off the object.
 *
 * Parts come and go — a board is fitted to a counter and taken off again — and
 * a cache built once would tint the appliance and not the board. Meshes that
 * were already known keep the original they were first seen with, because
 * reading their material back now could read one of ours.
 */
function refresh(state: State, object: THREE.Object3D): void {
  const known = new Map(state.entries.map((entry) => [entry.mesh, entry]));
  const entries: Entry[] = [];
  object.traverse((child) => {
    if (!isSingleMesh(child)) return;
    const entry = known.get(child);
    known.delete(child);
    entries.push(entry ?? { mesh: child, original: child.material, clones: new Map() });
  });
  for (const gone of known.values()) {
    for (const clone of gone.clones.values()) clone?.dispose();
  }
  state.entries = entries;
}

/** Paint every mesh with the topmost active layer that wanted it. */
function apply(state: State): void {
  for (const entry of state.entries) {
    let material = entry.original;
    for (const layer of ORDER) {
      if (!state.active.has(layer)) continue;
      material = entry.clones.get(layer) ?? material;
    }
    entry.mesh.material = material;
  }
}
