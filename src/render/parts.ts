import * as THREE from "three";
import { PALETTE, type SurfaceName } from "./palette";
import { capsule, mesh, roundedBox, roundedCylinder, sweep, torus } from "./primitives";

/**
 * Parts more than one thing in the kitchen is made of.
 *
 * The appliance builders had drifted into forty lines each of bespoke
 * ironmongery, and the drift showed: the oven's handles were rotated cylinders,
 * the fryer's was a bare stick at 0.4 radians, the bin's rim was a torus laid
 * flat by hand and the plate stack's was the same three lines with different
 * numbers. Nothing was *wrong*; they were simply five people's answers to one
 * question, on one screen, at one time.
 *
 * A part in here has to earn it by having at least two call sites. That is the
 * whole point: fidelity compounds when improving the handle improves the oven,
 * the fryer and whatever gets a handle next, and consistency stops depending on
 * whoever wrote each object remembering what the last one did.
 */

/**
 * The four faces of a tile-aligned box, as the direction each one faces.
 *
 * The camera looks from any of four corners, so an appliance that details only
 * its front is an appliance that is blank half the time — the reason the oven
 * has a door on all four sides. Three builders had written this table out with
 * their own literals in it.
 */
export const SIDES: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
];

/** The turn that points a part built facing `+z` the same way as a side. */
export function facing(x: number, z: number): number {
  return Math.atan2(x, z);
}

/**
 * A ring lying flat: the finish every open top in the kitchen wants.
 *
 * A bin, a basket and a stack of plates all end in a circle, and an unfinished
 * circle reads as a hole cut in a solid rather than as a container with a wall.
 */
export function rim(
  radius: number,
  tube: number,
  color: number = PALETTE.steelDark,
  surface: SurfaceName = "metal",
): THREE.Mesh {
  const ring = mesh(torus(radius, tube), color, surface);
  ring.rotation.x = Math.PI / 2;
  return ring;
}

/**
 * A D-handle: a bar standing off the face it is bolted to, in one swept tube.
 *
 * Spans `x`, stands off in `+z`, and its roots sit at `z = 0` so it can be
 * placed on the face of a door and rotated with it. The corners are radiused by
 * the spline, which is the difference between a handle and a length of pipe.
 */
export function dHandle(
  span: number,
  stand = 0.06,
  radius = 0.022,
  color: number = PALETTE.brass,
  surface: SurfaceName = "metal",
): THREE.Mesh {
  const half = span / 2;
  return mesh(
    sweep(
      `handle:${span},${stand},${radius}`,
      [
        [-half, 0, 0],
        [-half, 0, stand],
        [half, 0, stand],
        [half, 0, 0],
      ],
      radius,
      18,
      8,
    ),
    color,
    surface,
  );
}

/**
 * How high a body sits above the floor it stands on.
 *
 * Nothing in the kitchen used to stand on anything: every appliance was a box
 * whose bottom face was the tile, so the room read as extruded floor rather
 * than as furniture standing in a room. A toe-kick is the smallest change that
 * fixes it for everything at once — it puts a line of shadow under every body,
 * and a shadow under a thing is most of what says the thing is on top of the
 * floor rather than part of it.
 *
 * Small on purpose: 9cm at kitchen scale. Any more and appliances read as
 * standing on stilts from the low 3/4 camera.
 */
export const TOE_KICK = 0.09;

/** How far in the plinth is set from the body above it. */
const PLINTH_INSET = 0.07;

/**
 * The recessed base a body stands on, plus the two feet that carry it.
 *
 * Inset rather than flush, because a flush base is just the bottom of the box
 * again: it is the *overhang* that catches shadow and reads as a plinth.
 */
export function plinth(width: number, height = TOE_KICK): THREE.Object3D {
  const group = new THREE.Group();
  const inner = width - PLINTH_INSET * 2;

  const base = mesh(roundedBox(inner, height, inner, 0.02), PALETTE.plinth, "paintedMetal");
  base.position.y = height / 2;
  group.add(base);

  // Adjustable feet, the detail that names the thing: catering equipment stands
  // on four of these, and they are the reason the plinth is off the floor at all.
  for (const [x, z] of CORNERS) {
    const foot = mesh(roundedCylinder(0.035, height * 0.5, 0.012, 12), PALETTE.steelDark, "metal");
    foot.position.set(x * (inner / 2 - 0.06), 0, z * (inner / 2 - 0.06));
    group.add(foot);
  }
  return group;
}

/** The four corners of a square, for legs, feet and stiles. */
export const CORNERS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/**
 * A grip: the part of a handle a hand actually closes around, drawn as the
 * thicker, softer thing it is. Lies along `x`.
 */
export function grip(
  length: number,
  radius = 0.035,
  color: number = PALETTE.crateTrim,
): THREE.Mesh {
  const bar = mesh(capsule(radius, length), color, "wood");
  bar.rotation.z = Math.PI / 2;
  return bar;
}
