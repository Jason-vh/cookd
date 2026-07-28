import * as THREE from "three";
import { applianceDef } from "../data/appliances";
import { ingredient } from "../data/ingredients";
import type { Appliance } from "../sim/types";
import { buildIngredientSample } from "./models";
import { LAYER, setLayer } from "./layers";
import { PALETTE, type SurfaceName } from "./palette";
import { cylinder, mesh, roundedBox, sphere, torus } from "./primitives";

/**
 * Meshes for the kitchen itself: appliances, walls, chefs and the flat
 * screen-space bits (labels, bars, highlights).
 *
 * Food lives in `models.ts`; shared geometry/material caches live in
 * `primitives.ts`. Two rules keep the look coherent:
 *  1. **Everything is rounded.** Hard 90 degree edges read as programmer art; a
 *     small bevel catches the key light and makes primitives look sculpted.
 *  2. **Geometry is built at final size and cached**, never unit-scaled.
 */

export const PLAYER_COLORS = PALETTE.chefs;

// --- appliances --------------------------------------------------------------

export function buildAppliance(appliance: Appliance): THREE.Object3D {
  const def = applianceDef(appliance.kind);
  const group = new THREE.Group();
  const h = def.height;
  const w = 0.94;

  // Most appliances are a box with details bolted on. A few earn their own
  // silhouette instead — see buildBin.
  if (appliance.kind === "bin") {
    group.add(buildBin(group, h));
  } else if (appliance.kind === "table") {
    buildTable(group, h);
  } else {
    const [bodyColor, bodySurface] = bodyLook(appliance.kind);
    const body = mesh(roundedBox(w, h, w, 0.07), bodyColor, bodySurface);
    body.position.y = h / 2;
    group.add(body);

    const top = topLook(appliance.kind);
    if (top) {
      const slab = mesh(roundedBox(w * 0.9, 0.08, w * 0.9, 0.03), top[0], top[1]);
      slab.position.y = h + 0.01;
      group.add(slab);
    }
    addDetails(group, appliance, h);
  }

  if (appliance.source) {
    // Crates show an actual sample of what they dispense.
    const marker = buildIngredientSample(appliance.source.base);
    marker.position.y = h + 0.06;
    group.add(marker);
  }

  // Labels are contextual: hidden until a chef looks at the appliance. Keeping
  // the world label-free is what lets the diorama read as a diorama.
  const label = labelFor(appliance);
  if (label) {
    const sprite = makeLabel(label);
    // Just above the progress bar. depthTest is off, so it draws over a chef
    // standing in front rather than fighting them for space.
    sprite.position.y = h + (appliance.source ? 1.15 : 0.98);
    sprite.visible = false;
    group.add(sprite);
    group.userData.label = sprite;
  }

  return group;
}

/**
 * A round cafe table with four chairs, replacing the body a generic appliance
 * would otherwise get.
 *
 * The chairs are the point. `MAX_ACTIVE_ORDERS` used to be a constant; now it
 * is furniture a player buys and places, and furniture has to *look* like
 * capacity from across the room. Four of them also promise the parties that
 * come later without needing them to exist yet.
 */
function buildTable(group: THREE.Group, h: number): void {
  const top = mesh(cylinder(0.42, 0.4, 0.07), PALETTE.woodTop, "wood");
  top.position.y = h;
  group.add(top);

  const stem = mesh(cylinder(0.07, 0.09, h), PALETTE.steelDark, "paintedMetal");
  stem.position.y = h / 2;
  group.add(stem);

  const foot = mesh(cylinder(0.24, 0.26, 0.05), PALETTE.steelDark, "paintedMetal");
  foot.position.y = 0.025;
  group.add(foot);

  // One chair per side, tucked under the overhang so they never spill into a
  // neighbouring tile and confuse what is walkable.
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2;
    const chair = new THREE.Group();
    chair.position.set(Math.sin(angle) * 0.42, 0, Math.cos(angle) * 0.42);
    chair.rotation.y = angle;

    const seat = mesh(roundedBox(0.26, 0.05, 0.26, 0.02), PALETTE.wood, "wood");
    seat.position.y = h * 0.62;
    chair.add(seat);

    const back = mesh(roundedBox(0.26, 0.22, 0.04, 0.02), PALETTE.wood, "wood");
    back.position.set(0, h * 0.62 + 0.13, 0.11);
    chair.add(back);

    for (const [lx, lz] of [
      [-0.1, -0.1],
      [0.1, -0.1],
      [-0.1, 0.1],
      [0.1, 0.1],
    ] as const) {
      const leg = mesh(cylinder(0.017, 0.017, h * 0.62), PALETTE.crateTrim, "wood");
      leg.position.set(lx, (h * 0.62) / 2, lz);
      chair.add(leg);
    }
    group.add(chair);
  }
}

