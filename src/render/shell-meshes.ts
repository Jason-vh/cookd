import * as THREE from "three";
import { PALETTE } from "./palette";
import { mesh, roundedBox } from "./primitives";
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

export function buildWall(height: number): THREE.Object3D {
  const group = new THREE.Group();
  // Low near-side lips are mostly top face, so they catch a lot of sun. A
  // darker paint keeps them from becoming the brightest band in the frame.
  const color = height < 0.5 ? PALETTE.wallLow : PALETTE.wall;
  const body = mesh(roundedBox(1, height, 1, 0.05), color, "enamel");
  body.position.y = height / 2;
  group.add(body);
  if (height > 0.6) {
    const trim = mesh(roundedBox(1.04, 0.09, 1.04, 0.03), PALETTE.wallTrim, "enamel");
    trim.position.y = height;
    group.add(trim);
  }
  return group;
}

/**
 * The way in: two posts and a lintel where a wall tile would otherwise be.
 *
 * The tile itself stays walkable — this is scenery around a hole, not a wall
 * with a hole in it — so customers stream through the middle of it and the
 * paving outside leads straight to it.
 */
export function buildDoorway(): THREE.Object3D {
  const group = new THREE.Group();
  // Flush with the wall it interrupts, so it reads as a gate in a wall rather
  // than a structure standing next to one.
  const height = 1.1;
  for (const z of [-0.42, 0.42]) {
    const post = mesh(roundedBox(1, height, 0.16, 0.04), PALETTE.wall, "enamel");
    post.position.set(0, height / 2, z);
    group.add(post);
  }
  const lintel = mesh(roundedBox(1.04, 0.14, 1.04, 0.04), PALETTE.wallTrim, "enamel");
  lintel.position.y = height + 0.07;
  group.add(lintel);
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
