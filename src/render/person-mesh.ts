import * as THREE from "three";
import {
  chefHat,
  chefOutfit,
  DEFAULT_APPEARANCE,
  type Appearance,
  type HatId,
} from "../data/chefs";
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
 *
 * What is *chosen* about them — the outfit colour and the hat — arrives as ids
 * from `data/chefs.ts`, resolved here so an id this bundle has never heard of
 * still produces a chef rather than an exception.
 */
export function buildChef(look: Appearance = DEFAULT_APPEARANCE): ChefParts {
  return buildPerson(chefOutfit(look.outfit).color, "chef", undefined, chefHat(look.hat).id);
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

/**
 * The hat, in chef's whites like the apron.
 *
 * Shape is the whole customisation here, and the colour deliberately is not:
 * white on the head and white on the chest is what says *staff* across a busy
 * dining room, and a chef in a coloured hat would be one more person sitting
 * down. The four are silhouettes rather than details, because at this size and
 * this camera angle a silhouette is all that survives.
 */
function buildHat(hat: HatId): THREE.Object3D {
  const group = new THREE.Group();
  const white = PALETTE.chefWhites;

  switch (hat) {
    case "toque": {
      const brim = mesh(cylinder(0.155, 0.155, 0.08), white, "cloth");
      brim.position.y = 0.14;
      const puff = mesh(sphere(0.15), white, "cloth");
      puff.scale.set(1, 0.85, 1);
      puff.position.y = 0.24;
      group.add(brim, puff);
      break;
    }
    case "cap": {
      const dome = mesh(sphere(0.163), white, "cloth");
      dome.scale.set(1, 0.62, 1);
      dome.position.y = 0.08;
      // The peak is what tells a cap from a beanie from behind a counter, so it
      // is drawn long enough to break the silhouette.
      const peak = mesh(roundedBox(0.2, 0.03, 0.14, 0.014), white, "cloth");
      peak.position.set(0, 0.06, 0.15);
      peak.rotation.x = -0.12;
      group.add(dome, peak);
      break;
    }
    case "bandana": {
      const wrap = mesh(sphere(0.162), white, "cloth");
      wrap.scale.set(1, 0.5, 1);
      wrap.position.y = 0.07;
      const knot = mesh(sphere(0.05), white, "cloth");
      knot.position.set(0, 0.06, -0.15);
      const tail = mesh(roundedBox(0.05, 0.03, 0.13, 0.014), white, "cloth");
      tail.position.set(0, 0.02, -0.21);
      tail.rotation.x = 0.3;
      group.add(wrap, knot, tail);
      break;
    }
    case "beanie": {
      const dome = mesh(sphere(0.161), white, "cloth");
      dome.scale.set(1, 0.78, 1);
      dome.position.y = 0.06;
      const fold = mesh(cylinder(0.166, 0.166, 0.06), white, "cloth");
      fold.position.y = 0.06;
      const bobble = mesh(sphere(0.045), white, "cloth");
      bobble.position.y = 0.21;
      group.add(dome, fold, bobble);
      break;
    }
    default: {
      const unreachable: never = hat;
      throw new Error(`unhandled hat: ${String(unreachable)}`);
    }
  }
  return group;
}

function buildPerson(
  color: number,
  role: "chef" | "customer",
  hairColor?: number,
  hat: HatId = "toque",
): ChefParts {
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
    head.add(buildHat(hat));
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
