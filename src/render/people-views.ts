import * as THREE from "three";

import { DT } from "../sim/step";
import type { ChefMotion, Customer, Player, World } from "../sim/types";
import { customerSpeed } from "../sim/queries";
import { PLAYER_SPEED } from "../sim/world";
import { chopImpact, chopLift, ease, isChefMotion, lerp, workPhase } from "./anim";
import { disposeSubtree } from "./dispose";
import { setGhost } from "./ghost";
import { buildChef, buildCustomer, type ChefParts } from "./person-mesh";
import { makeNameTag } from "./sprites";
import { PALETTE } from "./palette";

/**
 * Chefs and customers.
 *
 * They are one module because they are one rig: a customer is a chef model with
 * two poses of its own. The walk cycle, the idle sway and the speed-to-phase
 * conversion were written out twice in `View`, differing only in two constants,
 * which is exactly the kind of duplication that drifts — the chef's version had
 * already gained a `time`-based idle breath the customer's never got.
 *
 * All animation is derived from simulation state and never stored in it. The
 * walk cycle, the forward lean and the squash on pickup do more for how the
 * game feels than any amount of extra geometry would.
 */

type Rig = ChefParts & {
  /** Walk-cycle phase, advanced by speed. */
  phase: number;
};

type ChefRig = Rig & {
  /** Squash-and-stretch countdown, triggered when what they hold changes. */
  pop: number;
  lastCarried: number;
  tag?: THREE.Sprite;
  tagName?: string;
  wasAway?: boolean;
};

type CustomerRig = Rig & {
  /** Eased impatience, 0..1. */
  slump: number;
};

/**
 * Hip height of a seated customer, a touch below the chair seat in
 * `buildTable` so they settle into it rather than hover.
 */
const SEAT_HEIGHT = 0.3;

/**
 * Radians per second of the eating bob. Offset per customer by their id, so a
 * full dining room never munches in unison.
 */
const MUNCH_RATE = 4.6;

export class PeopleViews {
  private readonly chefs = new Map<number, ChefRig>();
  private readonly customers = new Map<number, CustomerRig>();
  /**
   * Palette slot per player, so a name tag matches its chef.
   *
   * Assigned by finding the lowest free slot rather than by counting how many
   * players there are. Counting collided: after a player left, the next to join
   * took `size % colours`, which is the slot of somebody still standing there.
   */
  private readonly colors = new Map<number, number>();

  constructor(private readonly scene: THREE.Scene) {}

  /** The hand anchor a carried item hangs from. */
  carryAnchor(playerId: number): THREE.Object3D | undefined {
    return this.chefs.get(playerId)?.carry;
  }

  /**
   * Where a customer is being drawn, for anything that hangs over them.
   *
   * Read rather than recomputed: a seated customer is pulled off their tile and
   * onto their chair here, and an order bubble doing that arithmetic for itself
   * is a second opinion about where somebody is sitting.
   */
  customerRoot(customerId: number): THREE.Object3D | undefined {
    return this.customers.get(customerId)?.root;
  }

  colorOf(playerId: number): number {
    return PALETTE.chefs[this.colors.get(playerId) ?? 0] ?? PALETTE.chefs[0];
  }

  syncChefs(world: World, alpha: number, dt: number, time: number): void {
    for (const [id, chef] of this.chefs) {
      if (world.players.some((player) => player.id === id)) continue;
      disposeSubtree(chef.root);
      this.chefs.delete(id);
      this.colors.delete(id);
    }

    for (const player of world.players) {
      let chef = this.chefs.get(player.id);
      if (!chef) {
        this.colors.set(player.id, this.freeColorSlot());
        const parts = buildChef(this.colors.get(player.id) ?? 0);
        this.scene.add(parts.root);
        chef = { ...parts, phase: 0, pop: 0, lastCarried: 0 };
        this.chefs.set(player.id, chef);
      }
      this.syncChef(world, player, chef, alpha, dt, time);
    }
  }

  /** The lowest palette slot nobody on screen is using. */
  private freeColorSlot(): number {
    const taken = new Set(this.colors.values());
    for (let slot = 0; slot < PALETTE.chefs.length; slot++) {
      if (!taken.has(slot)) return slot;
    }
    return this.colors.size % PALETTE.chefs.length;
  }

