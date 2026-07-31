import * as THREE from "three";

import { DT } from "../sim/step";
import { CAR_SPEED } from "../sim/lane";
import type { Customer, World } from "../sim/types";
import { ease, lerp } from "./anim";
import { buildCar, type CarParts } from "./car-mesh";
import { disposeSubtree } from "./dispose";

/**
 * The cars in a drive-through lane.
 *
 * The counterpart of `people-views.ts` for a kitchen that has no dining room:
 * where that module draws a customer as somebody walking, this one draws the
 * same customer as something driving. Which of the two a room uses is decided
 * by `world.lane`, in one place, in `view.ts` — a customer is never both.
 *
 * Three things are animated, and each is a fact the simulation already knows
 * drawn where it can be read from across the kitchen:
 *
 * - **the wheels**, spun by distance covered, so a car that has stopped has
 *   visibly stopped;
 * - **the nose**, which dips under braking and rises as it pulls away, out of
 *   the same speed the wheels use;
 * - **the idle**, a slow shudder while a car sits at the window waiting, which
 *   is what stops a stationary queue reading as scenery.
 *
 * There is no patience pose. A diner slumps in their chair because a person can
 * do that; a car cannot, so impatience is left entirely to the bubble's ring
 * over the roof — see `order-views.ts`.
 */

type CarRig = CarParts & {
  /** Wheel rotation, advanced by distance rather than by time. */
  spin: number;
  /** Eased speed, 0..1, so the nose does not snap between frames. */
  motion: number;
};

export class CarViews {
  private readonly cars = new Map<number, CarRig>();

  constructor(private readonly scene: THREE.Scene) {}

  /** Where a car is being drawn, for anything that hangs over it. */
  carRoot(customerId: number): THREE.Object3D | undefined {
    return this.cars.get(customerId)?.root;
  }

  sync(world: World, alpha: number, dt: number, time: number): void {
    for (const [id, rig] of this.cars) {
      if (world.customers.some((customer) => customer.id === id)) continue;
      disposeSubtree(rig.root);
      this.cars.delete(id);
    }

    for (const customer of world.customers) {
      let rig = this.cars.get(customer.id);
      if (!rig) {
        // Indexed by id, exactly as a coat is: one visit is one car, and two
        // arriving together rarely match.
        const parts = buildCar(customer.kind, customer.id);
        this.scene.add(parts.root);
        rig = { ...parts, spin: 0, motion: 0 };
        this.cars.set(customer.id, rig);
      }
      this.syncCar(customer, rig, alpha, dt, time);
    }
  }

  private syncCar(customer: Customer, rig: CarRig, alpha: number, dt: number, time: number): void {
    rig.root.position.set(
      lerp(customer.prevPos.x, customer.pos.x, alpha),
      0,
      lerp(customer.prevPos.y, customer.pos.y, alpha),
    );
    rig.root.rotation.y = Math.atan2(customer.facing.x, customer.facing.y);

    const moved = Math.hypot(
      customer.pos.x - customer.prevPos.x,
      customer.pos.y - customer.prevPos.y,
    );
    const speed = Math.min(1, moved / (CAR_SPEED * DT));
    rig.motion += (speed - rig.motion) * ease(6, dt);

    // Distance, not time: wheels that turn at a fixed rate on a car that is not
    // moving are the one thing everybody notices.
    rig.spin += (moved / DT) * dt * 6;
    for (const wheel of rig.wheels) wheel.rotation.x = rig.spin;

    // Weight transfer. Positive pitch is the nose down, which is what braking
    // into the window looks like; pulling away lifts it again.
    const settle = Math.sin(time * 7 + customer.id) * 0.006 * (1 - rig.motion);
    rig.body.rotation.x = 0.05 - rig.motion * 0.09;
    rig.body.position.y = settle;
  }

  dispose(): void {
    for (const rig of this.cars.values()) disposeSubtree(rig.root);
    this.cars.clear();
  }
}
