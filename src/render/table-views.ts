import * as THREE from "three";
import { applianceDef } from "../data/appliances";
import type { World } from "../sim/types";
import { ease } from "./anim";
import type { ApplianceViews } from "./appliance-views";
import { Bubble } from "./bubble";
import { disposeSubtree } from "./dispose";
import { buildTipStack } from "./overlay-meshes";

/**
 * What a table has to say: the order bubble above it, and the tip left on it.
 *
 * The ring over a table nobody can walk to used to live here too, back when a
 * table was the only thing that could be stranded. It is `ApplianceViews`'
 * business now that a chef can wall themselves away from the sink just as
 * easily — one marker, wherever the wall is.
 *
 * Keyed by appliance id and torn down when the appliance goes, which it can —
 * a reset renumbers the kitchen and online the server can hand us a different
 * layout entirely.
 */

type TableVisual = {
  bubble: Bubble;
  /** Tip coins, and how far they have risen into view. */
  tip: { object: THREE.Object3D; alpha: number };
};

export class TableViews {
  private readonly visuals = new Map<number, TableVisual>();

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

    for (const appliance of world.appliances.values()) {
      if (appliance.kind !== "table") continue;
      const root = this.appliances.root(appliance.id);
      if (!root) continue;

      let visual = this.visuals.get(appliance.id);
      if (!visual) {
        visual = this.create(root);
        this.visuals.set(appliance.id, visual);
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

  private create(root: THREE.Object3D): TableVisual {
    const bubble = new Bubble(this.camera);
    root.add(bubble.object);

    // Off to one side: the middle of the table belongs to the plate that has to
    // be picked up with it.
    const coins = buildTipStack();
    coins.position.set(0.26, applianceDef("table").height + 0.04, -0.22);
    coins.visible = false;
    root.add(coins);

    return { bubble, tip: { object: coins, alpha: 0 } };
  }

  private release(visual: TableVisual): void {
    // Order matters, and it used to be wrong. `syncAppliances` ran first and
    // deleted the appliance's object, so by the time the bubble was torn down
    // its parent was already gone and `dispose` was skipped entirely — meaning
    // the bubble's own Dial geometry and shader were never even reachable.
    // These visuals now own their parts outright and free them directly.
    visual.bubble.dispose();
    disposeSubtree(visual.tip.object);
  }

  dispose(): void {
    for (const visual of this.visuals.values()) this.release(visual);
    this.visuals.clear();
  }
}