  private syncChef(
    world: World,
    player: Player,
    chef: ChefRig,
    alpha: number,
    dt: number,
    time: number,
  ): void {
    // A held seat is faded out, reusing the placement-ghost machinery. It has
    // to be visibly *not* a player standing idle, or the others will keep
    // waiting for them to do something. The name tag stays solid — knowing who
    // is missing is the point.
    if (player.away !== chef.wasAway) {
      chef.wasAway = player.away;
      setGhost(chef.root, player.away);
    }

    // Name tags only exist online, where there is a name to show. Offline
    // everyone is in the same room and floating labels are just clutter.
    if (player.name !== chef.tagName) {
      if (chef.tag) disposeSubtree(chef.tag);
      chef.tagName = player.name;
      chef.tag = player.name ? makeNameTag(player.name, this.colorOf(player.id)) : undefined;
      if (chef.tag) {
        chef.tag.position.y = 1.34;
        chef.root.add(chef.tag);
      }
    }

    const x = lerp(player.prevPos.x, player.pos.x, alpha);
    const z = lerp(player.prevPos.y, player.pos.y, alpha);
    chef.root.position.set(x, 0, z);
    chef.root.rotation.y = Math.atan2(player.facing.x, player.facing.y);

    const speed = strideSpeed(player.pos, player.prevPos, PLAYER_SPEED);
    chef.phase += dt * (6 + 8 * speed);
    const swing = Math.sin(chef.phase * 2) * speed;
    const carrying = player.carried !== null || player.carriedAppliance !== null;

    const station = player.workingOn !== null ? world.appliances.get(player.workingOn) : undefined;
    const motion = isChefMotion(station?.motion) ? station.motion : null;

    // Baseline pose, overwritten below by whichever pose is active. Every
    // channel a pose touches must be reset here, or it sticks once the pose
    // ends (a chef who kneaded once would lean forever).
    chef.body.position.y =
      0.28 + Math.abs(Math.sin(chef.phase * 2)) * 0.05 * speed + Math.sin(time * 2.2) * 0.008;
    chef.body.position.z = 0;
    chef.body.rotation.x = 0.16 * speed;
    chef.head.rotation.x = -0.1 * speed;

    if (motion && station) {
      poseWorking(chef, motion, workPhase(station.motion, station.id, time));
    } else if (carrying) {
      // Both hands out front, holding the item.
      chef.armL.rotation.x = -1.35 + swing * 0.12;
      chef.armR.rotation.x = -1.35 - swing * 0.12;
      chef.armL.rotation.z = 0.25;
      chef.armR.rotation.z = -0.25;
    } else {
      chef.armL.rotation.x = swing * 0.8;
      chef.armR.rotation.x = -swing * 0.8;
      chef.armL.rotation.z = 0.08;
      chef.armR.rotation.z = -0.08;
    }
    if (!motion) {
      chef.legL.rotation.x = -swing * 0.85;
      chef.legR.rotation.x = swing * 0.85;
    }

    // Squash-and-stretch pop whenever what they're holding changes.
    const carriedId = player.carried?.id ?? 0;
    if (carriedId !== chef.lastCarried) {
      chef.lastCarried = carriedId;
      chef.pop = 1;
    }
    chef.pop = Math.max(0, chef.pop - dt * 5);
    const pop = chef.pop * chef.pop;
    chef.body.scale.set(1 + 0.16 * pop, 1 - 0.2 * pop, 1 + 0.16 * pop);
  }

  /**
   * Customers use the chef rig and the chef walk cycle, with two states of
   * their own: **seated** (dropped onto the chair, knees forward, facing the
   * table) and **impatient** (a slump that deepens as the ring runs down).
   *
   * The slump is the point of putting people in the room at all. A ticket going
   * red is information; somebody sinking into their chair is the same
   * information, readable from the fryer without looking away from it.
   */
  syncCustomers(world: World, alpha: number, dt: number, time: number): void {
    for (const [id, rig] of this.customers) {
      if (world.customers.some((customer) => customer.id === id)) continue;
      disposeSubtree(rig.root);
      this.customers.delete(id);
    }

    for (const customer of world.customers) {
      let person = this.customers.get(customer.id);
      if (!person) {
        // Indexed by id so the same customer keeps the same coat all visit, and
        // two people arriving together rarely match. The kind chooses which
        // coats there are to match *within* — see `data/customers.ts`.
        const parts = buildCustomer(customer.kind, customer.id);
        this.scene.add(parts.root);
        person = { ...parts, phase: 0, slump: 0 };
        this.customers.set(customer.id, person);
      }
      this.syncCustomer(world, customer, person, alpha, dt, time);
    }
  }