function bodyLook(kind: Appliance["kind"]): [number, SurfaceName] {
  switch (kind) {
    // Enamel bodies for anything that would really be enamelled steel.
    case "oven":
      return [PALETTE.ovenBody, "enamel"];
    case "fryer":
      return [PALETTE.fryerBody, "enamel"];
    case "plates":
      return [PALETTE.steel, "enamel"];
    case "crate":
      return [PALETTE.crate, "wood"];
    case "bin":
      return [PALETTE.bin, "enamel"];
    default:
      return [PALETTE.wood, "wood"];
  }
}

function topLook(kind: Appliance["kind"]): [number, SurfaceName] | null {
  switch (kind) {
    case "board":
      return [PALETTE.boardTop, "wood"];
    case "counter":
      return [PALETTE.woodTop, "wood"];
    case "crate":
      return [PALETTE.crateTop, "wood"];
    case "oven":
      return [PALETTE.ovenGlass, "enamel"];
    case "fryer":
      return [PALETTE.ceramic, "enamel"];
    case "bin":
      return [PALETTE.steelDark, "enamel"];
    default:
      return null;
  }
}

/** Small silhouette details: this is what stops every appliance reading as a box. */
function addDetails(group: THREE.Group, appliance: Appliance, h: number): void {
  switch (appliance.kind) {
    case "oven": {
      // Dark glass door on both camera-facing sides.
      for (const [x, z, ry] of [
        [0.48, 0, Math.PI / 2],
        [0, 0.48, 0],
      ] as const) {
        const door = mesh(roundedBox(0.56, 0.34, 0.04, 0.02), PALETTE.ovenGlass, "enamel");
        // Own material instance: the glass glows while something is baking, and
        // materials are shared by colour+surface elsewhere.
        const glass = (door.material as THREE.MeshStandardMaterial).clone();
        glass.emissive.setHex(PALETTE.ember);
        glass.emissiveIntensity = 0;
        door.material = glass;
        door.position.set(x, h * 0.5, z);
        door.rotation.y = ry;
        group.add(door);
        (group.userData.glass ??= []).push(glass);
        const handle = mesh(cylinder(0.025, 0.025, 0.6), PALETTE.brass, "metal");
        handle.rotation.z = Math.PI / 2;
        handle.rotation.y = ry;
        handle.position.set(x * 1.02, h * 0.5 + 0.26, z * 1.02);
        group.add(handle);
      }
      break;
    }
    case "fryer": {
      const oil = mesh(roundedBox(0.6, 0.06, 0.6, 0.02), PALETTE.oil, "ceramic");
      // Own material instance so the oil can glow into the bloom pass.
      const glow = (oil.material as THREE.MeshStandardMaterial).clone();
      glow.emissive.setHex(PALETTE.oil);
      glow.emissiveIntensity = 0.4;
      oil.material = glow;
      oil.position.y = h + 0.05;
      group.add(oil);
      group.userData.oil = oil;
      group.userData.oilGlow = glow;
      const basket = mesh(cylinder(0.03, 0.03, 0.34), PALETTE.brass, "metal");
      basket.position.set(0.3, h + 0.2, 0.3);
      basket.rotation.z = 0.4;
      group.add(basket);
      group.userData.basket = basket;
      break;
    }
    case "board": {
      // A little knife resting on the board reads instantly as "chop here".
      // It hangs off a pivot at the handle so it can be swung when chopping.
      const knife = new THREE.Group();
      knife.position.set(-0.24, h + 0.09, 0.22);
      knife.rotation.y = 0.25;

      const blade = mesh(roundedBox(0.34, 0.02, 0.09, 0.008), PALETTE.steel, "metal");
      blade.position.set(0.3, 0, 0.06);
      knife.add(blade);

      const handle = mesh(roundedBox(0.14, 0.035, 0.05, 0.015), PALETTE.crateTrim, "wood");
      handle.position.set(0.05, 0, 0.02);
      knife.add(handle);

      group.add(knife);
      group.userData.knife = knife;
      break;
    }
    case "crate": {
      for (const y of [h * 0.32, h * 0.72]) {
        const slat = mesh(roundedBox(0.98, 0.07, 0.98, 0.02), PALETTE.crateTrim, "wood");
        slat.position.y = y;
        group.add(slat);
      }
      break;
    }
    case "plates": {
      for (let i = 0; i < 3; i++) {
        const plate = mesh(cylinder(0.3, 0.27, 0.045), PALETTE.ceramic, "enamel");
        plate.position.y = h + 0.04 + i * 0.05;
        group.add(plate);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * A pedal bin, not a dark box. The old bin was the same rounded cube as every
 * counter, which made the one appliance that destroys your work look like a
 * place to put things down. A tapered body, a rim and a hinged lid read as
 * "rubbish" from across the kitchen, and the lid gives the act of binning
 * something a beat of feedback.
 */
function buildBin(group: THREE.Group, h: number): THREE.Object3D {
  const bin = new THREE.Group();
  const bodyH = h * 0.86;

  const body = mesh(cylinder(0.44, 0.34, bodyH, 20), PALETTE.bin, "enamel");
  body.position.y = bodyH / 2;
  bin.add(body);

  // A couple of bands break up the taper and catch the light.
  for (const t of [0.32, 0.66]) {
    const band = mesh(cylinder(0.34 + 0.1 * t + 0.012, 0.34 + 0.1 * t + 0.012, 0.035, 20), PALETTE.steelDark, "metal");
    band.position.y = bodyH * t;
    bin.add(band);
  }

  const rim = mesh(torus(0.44, 0.035), PALETTE.steelDark, "metal");
  rim.rotation.x = Math.PI / 2;
  rim.position.y = bodyH;
  bin.add(rim);

  // Lid hinged at the back so it can flip open. Pivot sits on the rim.
  const lid = new THREE.Group();
  lid.position.set(0, bodyH + 0.02, -0.44);
  const dome = mesh(cylinder(0.36, 0.46, 0.1, 20), PALETTE.steelDark, "metal");
  dome.position.set(0, 0.05, 0.44);
  lid.add(dome);
  const knob = mesh(sphere(0.06), PALETTE.brass, "metal");
  knob.position.set(0, 0.13, 0.44);
  lid.add(knob);
  bin.add(lid);
  group.userData.lid = lid;

  // Pedal: the detail that names the object.
  const pedal = mesh(roundedBox(0.26, 0.05, 0.14, 0.02), PALETTE.steelDark, "metal");
  pedal.position.set(0, 0.05, 0.42);
  bin.add(pedal);

  return bin;
}

function labelFor(appliance: Appliance): string | null {
  if (appliance.source) return ingredient(appliance.source.base).name;
  switch (appliance.kind) {
    case "board":
      return "Chop";
    case "fryer":
      return "Fryer";
    case "oven":
      return "Oven";
    case "bin":
      return "Bin";
    case "table":
      return "Table";
    default:
      return null;
  }
}

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
 */
export function buildCustomer(index: number): ChefParts {
  const color = PALETTE.customers[index % PALETTE.customers.length]!;
  return buildPerson(color, "customer");
}

function buildPerson(color: number, role: "chef" | "customer"): ChefParts {
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
    const hair = mesh(sphere(0.155), PALETTE.hair, "cloth");
    hair.scale.set(1.03, 0.72, 1.0);
    hair.position.y = 0.06;
    head.add(hair);
  }

  const nose = mesh(sphere(0.035), PALETTE.skin, "cloth");
  nose.position.set(0, -0.01, 0.15);
  head.add(nose);

  const eye = (x: number): THREE.Mesh => {
    const e = mesh(sphere(0.028), 0x2a2b33, "ceramic");
    e.position.set(x, 0.04, 0.14);
    return e;
  };
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
  setLayer(object, LAYER.UI);
  return object;
}

// --- generated textures ------------------------------------------------------

function canvas2d(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement("canvas");
  element.width = size;
  element.height = size;
  return [element, element.getContext("2d")!];
}

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

const labelCache = new Map<string, THREE.SpriteMaterial>();

/**
 * A name tag above a chef.
 *
 * Unlike appliance labels this is **fitted to the text**: a fixed-width pill
 * gives "Bo" the same box as "Cassandra", which at eight players on screen
 * means half the tags are mostly empty space with unreadably small text in the
 * middle. The sprite's world scale is derived from the measured canvas, so
 * every name renders at the same physical letter height.
 */
const nameTagCache = new Map<string, { material: THREE.SpriteMaterial; aspect: number }>();

const TAG_HEIGHT = 0.42;

export function makeNameTag(text: string, color: number): THREE.Sprite {
  const key = `${text}:${color}`;
  let entry = nameTagCache.get(key);
  if (!entry) {
    const font = "700 64px system-ui, -apple-system, Segoe UI, sans-serif";
    const [measureCanvas, measureCtx] = canvas2d(8);
    measureCtx.font = font;
    const textWidth = measureCtx.measureText(text).width;
    void measureCanvas;

    const padding = 34;
    const width = Math.ceil(textWidth + padding * 2);
    const height = 128;
    const element = document.createElement("canvas");
    element.width = width;
    element.height = height;
    const ctx = element.getContext("2d")!;
    ctx.fillStyle = "rgba(10,11,16,0.6)";
    roundRect(ctx, 0, 26, width, 76, 38);
    ctx.fill();
    ctx.font = font;
    ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, width / 2, 65);

    const texture = new THREE.CanvasTexture(element);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.anisotropy = 8;
    entry = {
      material: new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        fog: false,
        toneMapped: false,
      }),
      aspect: width / height,
    };
    nameTagCache.set(key, entry);
  }
  const sprite = new THREE.Sprite(entry.material);
  sprite.scale.set(TAG_HEIGHT * entry.aspect, TAG_HEIGHT, 1);
  sprite.renderOrder = 11;
  setLayer(sprite, LAYER.UI);
  return sprite;
}

