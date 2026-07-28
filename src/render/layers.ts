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
 * What it buys today is the shadow map. A light's shadow camera only ever sees
 * layer 0 (`WebGLShadowMap` tests `object.layers.test(camera.layers)`), so
 * nothing on `UI` can cast a shadow — a floating label has no business darkening
 * the counter under it.
 *
 * It was introduced for a second reason that no longer applies, and the history
 * is worth keeping because the trap is easy to walk back into. Screen-space
 * effects that rebuild the scene through an override material draw sprites
 * un-billboarded, as phantom geometry — `GTAOPass` skips Points and Lines for
 * exactly this reason but not Sprites, which hung a large dark rectangle of
 * ambient occlusion behind every appliance label. That pass now reads the depth
 * buffer the main render already produced, which UI never writes to (every UI
 * material sets `depthWrite: false`), so it cannot see them at all.
 *
 * Any future pass that rebuilds the scene rather than sampling it should
 * restrict itself to `WORLD` the same way.
 */
export const LAYER = {
  WORLD: 0,
  UI: 1,
} as const;

/** Move an object and everything under it onto a layer. */
export function setLayer(object: THREE.Object3D, layer: number): void {
  object.traverse((child) => child.layers.set(layer));
}
