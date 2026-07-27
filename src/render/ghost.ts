import * as THREE from "three";

/**
 * Turning a solid appliance into a translucent placement preview, and back.
 *
 * Materials are shared between appliances of the same kind (they're cached by
 * colour and surface), so making one see-through by editing its material would
 * make every counter in the kitchen see-through. Instead each held object gets
 * its own clones, built once on first pickup and kept for reuse — a player
 * picking things up repeatedly should not allocate repeatedly.
 */

type GhostCache = {
  originals: THREE.Material[];
  ghosts: THREE.Material[];
  meshes: THREE.Mesh[];
};

const OPACITY = 0.42;

function buildCache(object: THREE.Object3D): GhostCache {
  const cache: GhostCache = { originals: [], ghosts: [], meshes: [] };
  object.traverse((child) => {
    const asMesh = child as THREE.Mesh;
    if (!asMesh.isMesh || Array.isArray(asMesh.material)) return;
    const original = asMesh.material as THREE.Material;
    const ghost = original.clone();
    ghost.transparent = true;
    ghost.opacity = OPACITY;
    ghost.depthWrite = false;
    // Emissive parts (an oven's glass, a fryer's oil) look lit rather than
    // ghostly unless they're damped down too.
    const standard = ghost as THREE.MeshStandardMaterial;
    if (standard.emissiveIntensity !== undefined) standard.emissiveIntensity *= 0.25;
    cache.meshes.push(asMesh);
    cache.originals.push(original);
    cache.ghosts.push(ghost);
  });
  return cache;
}

export function setGhost(object: THREE.Object3D, on: boolean): void {
  const cache: GhostCache = (object.userData.ghostCache ??= buildCache(object));
  for (let i = 0; i < cache.meshes.length; i++) {
    cache.meshes[i]!.material = on ? cache.ghosts[i]! : cache.originals[i]!;
  }
}

/** Fade the whole ghost together, for the ease in and out. */
export function setGhostOpacity(object: THREE.Object3D, alpha: number): void {
  const cache = object.userData.ghostCache as GhostCache | undefined;
  if (!cache) return;
  for (const material of cache.ghosts) material.opacity = OPACITY * alpha;
}
