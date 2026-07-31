import * as THREE from "three";
import type { World } from "../sim/types";
import { Bubble } from "./bubble";

/**
 * The orders, floating over the people who placed them.
 *
 * They used to float over the *table*, one each, which was right when a table
 * was one order. A party is three people at one table wanting three different
 * things, and a single bubble above the middle of it cannot say who wants what
 * — so the bubble moved to the head it belongs over. The rule it was built on
 * is unchanged and is the reason it did not move to the corner of the screen
 * instead: **if a piece of UI is about somewhere in the room, it lives in the
 * room.**
 *
 * Positioned in world space rather than parented to the customer's rig. The rig
 * turns to face the table, and a bubble inheriting that rotation would swing
 * around behind them as they sat down.
 *
 * *Whose* head is a question this module deliberately does not answer: a diner
 * has one and a car has a roof, and which of the two a customer is drawn as
 * belongs to the composition root. It is handed a lookup instead — the same
 * bubble, over whatever this kitchen puts its orders in.
 */
export class OrderViews {
  private readonly bubbles = new Map<number, Bubble>();
  /** Reused every frame, so following somebody allocates nothing. */
  private readonly anchor = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly rootOf: (customerId: number) => THREE.Object3D | undefined,
  ) {}

  sync(world: World, dt: number, time: number): void {
    for (const [id, bubble] of this.bubbles) {
      if (world.customers.some((customer) => customer.id === id)) continue;
      bubble.dispose();
      this.scene.remove(bubble.object);
      this.bubbles.delete(id);
    }

    for (const customer of world.customers) {
      const root = this.rootOf(customer.id);
      if (!root) continue;

      let bubble = this.bubbles.get(customer.id);
      if (!bubble) {
        bubble = new Bubble(this.camera);
        this.scene.add(bubble.object);
        this.bubbles.set(customer.id, bubble);
      }

      // The bubble owns its own height above the ground; this only has to say
      // which patch of floor it is over.
      root.getWorldPosition(this.anchor);
      bubble.object.position.x = this.anchor.x;
      bubble.object.position.z = this.anchor.z;
      bubble.update(customer, dt, time);
    }
  }

  dispose(): void {
    for (const bubble of this.bubbles.values()) {
      bubble.dispose();
      this.scene.remove(bubble.object);
    }
    this.bubbles.clear();
  }
}