type LabelStyle = { background: string; color: string; size: number };
const DEFAULT_STYLE: LabelStyle = { background: "rgba(10,11,16,0.72)", color: "#ffffff", size: 60 };

export function makeLabel(text: string, key = text, style: LabelStyle = DEFAULT_STYLE): THREE.Sprite {
  let sprite = labelCache.get(key);
  if (!sprite) {
    const element = document.createElement("canvas");
    element.width = 512;
    element.height = 144;
    const ctx = element.getContext("2d")!;
    ctx.fillStyle = style.background;
    roundRect(ctx, 8, 24, 496, 96, 48);
    ctx.fill();
    ctx.font = `700 ${style.size}px system-ui, sans-serif`;
    ctx.fillStyle = style.color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 256, 73);
    const texture = new THREE.CanvasTexture(element);
    texture.colorSpace = THREE.SRGBColorSpace;
    // No mipmaps: at this on-screen size the minified levels average white text
    // into the dark pill and the label turns into an unreadable smudge.
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.anisotropy = 8;
    // `fog: false` matters: sprites are UI, and scene fog would otherwise fade
    // labels on the far side of the kitchen into the background.
    sprite = new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      fog: false,
      toneMapped: false,
    });
    labelCache.set(key, sprite);
  }
  const object = new THREE.Sprite(sprite);
  object.scale.set(2.0, 0.56, 1);
  object.renderOrder = 10;
  setLayer(object, LAYER.UI);
  return object;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Warm tiled kitchen floor with grout lines and a touch of per-tile variation. */
export function floorTexture(width: number, height: number): THREE.Texture {
  const [element, ctx] = canvas2d(128);
  ctx.fillStyle = hex(PALETTE.floorGrout);
  ctx.fillRect(0, 0, 128, 128);
  const shades = [PALETTE.floorLight, PALETTE.floorDark];
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      ctx.fillStyle = hex(shades[(x + y) % 2]!);
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

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}
