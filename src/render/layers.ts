import type * as THREE from "three";

/**
 * Render layers.
 *
 * `WORLD` goes through the full post-processing chain. `UI` holds the 3D
 * overlay — appliance labels, progress bars, interaction highlights — and is
 * drawn *after* post-processing, on a cleared depth buffer.
 *
 * This is not just a stylistic choice. Screen-space effects reconstruct the
 * scene from a depth/normal buffer, and UI objects lie about both: they sit in
 * front of the world, ignore depth testing, and (for sprites) are billboarded
 * inside the vertex shader, so a G-buffer pass using an override material draws
 * them un-billboarded as phantom geometry. `GTAOPass` excludes Points and Lines
 * from its normal pass but *not* Sprites, which produced a large dark rectangle
 * of ambient occlusion hanging behind every appliance label.
 *
 * Keeping UI on its own layer fixes that at the source and keeps labels crisp:
 * they are not bloomed, graded or vignetted along with the world.
 */
export const LAYER = {
  WORLD: 0,
  UI: 1,
} as const;

/** Move an object and everything under it onto a layer. */
export function setLayer(object: THREE.Object3D, layer: number): void {
  object.traverse((child) => child.layers.set(layer));
}
