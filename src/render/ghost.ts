import * as THREE from "three";
import { clearLayer, layerMaterials, setLayer } from "./material-layers";

/**
 * Turning a solid object into a translucent preview, and back.
 *
 * The clones and the material slot they live in belong to `material-layers.ts`,
 * which is what stops a ghost and a glow from recording each other's clones as
 * the original. All that is left here is what a ghost *looks* like.
 */

const OPACITY = 0.42;

export function setGhost(object: THREE.Object3D, on: boolean): void {
  if (!on) {
    clearLayer(object, "ghost");
    return;
  }
  setLayer(object, "ghost", (original) => {
    const ghost = original.clone();
    ghost.transparent = true;
    ghost.opacity = OPACITY;
    ghost.depthWrite = false;
    // Emissive parts (an oven's glass, a fryer's oil) look lit rather than
    // ghostly unless they're damped down too.
    if (ghost instanceof THREE.MeshStandardMaterial) ghost.emissiveIntensity *= 0.25;
    return ghost;
  });
}

/** Fade the whole ghost together, for the ease in and out. */
export function setGhostOpacity(object: THREE.Object3D, alpha: number): void {
  for (const ghost of layerMaterials(object, "ghost")) ghost.opacity = OPACITY * alpha;
}
