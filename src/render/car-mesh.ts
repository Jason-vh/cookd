import * as THREE from "three";
import { customerKind } from "../data/customers";
import { PALETTE } from "./palette";
import { cylinder, mesh, roundedBox, sphere } from "./primitives";

/**
 * A car: what a customer at a drive-through arrives in.
 *
 * The one thing in the game that is a vehicle, and it is built to the same rule
 * as everything else — primitive shapes, no textures, read from across the
 * room. It is also built to the *dining room's* rule about who walks in:
 * **a kind announces itself**, so the paintwork comes out of the coats in
 * `data/customers.ts` rather than out of this file. Somebody in a hurry arrives
 * in the same dark grey they wear, and the critic's car is the one you can
 * spot from the fryer.
 *
 * Nobody is drawn inside it. A driver would be a person at chest height behind
 * a windscreen at a fixed camera angle — invisible from three of the four ways
 * the kitchen can be turned — and the bubble over the roof already says
 * everything about them the kitchen needs.
 *
 * Forward is `+Z`, as it is for a chef, so the rig can be pointed with the same
 * `atan2(facing.x, facing.y)` the people use.
 */

export type CarParts = {
  root: THREE.Group;
  /** The shell, so it can lean under braking and settle when it stops. */
  body: THREE.Group;
  /** Spun by distance covered — the one piece of animation a car needs. */
  wheels: THREE.Object3D[];
};

const LENGTH = 1.06;
const WIDTH = 0.74;

export function buildCar(kindId: string, index: number): CarParts {
  const kind = customerKind(kindId);
  const paint = kind.coats[index % kind.coats.length]!;

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const hull = mesh(roundedBox(WIDTH, 0.32, LENGTH, 0.12), paint, "enamel");
  hull.position.y = 0.3;
  body.add(hull);

  // A cabin set back from the nose is what makes a box read as a car rather
  // than as a crate on wheels.
  const cabin = mesh(roundedBox(WIDTH * 0.82, 0.26, LENGTH * 0.5, 0.1), paint, "enamel");
  cabin.position.set(0, 0.56, -0.06);
  body.add(cabin);

  const glass = mesh(
    roundedBox(WIDTH * 0.86, 0.16, LENGTH * 0.44, 0.06),
    PALETTE.carGlass,
    "metal",
  );
  glass.position.set(0, 0.58, -0.06);
  body.add(glass);

  for (const x of [-1, 1]) {
    const light = mesh(sphere(0.06, 10), PALETTE.carLight, "ceramic");
    light.position.set(x * WIDTH * 0.3, 0.34, LENGTH * 0.47);
    body.add(light);
  }

  const wheels: THREE.Object3D[] = [];
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) {
      const wheel = new THREE.Group();
      const tyre = mesh(cylinder(0.17, 0.17, 0.13, 14), PALETTE.carTyre, "enamel");
      tyre.rotation.z = Math.PI / 2;
      wheel.add(tyre);
      // A pale hub is what makes the spin visible at all: a black cylinder
      // turning about its own axis is a black cylinder standing still.
      const hub = mesh(cylinder(0.075, 0.075, 0.145, 10), PALETTE.carHub, "metal");
      hub.rotation.z = Math.PI / 2;
      wheel.add(hub);
      wheel.position.set(x * WIDTH * 0.52, 0.17, z * LENGTH * 0.3);
      wheels.push(wheel);
      root.add(wheel);
    }
  }

  return { root, body, wheels };
}