  private syncCustomer(
    world: World,
    customer: Customer,
    person: CustomerRig,
    alpha: number,
    dt: number,
    time: number,
  ): void {
    let x = lerp(customer.prevPos.x, customer.pos.x, alpha);
    let z = lerp(customer.prevPos.y, customer.pos.y, alpha);
    // The simulation seats people on the tile beside the table, because tiles
    // are what it can reason about. The chair is half a tile in from there, so
    // the drawing pulls them onto it — sitting a foot away from your own chair
    // looks like a bug even when the rules are right.
    const table = customer.table === null ? undefined : world.appliances.get(customer.table);
    if (table && customer.state !== "arriving" && customer.state !== "leaving") {
      x += (table.tile.x + 0.5 - x) * 0.42;
      z += (table.tile.y + 0.5 - z) * 0.42;
    }
    person.root.position.set(x, 0, z);
    person.root.rotation.y = Math.atan2(customer.facing.x, customer.facing.y);

    // Against *their* top speed, not the average. Pace is a dial on the kind,
    // and a hurried diner measured against everyone else's speed would come out
    // over 1 and skate through the room with their legs at full swing.
    const speed = strideSpeed(customer.pos, customer.prevPos, customerSpeed(customer));
    person.phase += dt * (5 + 7 * speed);
    const swing = Math.sin(person.phase * 2) * speed;

    const seated =
      customer.state === "deciding" || customer.state === "ordering" || customer.state === "eating";

    // Impatience builds only while there is something to be impatient about.
    const impatient =
      customer.state === "ordering" ? 1 - Math.max(0, customer.remaining / customer.patience) : 0;
    person.slump += (impatient - person.slump) * ease(2, dt);
    const slump = person.slump * person.slump;

    // Seated is *higher* than standing, not lower: the hips land on the chair
    // rather than on the floor. Getting this backwards put every customer's
    // head level with the tabletop, where it read as a lump behind the plate
    // instead of as a person waiting for it.
    person.body.position.y =
      (seated ? SEAT_HEIGHT : 0.28) + Math.abs(Math.sin(person.phase * 2)) * 0.05 * speed;
    person.body.position.z = 0;
    person.body.rotation.x = 0.14 * speed + slump * 0.34;
    person.head.rotation.x = -0.08 * speed + slump * 0.3;
    // Only the eating pose squashes the head; everything else must put it back,
    // or one meal would leave a customer dented for the rest of the day.
    person.head.scale.set(1, 1, 1);

    if (customer.state === "eating") {
      poseEating(person, customer.id, time);
    } else if (seated) {
      // Knees up, hands resting on the table edge, sinking as patience goes.
      person.legL.rotation.x = -1.35;
      person.legR.rotation.x = -1.35;
      person.armL.rotation.x = -0.9 + slump * 0.5;
      person.armR.rotation.x = -0.9 + slump * 0.5;
      person.armL.rotation.z = 0.2;
      person.armR.rotation.z = -0.2;
      // A restless glance around the room, faster the longer they have waited.
      person.head.rotation.y =
        Math.sin(time * (0.7 + slump * 1.6) + customer.id) * 0.24 * (0.3 + slump);
    } else {
      person.legL.rotation.x = -swing * 0.85;
      person.legR.rotation.x = swing * 0.85;
      person.armL.rotation.x = swing * 0.8;
      person.armR.rotation.x = -swing * 0.8;
      person.armL.rotation.z = 0.08;
      person.armR.rotation.z = -0.08;
      person.head.rotation.y = 0;
    }
  }

  dispose(): void {
    for (const chef of this.chefs.values()) disposeSubtree(chef.root);
    for (const person of this.customers.values()) disposeSubtree(person.root);
    this.chefs.clear();
    this.customers.clear();
    this.colors.clear();
  }
}

/** 0..1 fraction of top speed, from how far the sim moved them this tick. */
function strideSpeed(
  pos: { x: number; y: number },
  prev: { x: number; y: number },
  topSpeed: number,
): number {
  const moved = Math.hypot(pos.x - prev.x, pos.y - prev.y);
  return Math.min(1, moved / (topSpeed * DT));
}

/**
 * Working poses. Each motion has its own rhythm and shape so a glance tells you
 * what a chef is doing, even off-screen-edge or behind a counter.
 */
