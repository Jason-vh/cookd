import * as THREE from "three";
import { isSingleMesh } from "./nodes";

/**
 * Turning a solid object into a translucent preview, and back.
 *
 * Materials are shared between appliances of the same kind (they're cached by
 * colour and surface in `primitives.ts`), so making one see-through by editing
 * its material would make every counter in the kitchen see-through. Instead
 * each ghosted object gets its own clones, built once on first use and kept for
 * reuse — a player picking things up repeatedly should not allocate repeatedly.
 *
 * The clones used to live in `object.userData.ghostCache`, read back with a
 * cast. That made them invisible to teardown as well as to the compiler: the
 * clones were dropped along with the object and never disposed. A `WeakMap`
 * keyed by the object is the same lookup, typed, and it lets go on its own when
 * the object does.
 */

type GhostCache = {
  originals: THREE.Material[];
  ghosts: THREE.Material[];
  meshes: THREE.Mesh[];
};

const caches = new WeakMap<THREE.Object3D, GhostCache>();

const OPACITY = 0.42;

function buildCache(object: THREE.Object3D): GhostCache {
  const cache: GhostCache = { originals: [], ghosts: [], meshes: [] };
  object.traverse((child) => {
    if (!isSingleMesh(child)) return;
    const original = child.material;
    const ghost = original.clone();
    ghost.transparent = true;
    ghost.opacity = OPACITY;
    ghost.depthWrite = false;
    // Emissive parts (an oven's glass, a fryer's oil) look lit rather than
    // ghostly unless they're damped down too.
    if (ghost instanceof THREE.MeshStandardMaterial) ghost.emissiveIntensity *= 0.25;
    cache.meshes.push(child);
    cache.originals.push(original);
    cache.ghosts.push(ghost);
  });
  return cache;
}

export function setGhost(object: THREE.Object3D, on: boolean): void {
  let cache = caches.get(object);
  if (!cache) {
    cache = buildCache(object);
    caches.set(object, cache);
  }
  for (let i = 0; i < cache.meshes.length; i++) {
    cache.meshes[i]!.material = on ? cache.ghosts[i]! : cache.originals[i]!;
  }
}

/** Fade the whole ghost together, for the ease in and out. */
export function setGhostOpacity(object: THREE.Object3D, alpha: number): void {
  const cache = caches.get(object);
  if (!cache) return;
  for (const material of cache.ghosts) material.opacity = OPACITY * alpha;
}

/**
 * Release an object's ghost clones.
 *
 * Called by `disposeSubtree` rather than by callers: the clones are not
 * reachable from the scene graph once the material is switched back, so nothing
 * walking the tree would find them.
 */
export function disposeGhost(object: THREE.Object3D): void {
  const cache = caches.get(object);
  if (!cache) return;
  for (const material of cache.ghosts) material.dispose();
  caches.delete(object);
}
