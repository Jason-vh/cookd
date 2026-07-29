import * as THREE from "three";
import { applianceDef } from "../data/appliances";
import type { Appliance, World } from "../sim/types";
import { playerById } from "../sim/world";
import { canPlace, targetTile } from "../sim/systems/interaction";
import { chopLift, ease, workPhase } from "./anim";
import { Dial } from "./dial";
import { disposeSubtree } from "./dispose";
import { setGhost, setGhostOpacity } from "./ghost";
import { buildAppliance, type ApplianceParts } from "./meshes";
import { PALETTE } from "./palette";

/**
 * Everything that draws an appliance: its mesh, its dial, its moving parts, and
 * the ghost that previews where a held one would land.
 *
 * Split out of `View`, which had grown to 1074 lines and owned this alongside
 * chef rigs, customer rigs, tables, items, highlights, effect cues, lighting
 * and the camera. Every one of those is the same shape — a `Map` keyed by
 * simulation id, with add, remove and update — so each is a module rather than
 * another two hundred lines in the same class.
 */

/** Per-appliance animation state that has no home in the simulation. */
type Visual = ApplianceParts & {
  dial: Dial;
  /** Eased dial fade and completion flash. */
  dialAlpha: number;
  dialFlash: number;
  /** How far the bin lid is still flipped open, 1..0. */
  binOpen: number;
  /** Placement ghost: eased position, fade, and the pop when it lands. */
  ghost: { alpha: number; x: number; z: number; pop: number; held: boolean };
};

