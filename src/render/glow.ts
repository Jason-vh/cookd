import * as THREE from "three";
import { isSingleMesh } from "./nodes";

/**
 * Lighting up the thing a chef is pointing at, and putting it back.
 *
 * What a chef would interact with used to be shown as a translucent square
 * floating above the appliance, which asks the player to do the join
 * themselves: the square is over the oven, so it must mean the oven. Lighting
 * the object *is* the statement, and it needs no interpreting at a glance in
 * the middle of a rush.
 *
 * The mechanism is `ghost.ts`'s, for the same reason and with the same
 * constraint: materials are shared by colour and surface across the whole
 * kitchen, so tinting one counter's material would tint every counter in the
 * room. Each object therefore gets its own clones, built once and kept — a chef
 * turning on the spot should not allocate on every frame.
 *
 * Emissive rather than a brighter base colour, because it has to survive the
 * shadow it might be standing in: an appliance in shade would barely change if
 * this only multiplied what the light was already doing to it.
 *
 * The two effects are mutually exclusive in practice and deliberately not
 * coordinated: a ghost is an appliance being *carried*, which is one that is not
 * on the grid, and only what is on the grid can be pointed at.
 */

type GlowCache = {
  meshes: THREE.Mesh[];
  originals: THREE.Material[];
  glows: THREE.MeshStandardMaterial[];
  on: boolean;
};

const caches = new WeakMap<THREE.Object3D, GlowCache>();

/** How hard the tint is pushed. Enough to be unmistakable, short of neon. */
const EMISSIVE = 0.42;

function buildCache(object: THREE.Object3D): GlowCache {
  const cache: GlowCache = { meshes: [], originals: [], glows: [], on: false };
  object.traverse((child) => {
    if (!isSingleMesh(child)) return;
    const original = child.material;
    // Only the standard materials, which is every part of an appliance. A dial's
    // shader material has no emissive to push and says its own thing anyway.
    if (!(original instanceof THREE.MeshStandardMaterial)) return;
    // Two kinds of part are left alone, because both are *already* being
    // animated through the very material this would be shadowing with a copy:
    // anything that lights itself (an oven's window, a fryer's oil, which would
    // freeze mid-flicker and come back in the wrong colour), and anything
    // wearing a texture (the sign's faces, repainted the instant the day opens
    // — which is a moment a chef is by definition standing at the sign for).
    //
    // Tested on the emissive *colour*: `emissiveIntensity` defaults to 1 on
    // every material in three.js, black emissive and all, so asking about the
    // intensity is asking a question every part in the kitchen answers yes to.
    if (original.emissive.getHex() !== 0 || original.map) return;
    const glow = original.clone();
    glow.emissiveIntensity = EMISSIVE;
    cache.meshes.push(child);
    cache.originals.push(original);
    cache.glows.push(glow);
  });
  return cache;
}

/** Light `object` in `color`, or put it back when `color` is null. */
export function setGlow(object: THREE.Object3D, color: number | null): void {
  if (color === null) {
    // The common case by far — every appliance nobody is looking at, every
    // frame — so it never builds a cache and never touches a material.
    const cache = caches.get(object);
    if (!cache?.on) return;
    for (let i = 0; i < cache.meshes.length; i++) {
      cache.meshes[i]!.material = cache.originals[i]!;
    }
    cache.on = false;
    return;
  }

  let cache = caches.get(object);
  if (!cache) {
    cache = buildCache(object);
    caches.set(object, cache);
  }
  // Set every frame: two chefs can point at one appliance, and the colour is
  // whose chef is pointing.
  for (const glow of cache.glows) glow.emissive.setHex(color);
  if (cache.on) return;
  for (let i = 0; i < cache.meshes.length; i++) cache.meshes[i]!.material = cache.glows[i]!;
  cache.on = true;
}

/**
 * Release an object's glow clones.
 *
 * Called by `disposeSubtree`, not by callers: like a ghost's, these are not
 * reachable from the scene graph whenever the effect is off, so nothing walking
 * the tree would find them.
 */
export function disposeGlow(object: THREE.Object3D): void {
  const cache = caches.get(object);
  if (!cache) return;
  for (const material of cache.glows) material.dispose();
  caches.delete(object);
}
