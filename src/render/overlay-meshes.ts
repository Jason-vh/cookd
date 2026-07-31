import * as THREE from "three";
import { markUI } from "./layers";
import { PALETTE } from "./palette";
import { cylinder, mesh } from "./primitives";
import { canvas2d, roundRect } from "./text";

/**
 * Things drawn *over* the kitchen rather than in it: the tile highlight in
 * front of a chef, and the coins left on a table.
 *
 * The genuinely shared corner of the old `meshes.ts` — `buildHighlight` has two
 * consumers, which is one more than anything else in that file had.
 */

// --- generated textures ------------------------------------------------------

let ringCache: THREE.Texture | null = null;
function ringTexture(): THREE.Texture {
  if (ringCache) return ringCache;
  const [element, ctx] = canvas2d(128);
  ctx.clearRect(0, 0, 128, 128);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 9;
  roundRect(ctx, 8, 8, 112, 112, 22);
  ctx.stroke();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ringCache = new THREE.CanvasTexture(element);
  return ringCache;
}

/**
 * A name tag above a chef. Only exists online, where there is a name to show.

// --- tips --------------------------------------------------------------------

/**
 * The little stack of coins a happy customer leaves behind.
 *
 * Small, but it is the whole reason bussing is a decision rather than a chore:
 * it has to be visible from across the dining room, so it is shiny and it
 * turns. Anything subtler and clearing tables goes back to being a toll.
 */
export function buildTipStack(): THREE.Object3D {
  const group = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const radius = 0.115 - i * 0.008;
    const coin = mesh(cylinder(radius, radius, 0.03, 16), PALETTE.coin, "metal");
    coin.position.set(i === 3 ? 0.025 : 0, 0.016 + i * 0.029, i === 3 ? 0.018 : 0);
    coin.rotation.y = i * 0.4;
    group.add(coin);
  }
  // One fallen on its edge against the stack: the silhouette that says "coins"
  // rather than "small cylinder".
  const leaning = mesh(cylinder(0.105, 0.105, 0.03, 16), PALETTE.coinEdge, "metal");
  leaning.position.set(-0.14, 0.105, 0.04);
  leaning.rotation.set(Math.PI / 2, 0, 0.3);
  group.add(leaning);
  return group;
}

// --- tile highlight ----------------------------------------------------------

export function buildHighlight(color: number): THREE.Mesh {
  const object = new THREE.Mesh(
    new THREE.PlaneGeometry(0.94, 0.94),
    new THREE.MeshBasicMaterial({
      color,
      map: ringTexture(),
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      fog: false,
    }),
  );
  object.rotation.x = -Math.PI / 2;
  object.renderOrder = 4;
  markUI(object);
  return object;
}
