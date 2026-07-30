import * as THREE from "three";
import { applianceDef } from "../data/appliances";
import type { World } from "../sim/types";
import { ease } from "./anim";
import type { ApplianceViews } from "./appliance-views";
import { disposeSubtree } from "./dispose";
import { buildTipStack } from "./overlay-meshes";

/**
 * What a table has to say: the tip left on it.
 *
 * It used to say more. The ring over a table nobody can walk to went to
 * `ApplianceViews` when a chef could wall themselves away from the sink just as
 * easily, and the order bubble went to `OrderViews` when a table stopped being
 * one order — a party is three people wanting three things, and a single bubble
 * over the middle of the table cannot say who wants what. What is left is the
 * one thing that genuinely belongs to the furniture rather than to a person:
 * the coins somebody left behind on their way out.
 *
 * Keyed by appliance id and torn down when the appliance goes, which it can —
 * a reset renumbers the kitchen and online the server can hand us a different
 * layout entirely.
 */

type TableVisual = {
  /** Tip coins, and how far they have risen into view. */
  tip: { object: THREE.Object3D; alpha: number };
};

export class TableViews {
  private readonly visuals = new Map<number, TableVisual>();

  constructor(private readonly appliances: ApplianceViews) {}

  sync(world: World, dt: number): void {
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
    // Off to one side: the middle of the table belongs to the plates that have
    // to be picked up with it.
    const coins = buildTipStack();
    coins.position.set(0.26, applianceDef("table").height + 0.04, -0.22);
    coins.visible = false;
    root.add(coins);

    return { tip: { object: coins, alpha: 0 } };
  }

  private release(visual: TableVisual): void {
    // These visuals own their parts outright and free them directly: appliance
    // meshes are torn down in the same frame, and a child freed through its
    // parent after the parent has gone is a child that is never freed at all.
    disposeSubtree(visual.tip.object);
  }

  dispose(): void {
    for (const visual of this.visuals.values()) this.release(visual);
    this.visuals.clear();
  }
}
