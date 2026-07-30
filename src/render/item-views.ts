import * as THREE from "three";
import { applianceDef } from "../data/appliances";
import { mealLeft } from "../sim/queries";
import { specKey } from "../sim/items";
import type { Appliance, Customer, Item, World } from "../sim/types";
import { chopImpact, workPhase } from "./anim";
import { disposeSubtree } from "./dispose";
import { buildItemModel, contentsOf } from "./models";
import type { PeopleViews } from "./people-views";

/**
 * The food: on counters, in hands, and shrinking as it is eaten.
 *
 * Objects are keyed by item id and rebuilt only when the item's *appearance*
 * changes — a tomato becoming a chopped tomato — so an item being carried
 * across the kitchen is the same object the whole way.
 */
export class ItemViews {
  private readonly objects = new Map<number, { object: THREE.Object3D; key: string }>();
  private readonly live = new Set<number>();
  /** Reused every frame so anchoring a carried item allocates nothing. */
  private readonly anchor = new THREE.Vector3();
  /** The same, for the plate in front of somebody eating. */
  private readonly spot = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly people: PeopleViews,
  ) {}

  sync(world: World, time: number): void {
    this.live.clear();

    for (const appliance of world.appliances.values()) {
      if (!appliance.item || appliance.heldBy !== null) continue;
      const height = applianceDef(appliance.kind).height;
      const object = this.place(
        appliance.item,
        appliance.tile.x + 0.5,
        height + 0.06,
        appliance.tile.y + 0.5,
      );
      // Food squashes on the beat, so the work reads even when the chef is
      // hidden behind the counter they're working at.
      animateWorkedItem(object, appliance, time);
    }

    for (const customer of world.customers) {
      if (!customer.plate) continue;
      const spot = this.dinnerSpot(world, customer);
      if (!spot) continue;
      const object = this.place(customer.plate, spot.x, spot.y, spot.z);
      object.scale.set(1, 1, 1);
      // The meal shrinks as it is eaten, so the dirty plate that follows is the
      // end of something you watched happen rather than a swap.
      setPlateFullness(object, mealLeft(customer));
    }

    for (const player of world.players) {
      if (!player.carried) continue;
      const carry = this.people.carryAnchor(player.id);
      if (!carry) continue;
      // Anchor to the chef's hands so the carried item inherits the walk cycle.
      carry.getWorldPosition(this.anchor);
      this.place(player.carried, this.anchor.x, this.anchor.y, this.anchor.z).scale.set(1, 1, 1);
    }

    for (const [id, entry] of this.objects) {
      if (this.live.has(id)) continue;
      disposeSubtree(entry.object);
      this.objects.delete(id);
    }
  }

  /**
   * Where a diner's own plate sits: on the tabletop, in front of their chair.
   *
   * An eating customer takes their plate off the table so the next dish can
   * land there, which is what makes a party possible — and four plates around
   * the edge of one table is also exactly what a party looks like.
   */
  private dinnerSpot(world: World, customer: Customer): THREE.Vector3 | null {
    const table = customer.table === null ? null : world.appliances.get(customer.table);
    if (!table) return null;
    // Measured from where the customer *is*, not from the seat tile they were
    // given: `seat` is dining-room bookkeeping and never travels, so a client
    // reading it would draw every online party's dinner in the middle of the
    // table.
    const dx = customer.pos.x - (table.tile.x + 0.5);
    const dz = customer.pos.y - (table.tile.y + 0.5);
    const length = Math.hypot(dx, dz) || 1;
    return this.spot.set(
      table.tile.x + 0.5 + (dx / length) * 0.28,
      applianceDef("table").height + 0.06,
      table.tile.y + 0.5 + (dz / length) * 0.28,
    );
  }

  private place(item: Item, x: number, y: number, z: number): THREE.Object3D {
    this.live.add(item.id);
    const key = itemVisualKey(item);
    let entry = this.objects.get(item.id);
    if (!entry || entry.key !== key) {
      if (entry) disposeSubtree(entry.object);
      entry = { object: buildItemModel(item), key };
      this.scene.add(entry.object);
      this.objects.set(item.id, entry);
    }
    entry.object.position.set(x, y, z);
    return entry.object;
  }

  dispose(): void {
    for (const entry of this.objects.values()) disposeSubtree(entry.object);
    this.objects.clear();
  }
}

/**
 * Shrink the food on a plate without shrinking the plate.
 *
 * The plate model keeps its contents in their own group precisely so this can
 * happen: scaling the whole object would shrink the crockery too, which reads
 * as the plate receding rather than the meal going down.
 */
function setPlateFullness(object: THREE.Object3D, fullness: number): void {
  const contents = contentsOf(object);
  if (!contents) return;
  // Never quite to nothing: what is left becomes the crumbs on the dirty plate
  // a moment later, and food that vanished first would break that handover.
  contents.scale.setScalar(0.22 + 0.78 * fullness);
}

/**
 * Per-motion reaction of the food itself. Chopped food is struck, kneaded food
 * is pressed, frying food bobs in the oil and baking food barely moves — the
 * appliance is doing the work, not the ingredient.
 */
function animateWorkedItem(object: THREE.Object3D, appliance: Appliance, time: number): void {
  const motion = appliance.motion;
  if (!motion) {
    object.scale.set(1, 1, 1);
    // Frying leaves a yaw behind. Without putting it back, an item that was
    // once fried kept a stale rotation for the rest of its life.
    object.rotation.y = 0;
    return;
  }
  const phase = workPhase(motion, appliance.id, time);
  if (motion === "fry") {
    object.position.y += Math.sin(phase) * 0.035;
    object.rotation.y = Math.sin(phase * 0.6) * 0.25;
    object.scale.set(1, 1, 1);
    return;
  }
  if (motion === "bake") {
    const swell = 1 + Math.sin(phase) * 0.03;
    object.scale.set(swell, swell, swell);
    return;
  }
  const beat = motion === "chop" ? chopImpact(phase) : Math.max(0, Math.sin(phase));
  const squash = motion === "chop" ? 0.3 : 0.14;
  object.scale.set(1 + beat * squash * 0.5, 1 - beat * squash, 1 + beat * squash * 0.5);
}

/**
 * What an item *looks* like, as a string. Two items with the same key are drawn
 * by the same model, so the object is only rebuilt when this changes.
 */
function itemVisualKey(item: Item): string {
  const own = specKey(item);
  if (item.contents.length === 0) return own;
  return `${own}[${item.contents.map(itemVisualKey).join(";")}]`;
}
