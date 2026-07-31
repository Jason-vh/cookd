import * as THREE from "three";
import { PALETTE, shade, type SurfaceName } from "./palette";
import { capsule, extruded, mesh, roundedBox, roundedCylinder, sweep, torus } from "./primitives";

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
 * A deck with a hole in it: the top of anything defined by its recess.
 *
 * A sink and a fryer are the same object twice — a worktop with a mouth cut in
 * it and a well hanging underneath — and both used to be drawn as a solid slab
 * with a basin *sitting on* it, which is the one shape neither of them has. The
 * frame is a single pierced extrusion, so the bevel runs round the mouth as it
 * runs round the outside, and the eye reads a real edge going down.
 *
 * Sized like a worktop: it overhangs the body by the same 2cm.
 */
export function deck(
  width: number,
  mouth: number,
  color: number,
  surface: SurfaceName = "enamel",
): THREE.Mesh {
  const face = mesh(
    extruded(
      `deck:${width},${mouth}`,
      (shape) => {
        roundedRect(shape, width, width, 0.05);
        const hole = new THREE.Path();
        roundedRect(hole, mouth, mouth, 0.05);
        shape.holes.push(hole);
      },
      0.06,
      0.014,
    ),
    color,
    surface,
  );
  face.rotation.x = -Math.PI / 2;
  return face;
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
 * 12cm at kitchen scale. The first attempt was 9cm and inset 7cm, which is what
 * a real kitchen does and what this camera cannot see: from up here the near
 * face is foreshortened, so a deep, short recess disappears into the contact
 * shadow it was supposed to be distinct from. Taller and shallower is the shape
 * that survives the projection.
 */
export const TOE_KICK = 0.12;

/** How far in the plinth is set from the body above it. */
const PLINTH_INSET = 0.05;

/**
 * The recessed base a body stands on, plus the two feet that carry it.
 *
 * Inset rather than flush, because a flush base is just the bottom of the box
 * again: it is the *overhang* that catches shadow and reads as a plinth.
 */
export function plinth(width: number, color: number, height = TOE_KICK): THREE.Object3D {
  const group = new THREE.Group();
  const inner = width - PLINTH_INSET * 2;

  // The body's own colour in shadow, rather than one grey for every appliance:
  // a plinth is part of the furniture standing on it, not a hole under it.
  const base = mesh(roundedBox(inner, height, inner, 0.02), shade(color, 0.62), "paintedMetal");
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

/**
 * A rounded rectangle, drawn into a shape or a hole, centred on the origin.
 *
 * The outline most flat things in a kitchen actually have — boards, trays,
 * hatch frames, the deck of a fryer — and the one `extruded` needs to be given,
 * because a `Shape` has no rounded-rect of its own.
 */
export function roundedRect(path: THREE.Path, width: number, depth: number, radius: number): void {
  const r = Math.min(radius, Math.min(width, depth) / 2);
  const x = width / 2 - r;
  const z = depth / 2 - r;
  path.moveTo(-x, -depth / 2);
  path.lineTo(x, -depth / 2);
  path.absarc(x, -z, r, -Math.PI / 2, 0, false);
  path.lineTo(width / 2, z);
  path.absarc(x, z, r, 0, Math.PI / 2, false);
  path.lineTo(-x, depth / 2);
  path.absarc(-x, z, r, Math.PI / 2, Math.PI, false);
  path.lineTo(-width / 2, -z);
  path.absarc(-x, -z, r, Math.PI, Math.PI * 1.5, false);
}

/** The four corners of a square, for legs, feet and stiles. */
export const CORNERS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/**
 * A cabinet face on all four sides: a door panel, and the handle to open it.
 *
 * Counters are the most numerous object in any kitchen and were the emptiest:
 * a plain box with a worktop on it, repeated eight times down a wall. A door is
 * the smallest thing that turns a box into a cupboard, and unlike detailing
 * bolted to the top it survives being seen from across the room — the panel's
 * reveal catches a shadow on every face, at every camera corner.
 *
 * Panels are the body's colour half a step darker, not a colour of their own.
 */
export function cabinetFace(
  group: THREE.Object3D,
  width: number,
  bodyHeight: number,
  floor: number,
  color: number,
  surface: SurfaceName,
): void {
  const panelW = width * 0.76;
  const panelH = bodyHeight * 0.66;
  const centre = floor + bodyHeight * 0.5;
  const face = width / 2 - 0.005;

  for (const [x, z] of SIDES) {
    const panel = mesh(roundedBox(panelW, panelH, 0.045, 0.02), shade(color, 0.9), surface);
    panel.position.set(x * face, centre, z * face);
    panel.rotation.y = facing(x, z);
    group.add(panel);

    const handle = dHandle(panelW * 0.44, 0.045, 0.016, PALETTE.steelDark);
    handle.position.set(x * (face + 0.018), centre + panelH * 0.5 - 0.07, z * (face + 0.018));
    handle.rotation.y = facing(x, z);
    group.add(handle);
  }
}

/**
 * A grip: the part of a handle a hand actually closes around, drawn as the
 * thicker, softer thing it is. Lies along `x`.
 */
export function grip(length: number, radius = 0.035, color: number = PALETTE.woodDark): THREE.Mesh {
  const bar = mesh(capsule(radius, length), color, "wood");
  bar.rotation.z = Math.PI / 2;
  return bar;
}
