import * as THREE from "three";
import { clamp01, ease } from "./anim";
import { type SurfaceName } from "./palette";
import { material } from "./primitives";
import type { Soak } from "../data/biomes";

/**
 * Wet ground: what the rain leaves behind on the things it falls on.
 *
 * The obvious version of this is one material property applied to "the floor",
 * and it is the reason the feature sat unbuilt: the floor here is grass, sand,
 * tarmac and paving depending on where you are standing, and **only some of
 * those shine**. Wet sand goes much darker and barely gleams; a paving slab
 * goes a little darker and turns into a mirror for the sky; a lawn does neither
 * very much. One dial for all of them is either a shiny meadow or dry-looking
 * pavement.
 *
 * So the dial is per surface and it lives in content — `Soak` in
 * `data/biomes.ts`, two numbers — and this is the machinery that applies it:
 * albedo down, roughness down, eased from one day into the next.
 *
 * ## It hands out its own materials
 *
 * Materials in `primitives.ts` are shared by colour and finish, which is what
 * keeps the kitchen down to a handful of draw calls — and it means darkening
 * one in place would darken every other object that ever asks for the same
 * brown. Anything that gets wet therefore gets a copy of its own, made once per
 * colour and finish so the merge still batches it into a single draw.
 *
 * ## Nothing here is water
 *
 * No puddles, no ripples, no reflection pass. A wet surface is a darker, less
 * rough one, and the sheen is the biome's own sky arriving through the
 * environment map the lighting already builds — which is why a rainy day gleams
 * grey rather than gleaming blue.
 */

/** How fast the ground takes water, as a fraction of the gap per second. */
const SOAKING = 0.5;

/**
 * Near enough. An exponential ease never arrives, and the last fraction of a
 * percent is both invisible and the difference between a dry day being
 * *nothing happening* and being a wetness of 0.0006 written for ever.
 */
const SETTLED = 0.002;

/**
 * And how fast it gives it back. Slower on purpose: rain stops at a day
 * boundary, and paving that was dry the moment it did would say the last day
 * never happened.
 */
const DRYING = 0.12;

/**
 * Paving, path slabs and tarmac — everything laid *on* the ground rather than
 * being it.
 *
 * One constant rather than a column per biome, because a slab is a slab
 * wherever it is laid. The gloss is the highest in the game: hard flat stone is
 * the surface a film of water actually turns into a mirror, and it is the one
 * that makes a wet day read as wet.
 */
export const PAVED: Soak = { darken: 0.24, gloss: 0.6 };

type Soaked = {
  material: THREE.MeshStandardMaterial;
  dryColor: THREE.Color;
  dryRoughness: number;
  soak: Soak;
};

/** The surfaces this kitchen's rain falls on, and how wet they are right now. */
export class Wet {
  private readonly surfaces: Soaked[] = [];
  /** One copy per colour and finish, so a wet batch is still one draw call. */
  private readonly copies = new Map<string, THREE.MeshStandardMaterial>();

  private amount = 0;
  /** The wetness the surfaces are currently painted with. See `update`. */
  private applied = -1;

  /** A mesh whose material is its own, and may therefore be rained on. */
  mesh(
    geometry: THREE.BufferGeometry,
    color: number,
    surface: SurfaceName,
    soak: Soak,
  ): THREE.Mesh {
    const key = `${color}:${surface}`;
    let own = this.copies.get(key);
    if (!own) {
      own = material(color, surface).clone();
      this.copies.set(key, own);
      this.claim(own, soak);
    }
    const object = new THREE.Mesh(geometry, own);
    object.castShadow = true;
    object.receiveShadow = true;
    return object;
  }

  /**
   * Rain on a material that was built elsewhere — the ground plane makes its
   * own, because it carries a generated texture nothing else wants.
   *
   * The caller keeps ownership: this only remembers what dry looked like.
   */
  claim(surface: THREE.MeshStandardMaterial, soak: Soak): THREE.MeshStandardMaterial {
    this.surfaces.push({
      material: surface,
      dryColor: surface.color.clone(),
      dryRoughness: surface.roughness,
      soak,
    });
    return surface;
  }

  /**
   * Forget the last kitchen's ground.
   *
   * The materials go with the meshes they were baked into, so this frees
   * nothing — it drops references to things `disposeSubtree` is about to
   * dispose. How wet it is survives, because the weather did not change just
   * because somebody opened a different kitchen.
   */
  clear(): void {
    this.surfaces.length = 0;
    this.copies.clear();
    this.applied = -1;
  }

  /**
   * Soak toward `amount`, the weather's own 0..1 — so a drizzle leaves the
   * paving damp and a downpour leaves it shining.
   *
   * Skipped entirely once it has settled, which is most of the day: this writes
   * to material uniforms, and a kitchen in the sun should not be paying for
   * weather it is not having.
   */
  update(amount: number, dt: number): void {
    const wanted = clamp01(amount);
    this.amount += (wanted - this.amount) * ease(wanted > this.amount ? SOAKING : DRYING, dt);
    if (Math.abs(wanted - this.amount) < SETTLED) this.amount = wanted;
    if (this.amount === this.applied) return;
    this.applied = this.amount;

    for (const surface of this.surfaces) {
      surface.material.color
        .copy(surface.dryColor)
        .multiplyScalar(1 - surface.soak.darken * this.amount);
      surface.material.roughness = surface.dryRoughness * (1 - surface.soak.gloss * this.amount);
    }
  }
}