export class ApplianceViews {
  private readonly visuals = new Map<number, Visual>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
  ) {}

  /** The object an appliance is drawn as, for things that hang off it. */
  root(id: number): THREE.Object3D | undefined {
    return this.visuals.get(id)?.root;
  }

  /** Show this appliance's contextual name for one frame. */
  showLabel(id: number): void {
    const label = this.visuals.get(id)?.label;
    if (label) label.visible = true;
  }

  /** A bin had something thrown in it: flip the lid. */
  openBin(id: number): void {
    const visual = this.visuals.get(id);
    if (visual) visual.binOpen = 1;
  }

  sync(world: World, dt: number, time: number): void {
    // Appliances can vanish: a reset renumbers the kitchen, and online the
    // server can hand us a completely different layout. Meshes for ids that no
    // longer exist have to go, or they hang in the scene forever.
    for (const [id, visual] of this.visuals) {
      if (world.appliances.has(id)) continue;
      this.release(visual);
      this.visuals.delete(id);
    }

    for (const appliance of world.appliances.values()) {
      let visual = this.visuals.get(appliance.id);
      if (!visual) {
        visual = this.create(appliance);
        this.visuals.set(appliance.id, visual);
      }

      this.place(world, appliance, visual, dt, time);

      // Labels are off by default and turned on for one frame by whoever is
      // pointing at this appliance — see `showLabel`.
      if (visual.label) visual.label.visible = false;

      const phase = workPhase(appliance.motion, appliance.id, time);
      this.animateParts(appliance, visual, phase, dt);
      this.syncDial(appliance, visual, dt, time);
    }
  }

  private create(appliance: Appliance): Visual {
    const parts = buildAppliance(appliance);
    const dial = new Dial(this.camera);
    dial.object.position.y = applianceDef(appliance.kind).height + 0.72;
    parts.root.add(dial.object);
    this.scene.add(parts.root);
    return {
      ...parts,
      dial,
      dialAlpha: 0,
      dialFlash: 0,
      binOpen: 0,
      ghost: { alpha: 0, x: 0, z: 0, pop: 0, held: false },
    };
  }

  private release(visual: Visual): void {
    visual.dial.dispose();
    disposeSubtree(visual.root);
  }

  /** Free every appliance visual. Used when the whole view goes away. */
  dispose(): void {
    for (const visual of this.visuals.values()) this.release(visual);
    this.visuals.clear();
  }

  /**
   * The parts that move: a knife swinging with the chop, oil boiling, oven
   * glass glowing, a bin lid falling shut.
   *
   * Fryers and ovens work unattended, so they have to advertise it themselves —
   * the dial only shows when you are stood there.
   */
  private animateParts(appliance: Appliance, visual: Visual, phase: number, dt: number): void {
    const height = applianceDef(appliance.kind).height;

    if (visual.knife) {
      // The knife swings with the chop, on the same phase as the chef's arms.
      const lift = appliance.motion === "chop" ? chopLift(phase) : 0;
      visual.knife.rotation.z = lift * 1.15;
      visual.knife.position.y = height + 0.09 + lift * 0.1;
    }

    if (visual.oil && visual.oilGlow) {
      const frying = appliance.motion === "fry";
      const boil = Math.sin(phase) * 0.5 + Math.sin(phase * 2.7) * 0.5;
      visual.oil.position.y = height + 0.05 + (frying ? boil * 0.012 : 0);
      visual.oil.scale.y = frying ? 1 + boil * 0.35 : 1;
      visual.oilGlow.emissiveIntensity = frying ? 0.7 + boil * 0.5 : 0.4;
      if (visual.basket)
        visual.basket.rotation.z = 0.4 + (frying ? Math.sin(phase * 0.7) * 0.12 : 0);
    }

    if (visual.glass) {
      // Slow, uneven ember glow: an oven does not blink, it breathes. Kept low
      // on purpose: pushed hard the emissive washes the dark glass out to flat
      // orange paint. It should read as embers behind a window.
      const heat =
        appliance.motion === "bake"
          ? 0.3 + Math.sin(phase) * 0.12 + Math.sin(phase * 3.3) * 0.05
          : 0;
      for (const pane of visual.glass) pane.emissiveIntensity = heat;
    }

    if (visual.lid) {
      visual.binOpen = Math.max(0, visual.binOpen - dt * 2.2);
      visual.lid.rotation.x = -visual.binOpen * 1.15;
    }
  }

  /**
   * A held appliance is drawn as a **ghost standing on the tile it would go
   * to**, not carried on the chef's head.
   *
   * Balancing an oven on someone's hat is funny once; it also puts the thing
   * you are deciding about in the one place you are not looking. The decision
   * during the build phase is "does it go *there*", so the preview belongs
   * there — and because the ghost slides between tiles it doubles as a readout
   * of which tile you're actually pointing at.
   */
  private place(
    world: World,
    appliance: Appliance,
    visual: Visual,
    dt: number,
    time: number,
  ): void {
    const held = appliance.heldBy !== null ? playerById(world, appliance.heldBy) : undefined;
    const state = visual.ghost;

    if (held) {
      const tile = targetTile(held);
      const valid = canPlace(world, tile.x, tile.y);
      const inGrid = tile.x >= 0 && tile.y >= 0 && tile.x < world.width && tile.y < world.height;
      // The ghost always answers "where would this go"; whether it *settles* or
      // stays hovering answers "can it". Two questions, two channels — plus the
      // highlight underneath turns red. Off the grid entirely there is no tile
      // to point at, so it stays with the chef.
      const targetX = inGrid ? tile.x + 0.5 : held.pos.x;
      const targetZ = inGrid ? tile.y + 0.5 : held.pos.y;

      if (!state.held) {
        state.held = true;
        state.x = held.pos.x;
        state.z = held.pos.y;
        state.alpha = 0;
        setGhost(visual.root, true);
      }
      const chase = ease(16, dt);
      state.x += (targetX - state.x) * chase;
      state.z += (targetZ - state.z) * chase;
      state.alpha = Math.min(1, state.alpha + dt * 6);

      const settle = state.alpha * state.alpha;
      // Valid: sinks onto the tile. Invalid: hangs above it with a slow bob,
      // which reads as "held" rather than "placed" without needing a colour.
      const hover = 0.42 + Math.sin(time * 3) * 0.03;
      visual.root.position.set(state.x, valid ? 0.06 * (2 - settle) : hover, state.z);
      visual.root.scale.setScalar(0.86 + 0.14 * settle);
      setGhostOpacity(visual.root, valid ? state.alpha : state.alpha * 0.7);
      return;
    }

    if (state.held) {
      // Just set down: go solid and pop.
      state.held = false;
      state.alpha = 0;
      state.pop = 1;
      setGhost(visual.root, false);
    }
    state.pop = Math.max(0, state.pop - dt * 4);
    const pop = state.pop * state.pop;
    visual.root.position.set(appliance.tile.x + 0.5, 0, appliance.tile.y + 0.5);
    visual.root.scale.set(1 + 0.13 * pop, 1 - 0.18 * pop, 1 + 0.13 * pop);
  }

  /**
   * Ease the dial in and out, and let it say *what* is happening rather than
   * only how far along it is:
   *
   *   - prep is mint, cooking is gold — the two feel different, so they look it;
   *   - burning is red and **pulses**, because in peripheral vision movement
   *     carries where colour does not, and burning is the one state that needs
   *     you to look;
   *   - finishing flashes white and expands, so a completed chop registers even
   *     if you were watching another chef at the time.
   */
  private syncDial(appliance: Appliance, visual: Visual, dt: number, time: number): void {
    const burning = appliance.overcook > 0;
    const active = appliance.progress > 0.001;

    // Ease in fast, out slow: appearing should feel instant, leaving should not
    // snatch the last frame of information away.
    const target = active ? 1 : 0;
    visual.dialAlpha += (target - visual.dialAlpha) * ease(active ? 9 : 4, dt);
    if (appliance.justFinished) visual.dialFlash = 1;
    visual.dialFlash = Math.max(0, visual.dialFlash - dt * 3.2);

    const pulse = burning ? 1 + Math.sin(time * 14) * 0.09 : 1;
    visual.dial.apply({
      progress: appliance.progress,
      color: burning ? PALETTE.progressBurn : cookingColor(appliance),
      alpha: visual.dialAlpha,
      flash: visual.dialFlash * visual.dialFlash,
      scale: pulse * (1 + visual.dialFlash * 0.28),
    });
  }
}

/** Prep and cooking feel different, so their gauges look different. */
function cookingColor(appliance: Appliance): number {
  return appliance.motion === "fry" || appliance.motion === "bake"
    ? PALETTE.progressCook
    : PALETTE.progressGood;
}
