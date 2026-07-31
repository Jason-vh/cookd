import * as THREE from "three";
import { disposeGhost } from "./ghost";
import { disposeGlow } from "./glow";
import { isMesh } from "./nodes";
import { isCached } from "./primitives";

/**
 * Giving GPU memory back.
 *
 * There was none of this. `scene.remove(object)` unparents a thing; it does not
 * free the geometry or materials hanging off it, and WebGL will happily hold
 * both for the lifetime of the context. That went unnoticed because a `View`
 * lives as long as the tab does — but appliance objects do *not*: `Host.reset`
 * rebuilds the world, every appliance gets a new id, and `syncAppliances`
 * therefore drops and rebuilds every visual. Each reset leaked a `Dial`
 * geometry and shader per appliance, a highlight geometry and material per
 * table, the oven's two cloned glass materials, the fryer's cloned oil glow,
 * and every ghost material clone.
 *
 * Nobody resets a kitchen often enough for that to crash a tab, which is
 * exactly why it survived. It still made "let the player switch biome" and
 * "resize the kitchen" into things we could not do.
 *
 * The subtlety is that most geometry and materials here are **shared**, out of
 * the caches in `primitives.ts` — every counter in the kitchen draws the same
 * box. Disposing those on the first counter removed would break every other
 * one. So the cache owns what it hands out, and this only frees what was made
 * outside it.
 */
export function disposeSubtree(root: THREE.Object3D): void {
  // Ghost and glow clones are not in the scene graph once the material is
  // switched back, so a walk of the tree would never find them.
  disposeGhost(root);
  disposeGlow(root);
  root.traverse((node) => {
    if (isMesh(node)) {
      disposeGeometry(node.geometry);
      disposeMaterial(node.material);
    } else if (node instanceof THREE.Sprite) {
      disposeMaterial(node.material);
    }
  });
  root.removeFromParent();
}

function disposeGeometry(geometry: THREE.BufferGeometry | undefined): void {
  if (geometry && !isCached(geometry)) geometry.dispose();
}

function disposeMaterial(material: THREE.Material | THREE.Material[] | undefined): void {
  if (!material) return;
  if (Array.isArray(material)) {
    for (const entry of material) disposeMaterial(entry);
    return;
  }
  if (isCached(material)) return;
  // A material's textures are its own unless they came from the cache: a
  // CanvasTexture built for one name tag is used by nothing else.
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture && !isCached(value)) value.dispose();
  }
  material.dispose();
}
