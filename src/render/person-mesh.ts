import * as THREE from "three";
import { customerKind } from "../data/customers";
import { PALETTE } from "./palette";
import { cylinder, mesh, roundedBox, sphere } from "./primitives";

/**
 * One rig, two costumes.
 *
 * A customer is a chef with different clothes and no hat — which is why
 * `people-views.ts` can animate both from one set of poses.
 */

// --- chefs -------------------------------------------------------------------

export type ChefParts = {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  carry: THREE.Group;
};

/**
 * The chef is deliberately simple geometry with clear articulation points:
 * the walk cycle and lean in `view.ts` do far more for the look than any extra
 * polygons would.
 */
export function buildChef(index: number): ChefParts {
  const color = PALETTE.chefs[index % PALETTE.chefs.length]!;
  return buildPerson(color, "chef");
}

/**
 * A customer: the same articulated figure as a chef, minus the uniform.
 *
 * Sharing the rig is what makes them read as the same kind of creature in the
 * same world, and it means the walk cycle, the lean and the squash all work on
 * them for free. The toque and the apron are what say "staff", so those are the
 * only things a customer loses — at a glance across the room, who works here is
 * never in question.
 *
 * What they *are* comes out of `data/customers.ts`: the coat, the hair and the
 * build are the whole of how a kind announces itself, alongside the speed it
 * walks at. The index is the customer's id, so a crowd of regulars is a crowd
 * of different coats and one visit is one coat.
 */
export function buildCustomer(kindId: string, index: number): ChefParts {
  const kind = customerKind(kindId);
  const color = kind.coats[index % kind.coats.length]!;
  const parts = buildPerson(color, "customer", kind.hair);
  parts.root.scale.multiplyScalar(kind.build);
  return parts;
}

function eye(x: number): THREE.Mesh {
  const ball = mesh(sphere(0.028), PALETTE.eye, "ceramic");
  ball.position.set(x, 0.04, 0.14);
  return ball;
}

function buildPerson(color: number, role: "chef" | "customer", hairColor?: number): ChefParts {
  const root = new THREE.Group();
  // Chefs are drawn slightly larger than life against the kitchen: readability
  // of who is where beats strict scale accuracy (Overcooked does the same).
  root.scale.setScalar(role === "chef" ? 1.12 : 1.06);

  const body = new THREE.Group();
  body.position.y = 0.28;
  root.add(body);

  const torso = mesh(roundedBox(0.42, 0.4, 0.32, 0.13), color, "cloth");
  torso.position.y = 0.2;
  body.add(torso);

  if (role === "chef") {
    // Apron: a lighter panel on the chest so the chef has a clear front.
    const apron = mesh(roundedBox(0.26, 0.3, 0.06, 0.04), PALETTE.chefWhites, "cloth");
    apron.position.set(0, 0.17, 0.15);
    body.add(apron);
  }

  const head = new THREE.Group();
  head.position.y = 0.46;
  body.add(head);

  const skull = mesh(sphere(0.16), PALETTE.skin, "cloth");
  skull.scale.set(1, 0.96, 0.94);
  head.add(skull);

  if (role === "chef") {
    const hatBrim = mesh(cylinder(0.155, 0.155, 0.08), PALETTE.chefWhites, "cloth");
    hatBrim.position.y = 0.14;
    head.add(hatBrim);
    const hatPuff = mesh(sphere(0.15), PALETTE.chefWhites, "cloth");
    hatPuff.scale.set(1, 0.85, 1);
    hatPuff.position.y = 0.24;
    head.add(hatPuff);
  } else {
    const hair = mesh(sphere(0.155), hairColor ?? PALETTE.hair, "cloth");
    hair.scale.set(1.03, 0.72, 1.0);
    hair.position.y = 0.06;
    head.add(hair);
  }

  const nose = mesh(sphere(0.035), PALETTE.skin, "cloth");
  nose.position.set(0, -0.01, 0.15);
  head.add(nose);

  head.add(eye(-0.06), eye(0.06));

  const makeArm = (x: number): THREE.Object3D => {
    // Pivot at the shoulder so rotation swings the whole arm.
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.32, 0);
    const limb = mesh(roundedBox(0.1, 0.26, 0.1, 0.045), color, "cloth");
    limb.position.y = -0.11;
    const hand = mesh(sphere(0.062), PALETTE.skin, "cloth");
    hand.position.y = -0.24;
    pivot.add(limb, hand);
    body.add(pivot);
    return pivot;
  };

  const makeLeg = (x: number): THREE.Object3D => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.02, 0);
    const trousers = role === "chef" ? PALETTE.chefWhites : PALETTE.customerLegs;
    const limb = mesh(roundedBox(0.12, 0.2, 0.12, 0.05), trousers, "cloth");
    limb.position.y = -0.1;
    const shoe = mesh(roundedBox(0.14, 0.08, 0.19, 0.035), 0x3a3d47, "cloth");
    shoe.position.set(0, -0.2, 0.03);
    pivot.add(limb, shoe);
    body.add(pivot);
    return pivot;
  };

  const carry = new THREE.Group();
  carry.position.set(0, 0.34, 0.34);
  body.add(carry);

  return {
    root,
    body,
    head,
    armL: makeArm(-0.25),
    armR: makeArm(0.25),
    legL: makeLeg(-0.1),
    legR: makeLeg(0.1),
    carry,
  };
}
