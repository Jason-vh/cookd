import * as THREE from "three";
import { clearLayer, setLayer } from "./material-layers";

/**
 * Lighting up the thing a chef is pointing at, and putting it back.
 *
 * What a chef would interact with used to be shown as a translucent square
 * floating above the appliance, which asks the player to do the join
 * themselves: the square is over the oven, so it must mean the oven. Lighting
 * the object *is* the statement, and it needs no interpreting at a glance in
 * the middle of a rush.
 *
 * Emissive rather than a brighter base colour, because it has to survive the
 * shadow it might be standing in: an appliance in shade would barely change if
 * this only multiplied what the light was already doing to it.
 *
 * The clones and the material slot they live in belong to `material-layers.ts`,
 * where a ghosted appliance — one being carried, and so one that cannot be
 * pointed at anyway — paints over a glow rather than fighting it.
 */

/** How hard the tint is pushed. Enough to be unmistakable, short of neon. */
const EMISSIVE = 0.42;

/** Light `object` in `color`, or put it back when `color` is null. */
export function setGlow(object: THREE.Object3D, color: number | null): void {
  if (color === null) {
    clearLayer(object, "glow");
    return;
  }
  const glows = setLayer(object, "glow", (original) => {
    // Only the standard materials, which is every part of an appliance. A dial's
    // shader material has no emissive to push and says its own thing anyway.
    if (!(original instanceof THREE.MeshStandardMaterial)) return null;
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
    if (original.emissive.getHex() !== 0 || original.map) return null;
    const glow = original.clone();
    glow.emissiveIntensity = EMISSIVE;
    return glow;
  });
  // Set every frame: two chefs can point at one appliance, and the colour is
  // whose chef is pointing. Every clone here came out of the factory above and
  // is therefore standard; asking again is how that stays true to the compiler.
  for (const glow of glows) {
    if (glow instanceof THREE.MeshStandardMaterial) glow.emissive.setHex(color);
  }
}
