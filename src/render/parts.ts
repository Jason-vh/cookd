import * as THREE from "three";
import { PALETTE, type SurfaceName } from "./palette";
import { capsule, mesh, sweep, torus } from "./primitives";

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
