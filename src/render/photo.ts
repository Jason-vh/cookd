import * as THREE from "three";
import type { Item } from "../sim/types";
import { disposeSubtree } from "./dispose";
import { buildItemModel } from "./models";
import { PALETTE } from "./palette";

/**
 * A photograph of a dish: the miniature, shot once, kept as a texture.
 *
 * The recipe card used to carry the dish as a **model** — a real plate of food
 * at half scale, lit by the same sun as the oven, pinned proud of the paper. It
 * never read as a picture, because it was not one. It was food glued to a card.
 *
 * So a dish is photographed. The whole art direction is a *photographed
 * miniature*; a menu card in that world holds a photograph of the same
 * miniature, taken in the same room. One offscreen render per dish, cached by
 * what it is a picture of, and from then on it is an image like any other.
 *
 * ## Why it is a studio and not the kitchen's own camera
 *
 * A photograph has its own framing, and it must not change. Shot down the
 * kitchen's 3/4 angle so the food is seen the way the player sees it, but with
 * its own light and its own square frame, so a card looks the same at dawn as
 * it does at dusk — a printed card whose picture changed with the weather would
 * be a very strange object.
 *
 * The light is deliberately flatter and brighter than the kitchen's: this is a
 * product shot, and the shadow that makes an oven feel like it is resting on
 * the floor is, on a photograph, just a dark corner.
 *
 * ## The renderer arrives late
 *
 * `appliance-meshes.ts` is a pure mesh builder — it has no renderer, and giving
 * it one would make every appliance in the game depend on the thing that draws
 * them. So the studio is opened by whoever owns the renderer (`view.ts`, and
 * the gallery), and anything that asks before that gets `null` and falls back
 * to the model. That fallback is not a nicety: it is what keeps the meshes
 * testable, and what stops a missing photograph being a missing card.
 */

/** Pixels per photo. Small on purpose — see the note on size below. */
const SIZE = 256;

/**
 * How much of the frame the dish fills.
 *
 * Under 1 leaves the margin a photograph has. Without it the plate touches all
 * four edges and reads as a texture rather than as a picture *of* something.
 */
const FILL = 0.88;

let renderer: THREE.WebGLRenderer | null = null;
const photos = new Map<string, THREE.Texture>();

/**
 * Lend the studio a renderer. Called by whoever owns one.
 *
 * Idempotent, and last caller wins: a page has one renderer at a time, and the
 * gallery replacing the kitchen's is exactly the case that has to work.
 */
export function openStudio(webgl: THREE.WebGLRenderer): void {
  if (renderer === webgl) return;
  renderer = webgl;
  // Photographs taken with the old renderer belong to a GL context that is
  // going away, so they are not reused. Disposed rather than dropped: the
  // textures are the only thing here big enough to be worth freeing.
  for (const texture of photos.values()) texture.dispose();
  photos.clear();
}

/**
 * A photograph of this item, or null when the studio has no renderer yet.
 *
 * Cached by the item's own identity — a baked pizza and an unbaked one are two
 * different pictures — so a card built for the twentieth time costs a map
 * lookup. Never evicted: the set of dishes is the cookbook, and it is eight.
 */
export function dishPhoto(item: Item): THREE.Texture | null {
  if (!renderer) return null;
  const key = `${item.base}|${item.processes.join(",")}`;
  const cached = photos.get(key);
  if (cached) return cached;
  const shot = shoot(renderer, item);
  photos.set(key, shot);
  return shot;
}

/**
 * A flat, unlit quad showing `texture`, sized in world units.
 *
 * **Unlit, but tone-mapped.** Those are two different questions and getting
 * them the same way round is the whole difference between a print and a decal.
 * Unlit, because the light in a photograph happened when it was taken — a sun
 * sliding a highlight across the picture is the exact tell that it is a model.
 * Tone-mapped, because it is nevertheless ink on a card standing in a kitchen,
 * and a print that ignored the evening while the card it is on went orange
 * would be the *other* tell.
 *
 * A print takes no part in the shadow map either: it is ink on a card that is
 * already casting one.
 */
export function photoQuad(texture: THREE.Texture, size: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true }),
  );
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/**
 * Take the picture.
 *
 * The scene is built and thrown away per shot. It would be reusable — one
 * scene, swap the model — and that is a saving of a few milliseconds, once,
 * for a shared mutable studio that every future caller could leave dressed.
 */