function poseWorking(chef: ChefParts, motion: ChefMotion, phase: number): void {
  switch (motion) {
    case "chop": {
      // Both hands on the knife: raise high, slam down, recoil.
      const lift = chopLift(phase);
      const hit = chopImpact(phase);
      chef.armL.rotation.x = -0.7 - lift * 1.75;
      chef.armR.rotation.x = chef.armL.rotation.x;
      // Elbows flare wide on the way up. Anatomically it lets go of the knife,
      // but a chef working a counter to the north faces away from a fixed
      // camera, and arms held together vanish behind their own torso. Swinging
      // them clear of the silhouette is what makes the chop read.
      chef.armL.rotation.z = 0.3 - lift * 0.55;
      chef.armR.rotation.z = -chef.armL.rotation.z;
      // Rock back with the lift, punch forward into the strike.
      chef.body.rotation.x = 0.24 - lift * 0.13 + hit * 0.18;
      chef.body.position.y -= hit * 0.035;
      chef.head.rotation.x = 0.1 + hit * 0.14;
      chef.legL.rotation.x = 0;
      chef.legR.rotation.x = 0;
      break;
    }
    case "knead": {
      // Slower, heavier: lean in and push down with the whole body.
      const push = Math.sin(phase);
      chef.armL.rotation.x = -1.25 - push * 0.25;
      chef.armR.rotation.x = chef.armL.rotation.x;
      chef.armL.rotation.z = 0.16;
      chef.armR.rotation.z = -0.16;
      chef.body.rotation.x = 0.3 + push * 0.14;
      chef.body.position.z = push * 0.05;
      chef.head.rotation.x = 0.2;
      chef.legL.rotation.x = 0;
      chef.legR.rotation.x = 0;
      break;
    }
    case "scrub": {
      // Hands down in the basin, working in small circles half a beat apart.
      // Deliberately the calmest of the four: the sink is where a chef catches
      // their breath, and a frantic pose would say the opposite.
      const circle = Math.sin(phase);
      chef.armL.rotation.x = -1.05 + circle * 0.16;
      chef.armR.rotation.x = -1.05 + Math.cos(phase) * 0.16;
      chef.armL.rotation.z = 0.26 + Math.cos(phase) * 0.12;
      chef.armR.rotation.z = -0.26 + circle * 0.12;
      chef.body.rotation.x = 0.26;
      chef.head.rotation.x = 0.22;
      chef.legL.rotation.x = 0;
      chef.legR.rotation.x = 0;
      break;
    }
    case "mix": {
      chef.armL.rotation.x = -1.3 + Math.sin(phase) * 0.28;
      chef.armR.rotation.x = -1.3 + Math.sin(phase + Math.PI) * 0.28;
      chef.armL.rotation.z = 0.2 + Math.cos(phase) * 0.25;
      chef.armR.rotation.z = -0.2 + Math.cos(phase) * 0.25;
      chef.body.rotation.x = 0.22;
      chef.head.rotation.x = 0.14;
      chef.legL.rotation.x = 0;
      chef.legR.rotation.x = 0;
      break;
    }
    default: {
      const unreachable: never = motion;
      throw new Error(`unhandled chef motion: ${String(unreachable)}`);
    }
  }
}

/**
 * Eating: a bob, not a mime.
 *
 * Dwell time is a throughput constraint — a table is occupied for as long as
 * somebody is sitting at it — so "still eating" has to be legible from the
 * other side of the kitchen, and legible as *progress* rather than as an idle.
 *
 * An earlier version raised a fork to the mouth on a proper bite cycle, and
 * almost none of it survived the trip to the screen: a customer faces their
 * table, which from a fixed camera means facing away, so the entire performance
 * happened behind their own back. What does read at this size is the head — it
 * is the biggest thing on them and the only part clear of the tabletop.
 *
 * `abs(sin)` rather than a sine: the bounce off the bottom is what makes it
 * munching rather than nodding.
 */
function poseEating(person: ChefParts, id: number, time: number): void {
  const munch = Math.abs(Math.sin(time * MUNCH_RATE + id));

  person.legL.rotation.x = -1.35;
  person.legR.rotation.x = -1.35;

  person.body.rotation.x = 0.16 + munch * 0.06;
  person.body.position.y = SEAT_HEIGHT - munch * 0.014;
  person.head.rotation.x = 0.08 + munch * 0.34;
  person.head.rotation.y = 0;
  // A little squash on the way down. Cartoon licence, and it is what stops the
  // bob reading as a stiff hinge.
  person.head.scale.set(1 + munch * 0.07, 1 - munch * 0.09, 1 + munch * 0.07);

  // Both hands stay on the table, out of the way of the one part that reads.
  person.armL.rotation.x = -0.95;
  person.armR.rotation.x = -0.95;
  person.armL.rotation.z = 0.22;
  person.armR.rotation.z = -0.22;
}
