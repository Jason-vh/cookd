import type * as THREE from "three";

/**
 * Render layers.
 *
 * `UI` holds the 3D overlay — appliance labels, progress dials, interaction
 * highlights, score popups. Everything else is `WORLD`.
 *
 * Both are drawn in the same pass: the main camera enables both layers, so UI
 * is composited with the world and *is* bloomed, graded and vignetted with it.
 * The split is about which passes are allowed to see UI, not about when it is
 * drawn.
 *
 * It was introduced for a reason that no longer applies, and the history is
 * worth keeping because the trap is easy to walk back into. Screen-space
 * effects that rebuild the scene through an override material draw sprites
 * un-billboarded, as phantom geometry — `GTAOPass` skips Points and Lines for
 * exactly this reason but not Sprites, which hung a large dark rectangle of
 * ambient occlusion behind every appliance label. That pass now reads the depth
 * buffer the main render already produced, which UI never writes to (every UI
 * material sets `depthWrite: false`), so it cannot see them at all.
 *
 * Any future pass that rebuilds the scene rather than sampling it should
 * restrict itself to `WORLD` the same way.
 *
 * The layer does **not**, on its own, keep UI out of the shadow map — which it
 * was believed to, in a comment, for as long as it took a low sun to make the
 * shadows long enough to notice. `WebGLShadowMap` tests each object against the
 * *view* camera's layers, not the shadow camera's, so that things the player
 * cannot see cast nothing; and the view camera enables `UI` precisely so the UI
 * is visible. A floating order bubble therefore cast a salad-shaped shadow onto
 * the dining room floor. Shadows are switched off explicitly below, in the same
 * place the layer is set, so the two cannot drift apart again.
 */
export const LAYER = {
  WORLD: 0,
  UI: 1,
} as const;

/**
 * Move an object and everything under it onto the UI layer: drawn with the
 * world, lit by nothing, and casting and receiving no shadow.
 *
 * Call it *after* the parts are added — a model swapped into a bubble later is
 * a new child, and traversal only reaches what is there at the time.
 */
export function markUI(object: THREE.Object3D): void {
  object.traverse((child) => {
    child.layers.set(LAYER.UI);
    child.castShadow = false;
    child.receiveShadow = false;
  });
}