function shoot(webgl: THREE.WebGLRenderer, item: Item): THREE.Texture {
  const scene = new THREE.Scene();
  const model = buildItemModel(item);

  // Measured, then framed — the same discipline `textSprite` uses on a string.
  // Dishes are not one size: a plate of fries and a whole pizza differ by about
  // a third, and a fixed camera would crop one and strand the other.
  const bounds = new THREE.Box3().setFromObject(model);
  const centre = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 0.001);
  model.position.sub(centre);
  model.updateMatrixWorld(true);
  scene.add(model);

  const camera = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.01, radius * 12);
  // Down the kitchen's own 3/4 line, so a dish is photographed the way it is
  // seen. A picture taken from straight on would be a diagram.
  camera.position.set(radius * 2.2, radius * 2.6, radius * 2.6);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  // Fitted to what the camera can actually *see* of the dish, by projecting the
  // eight corners of its box into camera space. Sizing off the bounding sphere
  // instead — or worse, off half the box diagonal — frames the dish by its
  // longest measurement in any direction, which for a wide flat plate is the
  // one axis pointing away from the lens. Everything comes out small and
  // stranded in the middle of its own card, which is exactly how it looked.
  let extent = 0;
  const corner = new THREE.Vector3();
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        corner.set(x, y, z).sub(centre).applyMatrix4(camera.matrixWorldInverse);
        extent = Math.max(extent, Math.abs(corner.x), Math.abs(corner.y));
      }
    }
  }
  const half = Math.max(extent, 0.001) / FILL;
  camera.left = -half;
  camera.right = half;
  camera.top = half;
  camera.bottom = -half;
  camera.updateProjectionMatrix();

  // A product shot: a soft key, a fill from the opposite side to keep the
  // shadow side from going to black, and an ambient floor under both.
  const key = new THREE.DirectionalLight(0xfff3e2, 2.6);
  key.position.set(1, 2, 1.4);
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.9);
  fill.position.set(-1.4, 0.6, -1);
  scene.add(key, fill, new THREE.AmbientLight(0xffffff, 1.5));

  const target = new THREE.WebGLRenderTarget(SIZE, SIZE, { samples: 4 });
  target.texture.colorSpace = THREE.SRGBColorSpace;

  // Everything borrowed is put back. This runs on somebody else's renderer,
  // between two frames of a game that is still going on — a clear colour left
  // behind here is a kitchen that draws on a black sky for the rest of the
  // session, and it would look like a bug in the daylight rather than in a
  // photograph taken once, an hour ago.
  const previousTarget = webgl.getRenderTarget();
  const previousClear = webgl.getClearColor(new THREE.Color());
  const previousAlpha = webgl.getClearAlpha();

  webgl.setRenderTarget(target);
  // Transparent, so the card's own stock shows through behind the food rather
  // than the photograph carrying a background colour that has to be kept in
  // step with the paper it is printed on.
  webgl.setClearColor(0x000000, 0);
  webgl.clear();
  webgl.render(scene, camera);

  webgl.setRenderTarget(previousTarget);
  webgl.setClearColor(previousClear, previousAlpha);

  // The scene was scaffolding; the render target's texture is the whole output,
  // and the model it was built from has already been photographed.
  disposeSubtree(model);
  return target.texture;
}

/**
 * A framed print: the photograph, its mount, and the card it is on.
 *
 * Built here rather than in `appliance-meshes.ts` because what makes it read as
 * a picture is the frame, and the frame is part of the photograph rather than
 * part of the furniture holding it. Falls back to a bare card when the studio
 * is shut, which is a card that has not had its picture printed yet.
 *
 * The stock fills nearly the whole panel it is pinned to. A small square of
 * paper in the middle of a tall board reads as a note somebody left, and the
 * poster is the reason the board is standing there.
 */
export function framedPhoto(item: Item, width: number, height: number): THREE.Object3D {
  const group = new THREE.Group();
  const stock = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ color: PALETTE.cardFace }),
  );
  group.add(stock);

  const texture = dishPhoto(item);
  if (texture) {
    // A mount: the photograph sits inside the card with a margin all round, the
    // way a print sits inside its border. It is the single strongest signal
    // that this is a picture rather than a thing. Square, and sized off the
    // narrow side, so a portrait poster keeps its margins even.
    const print = photoQuad(texture, Math.min(width, height) * 0.88);
    print.position.z = 0.002;
    group.add(print);
  }
  return group;
}
