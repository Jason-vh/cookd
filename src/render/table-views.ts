import * as THREE from "three";
import { applianceDef } from "../data/appliances";
import { unreachableTables } from "../sim/systems/customers";
import type { World } from "../sim/types";
import { ease } from "./anim";
import type { ApplianceViews } from "./appliance-views";
import { Bubble } from "./bubble";
import { disposeSubtree } from "./dispose";
import { buildHighlight, buildTipStack } from "./meshes";
import { PALETTE } from "./palette";

/**
 * What a table has to say: the order bubble above it, the tip left on it, and
 * whether anyone can actually reach it.
 *
 * Keyed by appliance id and torn down when the appliance goes, which it can —
 * a reset renumbers the kitchen and online the server can hand us a different
 * layout entirely.
 */

type TableVisual = {
  bubble: Bubble;
  /** Tip coins, and how far they have risen into view. */
  tip: { object: THREE.Object3D; alpha: number };
  /** Ring shown when the dining room cannot be walked to. */
  warning: THREE.Mesh;
};

export class TableViews {
  private readonly visuals = new Map<number, TableVisual>();

  /** Tables the door cannot reach, and the layout that answer was computed for. */
  private stranded = new Set<number>();
  private strandedFor = -1;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly appliances: ApplianceViews,
  ) {}

  sync(world: World, dt: number, time: number): void {
    for (const [id, visual] of this.visuals) {
      if (world.appliances.get(id)?.kind === "table" && this.appliances.root(id)) continue;
      this.release(visual);
      this.visuals.delete(id);
    }

    this.syncStranded(world);

    for (const appliance of world.appliances.values()) {
      if (appliance.kind !== "table") continue;
      const root = this.appliances.root(appliance.id);
      if (!root) continue;

      let visual = this.visuals.get(appliance.id);
      if (!visual) {
        visual = this.create(root);
        this.visuals.set(appliance.id, visual);
      }

      visual.warning.visible = world.phase === "build" && this.stranded.has(appliance.id);
      if (visual.warning.visible) {
        highlightMaterial(visual.warning).opacity = 0.62 + Math.sin(time * 5) * 0.3;
      }

      // Deliberately a loop rather than `.find`: this runs per table per frame,
      // and `.find` allocated a closure for each one.
      let waiting = null;
      for (const customer of world.customers) {
        if (customer.table === appliance.id && customer.state === "ordering") {
          waiting = customer;
          break;
        }
      }
      visual.bubble.update(waiting, dt, time);

      // The tip rises out of the table when it appears and sinks away when
      // collected, so money never simply blinks into or out of the room.
      const tip = visual.tip;
      const wanted = appliance.tip > 0 ? 1 : 0;
      tip.alpha += (wanted - tip.alpha) * ease(wanted ? 11 : 7, dt);
      tip.object.visible = tip.alpha > 0.01;
      if (tip.object.visible) {
        const settle = tip.alpha * tip.alpha;
        tip.object.scale.setScalar(settle);
        tip.object.position.y = applianceDef("table").height + 0.04 + (1 - settle) * 0.12;
        tip.object.rotation.y += dt * 0.8;
      }
    }
  }

  /**
   * A table nobody can walk to is the one build-phase mistake that silently
   * ends a run, so it is marked in the room rather than only mentioned in the
   * log.
   *
   * The flood fill used to run **every frame** of the build phase, allocating
   * an array and a Set each time, behind a comment that said "recomputed only
   * in the build phase" — true, and easy to read as "once". Keyed on
   * `layoutVersion` it genuinely is once, and it recomputes the instant an
   * appliance moves, which is exactly when the answer can change.
   */
  private syncStranded(world: World): void {
    if (world.phase !== "build") {
      if (this.stranded.size > 0) this.stranded.clear();
      this.strandedFor = -1;
      return;
    }
    if (world.layoutVersion === this.strandedFor) return;
    this.strandedFor = world.layoutVersion;
    this.stranded = new Set(unreachableTables(world).map((table) => table.id));
  }

  private create(root: THREE.Object3D): TableVisual {
    const bubble = new Bubble(this.camera);
    root.add(bubble.object);

    // Same red as a burning pan: this needs you. Above the tabletop, not under
    // it: on the floor the table's own footprint hides most of the ring, which
    // is a poor showing for the one marker that means "this will not work
    // tomorrow".
    const warning = buildHighlight(PALETTE.progressBurn);
    warning.position.y = applianceDef("table").height + 0.14;
    warning.scale.setScalar(1.15);
    warning.visible = false;
    root.add(warning);

    // Off to one side: the middle of the table belongs to the plate that has to
    // be picked up with it.
    const coins = buildTipStack();
    coins.position.set(0.26, applianceDef("table").height + 0.04, -0.22);
    coins.visible = false;
    root.add(coins);

    return { bubble, warning, tip: { object: coins, alpha: 0 } };
  }

  private release(visual: TableVisual): void {
    // Order matters, and it used to be wrong. `syncAppliances` ran first and
    // deleted the appliance's object, so by the time the bubble was torn down
    // its parent was already gone and `dispose` was skipped entirely — meaning
    // the bubble's own Dial geometry and shader were never even reachable.
    // These visuals now own their parts outright and free them directly.
    visual.bubble.dispose();
    disposeSubtree(visual.warning);
    disposeSubtree(visual.tip.object);
  }

  dispose(): void {
    for (const visual of this.visuals.values()) this.release(visual);
    this.visuals.clear();
  }
}

function highlightMaterial(warning: THREE.Mesh): THREE.MeshBasicMaterial {
  if (Array.isArray(warning.material) || !(warning.material instanceof THREE.MeshBasicMaterial)) {
    throw new Error("highlight lost its material");
  }
  return warning.material;
}
