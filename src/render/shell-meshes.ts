import * as THREE from "three";
import { PALETTE } from "./palette";
import { mesh, roundedBox, tonedMesh } from "./primitives";
import { canvas2d, cssHex } from "./text";

/**
 * The kitchen's own fabric: its walls, the doorway customers arrive through,
 * and the floor they all stand on.
 *
 * `floorTexture` used to live 280 lines away from `buildWall`, under a
 * "generated textures" heading, despite having the same single consumer and the
 * same subject. It belongs here.
 */

// --- walls -------------------------------------------------------------------

/**
 * How thick a wall is, in tiles.
 *
 * A wall used to be a whole square, which made a dividing wall as wide as the
 * counters either side of it and cost the kitchen a ring of floor it never got
 * to use. They stand on the **seams between tiles** now, so this is the only
 * place the thickness is decided — wide enough to read as masonry at this
 * camera angle, and narrow enough that the room it divides is still one room.
 */
export const WALL_THICKNESS = 0.18;

/**
 * One seam's worth of wall, centred on the line and running the length of a
 * tile.
 *
 * Built a little **longer** than the tile it spans, by its own thickness, so
 * that two runs meeting at a corner overlap instead of leaving a notch. They
 * are merged into one mesh per material on the way into the scene, so the
 * overlap costs nothing and a mitre would cost geometry nobody can see.
 */
export function buildWall(height: number, axis: "vertical" | "horizontal"): THREE.Object3D {
  const group = new THREE.Group();
  // Low near-side lips are mostly top face, so they catch a lot of sun. A
  // darker paint keeps them from becoming the brightest band in the frame.
  const color = height < 0.5 ? PALETTE.wallLow : PALETTE.wall;
  const long = 1 + WALL_THICKNESS;
  const [w, d] = axis === "vertical" ? [WALL_THICKNESS, long] : [long, WALL_THICKNESS];
  // Toned: a two-metre wall of one flat value is the largest plastic surface on
  // screen. Gentle — the fall is the sky above and the floor below, not dirt.
  const body = tonedMesh(roundedBox(w, height, d, 0.04), color, "plaster", 0.88);
  body.position.y = height / 2;
  group.add(body);
  if (height > 0.6) {
    const trim = mesh(roundedBox(w + 0.05, 0.09, d + 0.05, 0.03), PALETTE.wallTrim, "plaster");
    trim.position.y = height;
    group.add(trim);
  }
  return group;
}

/**
 * The way in: two jambs and a lintel across the seam a wall is missing from.
 *
 * Scenery around a hole rather than a wall with a hole in it — nothing here is
 * collided with, because there is simply no wall on that seam, so customers
 * stream through the middle of it and the paving outside leads straight to it.
 *
 * Built for a wall running north–south; a doorway in the other axis is this,
 * turned a quarter.
 */
export function buildDoorway(): THREE.Object3D {
  const group = new THREE.Group();
  const height = 1.1;
  const depth = WALL_THICKNESS;
  for (const z of [-0.42, 0.42]) {
    const post = mesh(roundedBox(depth, height, 0.16, 0.04), PALETTE.wall, "plaster");
    post.position.set(0, height / 2, z);
    group.add(post);
  }
  const lintel = mesh(roundedBox(depth + 0.05, 0.14, 1 + depth, 0.04), PALETTE.wallTrim, "plaster");
  lintel.position.y = height + 0.07;
  group.add(lintel);
  return group;
}

/**
 * The frame around a drive-through's serving hatch.
 *
 * The same two posts the doorway has, and then everything that says *this is
 * not a door*: a lintel low enough to lean under, and a canopy over the lane
 * outside. The gap in the wall is full height as far as the simulation is
 * concerned — a seam is open or it is not — so the whole job of saying how big
 * the opening really is falls to this.
 *
 * `out` is which way the lane is, in the frame's own axes: +1 or -1 along local
 * x, because the caller is the only thing that knows which side of the building
 * this wall is on.
 */
export function buildServingHatch(out: number): THREE.Object3D {
  const group = new THREE.Group();
  const height = 0.95;
  const depth = WALL_THICKNESS;
  for (const z of [-0.46, 0.46]) {
    const post = mesh(roundedBox(depth, 1.1, 0.12, 0.04), PALETTE.wall, "plaster");
    post.position.set(0, 0.55, z);
    group.add(post);
  }

  const lintel = mesh(roundedBox(depth + 0.05, 0.18, 1 + depth, 0.04), PALETTE.wallTrim, "plaster");
  lintel.position.y = height + 0.09;
  group.add(lintel);

  // A canopy over whoever is being served. It is also what makes the hatch
  // findable from the far side of the building, which matters in the one room
  // where the thing you are serving is outside the walls.
  const canopy = mesh(roundedBox(0.42, 0.07, 1.15, 0.03), PALETTE.awning, "enamel");
  canopy.position.set(out * 0.3, height + 0.24, 0);
  canopy.rotation.z = out * 0.16;
  group.add(canopy);

  const bracket = mesh(roundedBox(0.24, 0.06, 0.06, 0.02), PALETTE.wallTrim, "plaster");
  bracket.position.set(out * 0.14, height + 0.18, 0);
  group.add(bracket);

  return group;
}

/** Warm tiled kitchen floor with grout lines and a touch of per-tile variation. */
export function floorTexture(width: number, height: number): THREE.Texture {
  const [element, ctx] = canvas2d(128);
  ctx.fillStyle = cssHex(PALETTE.floorGrout);
  ctx.fillRect(0, 0, 128, 128);
  const shades = [PALETTE.floorLight, PALETTE.floorDark];
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      ctx.fillStyle = cssHex(shades[(x + y) % 2]!);
      ctx.fillRect(x * 64 + 3, y * 64 + 3, 58, 58);
    }
  }
  ctx.globalAlpha = 0.05;
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = i % 2 ? "#ffffff" : "#000000";
    ctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
  }
  const texture = new THREE.CanvasTexture(element);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(width / 2, height / 2);
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
