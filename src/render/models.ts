import * as THREE from "three";
import { specKey } from "../sim/items";
import type { Item } from "../sim/types";
import { PALETTE } from "./palette";
import {
  cylinder,
  extruded,
  lathe,
  material,
  mesh,
  roundedBox,
  shellMaterial,
  sphere,
  torus,
} from "./primitives";

/**
 * Sculpted models for every ingredient and dish.
 *
 * Why procedural instead of imported GLTF models: the kitchen itself is
 * procedural, so these stay automatically consistent in scale, palette and
 * shading, there is no asset pipeline or licence to track, and a "model" is a
 * dozen lines that any engineer can tweak. `MODELS` below is a registry keyed
 * by item state, so a real GLTF can be swapped in for any single entry later
 * without touching anything else.
 *
 * Conventions for a builder:
 *  - `y` is the surface the food rests on; build upwards from it
 *  - keep the footprint inside a ~0.34 radius so items fit on a plate
 *  - use `PALETTE` for every colour
 */

type Builder = (parent: THREE.Object3D, item: Item, y: number) => void;

// --- helpers -----------------------------------------------------------------

function put(
  parent: THREE.Object3D,
  object: THREE.Mesh,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  object.position.set(x, y, z);
  parent.add(object);
  return object;
}

/** Deterministic pseudo-random so a given item always looks the same. */
function wobble(seed: number, index: number): number {
  const value = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return value - Math.floor(value) - 0.5;
}

// --- whole ingredients -------------------------------------------------------

const tomato: Builder = (parent, item, y) => {
  const body = put(parent, mesh(sphere(0.16), PALETTE.tomato, "food"), 0, y + 0.145, 0);
  body.scale.set(1, 0.88, 1);

  // Calyx: five little leaves plus a stub of stem.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const leaf = put(
      parent,
      mesh(roundedBox(0.09, 0.02, 0.045, 0.01), PALETTE.stem, "food"),
      Math.cos(a) * 0.05,
      y + 0.265,
      Math.sin(a) * 0.05,
    );
    leaf.rotation.set(0.25, -a, 0);
  }
  put(parent, mesh(cylinder(0.016, 0.02, 0.05), PALETTE.stem, "food"), 0, y + 0.29, 0);
  void item;
};

const lettuce: Builder = (parent, item, y) => {
  const greens = [PALETTE.leafDark, PALETTE.leafMid, PALETTE.leafLight];
  // A head of lettuce is just a pile of crumpled leaves; overlapping squashed
  // spheres at three tones reads as one from any angle.
  put(parent, mesh(sphere(0.15), PALETTE.leafDark, "food"), 0, y + 0.12, 0).scale.set(1, 0.8, 1);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.5;
    const r = 0.075 + wobble(1, i) * 0.02;
    const leaf = put(
      parent,
      mesh(sphere(0.085 + wobble(2, i) * 0.015, 12), greens[i % 3]!, "food"),
      Math.cos(a) * r,
      y + 0.15 + wobble(3, i) * 0.03,
      Math.sin(a) * r,
    );
    leaf.scale.set(1.2, 0.75, 1.2);
    leaf.rotation.set(wobble(4, i) * 0.5, a, wobble(5, i) * 0.5);
  }
  void item;
};

const cheese: Builder = (parent, item, y) => {
  const wedge = extruded(
    "cheese-wedge",
    (shape) => {
      shape.moveTo(-0.15, -0.09);
      shape.lineTo(0.17, -0.09);
      shape.lineTo(-0.15, 0.12);
      shape.closePath();
    },
    0.17,
  );
  const body = put(parent, mesh(wedge, PALETTE.cheese, "food"), 0, y + 0.1, 0);
  body.rotation.set(-Math.PI / 2, 0, 0.4);

  // Holes are children of the wedge so they inherit its rotation and stay on
  // the top face. Shallow discs read as holes at this size and cost nothing.
  const holes: [number, number, number][] = [
    [-0.05, -0.045, 1],
    [0.025, -0.06, 0.75],
    [-0.085, 0.02, 0.9],
  ];
  for (const [hx, hy, scale] of holes) {
    const hole = new THREE.Mesh(cylinder(0.026, 0.026, 0.014), material(PALETTE.cheeseHole, "food"));
    hole.position.set(hx, hy, 0.082);
    hole.rotation.x = Math.PI / 2;
    hole.scale.setScalar(scale);
    body.add(hole);
  }
  void item;
};

const dough: Builder = (parent, item, y) => {
  const kneaded = item.processes.includes("kneaded");
  if (kneaded) {
    // Kneaded dough is flattened out, ready for topping.
    put(parent, mesh(cylinder(0.26, 0.24, 0.055), PALETTE.dough, "food"), 0, y + 0.03, 0);
    put(parent, mesh(torus(0.25, 0.028), PALETTE.dough, "food"), 0, y + 0.05, 0).rotation.x =
      Math.PI / 2;
    put(parent, mesh(cylinder(0.2, 0.2, 0.008), PALETTE.doughDust, "food"), 0, y + 0.06, 0);
    return;
  }
  const ball = put(parent, mesh(sphere(0.155), PALETTE.dough, "food"), 0, y + 0.12, 0);
  ball.scale.set(1.05, 0.78, 1.05);
  put(parent, mesh(sphere(0.05, 10), PALETTE.doughDust, "food"), 0.04, y + 0.19, 0.03).scale.set(
    1.4,
    0.25,
    1.2,
  );
};

/** A paper sack of flour, folded over at the top. */
/**
 * Twice-chopped tomato: a low, wet mound of sauce. Density is the whole trick —
 * the same lesson as chopped food, one step further. Chunks give way to a pool
 * with only a few pieces left floating in it.
 */
const crushedTomato: Builder = (parent, _item, y) => {
  const pool = put(parent, mesh(cylinder(0.2, 0.17, 0.045, 18), PALETTE.sauce, "food"), 0, y + 0.022, 0);
  // A slightly wider, flatter skim on top reads as glossy liquid.
  const skim = put(parent, mesh(cylinder(0.185, 0.185, 0.012, 18), PALETTE.sauceShine, "food"), 0, 0.028, 0);
  pool.add(skim);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.7;
    const r = 0.05 + wobble(31, i) * 0.07;
    const bit = put(
      parent,
      mesh(roundedBox(0.05, 0.022, 0.05, 0.01), PALETTE.tomato, "food"),
      Math.cos(a) * r,
      y + 0.05,
      Math.sin(a) * r,
    );
    bit.rotation.y = a * 1.7;
  }
};

const flour: Builder = (parent, _item, y) => {
  const sack = put(parent, mesh(roundedBox(0.26, 0.3, 0.2, 0.06), PALETTE.flourSack, "cloth"), 0, y + 0.15, 0);
  // Folded top: a thinner slab, rotated so the crease catches the light.
  const fold = put(parent, mesh(roundedBox(0.27, 0.06, 0.1, 0.03), PALETTE.flourSack, "cloth"), 0, 0.16, 0);
  fold.rotation.z = 0.12;
  sack.add(fold);
  // A dusty band, the one thing that says "flour" and not "sandbag".
  const band = put(parent, mesh(roundedBox(0.265, 0.09, 0.205, 0.03), PALETTE.doughDust, "food"), 0, -0.02, 0);
  sack.add(band);
};

/**
 * An open pail. The first version was a closed jug with the water modelled
 * inside it, which is to say invisible — from a fixed overhead-ish camera the
 * only thing that says "water" is a surface you can actually see into.
 */
const water: Builder = (parent, _item, y) => {
  const pail = put(parent, mesh(cylinder(0.16, 0.12, 0.24, 18), PALETTE.pail, "enamel"), 0, y + 0.12, 0);

  // Filled to the brim, and sitting *proud* of the body. The body is a solid
  // cylinder, so a realistically recessed surface is simply inside it and
  // invisible — the bucket read as empty.
  const surface = put(parent, mesh(cylinder(0.152, 0.152, 0.02, 18), PALETTE.water, "ceramic"), 0, 0.125, 0);
  pail.add(surface);
  const shine = put(parent, mesh(cylinder(0.045, 0.045, 0.008, 12), PALETTE.waterShine, "ceramic"), 0.045, 0.138, -0.035);
  pail.add(shine);

  const rim = put(parent, mesh(torus(0.16, 0.016), PALETTE.pailRim, "metal"), 0, 0.12, 0);
  rim.rotation.x = Math.PI / 2;
  pail.add(rim);

  // Handle arcing over the top: reads as a bucket from any angle.
  const handle = put(parent, mesh(torus(0.155, 0.014), PALETTE.pailRim, "metal"), 0, 0.14, 0);
  handle.rotation.y = Math.PI / 2;
  handle.rotation.z = 0.25;
  pail.add(handle);
};

const potato: Builder = (parent, item, y) => {
  const body = put(parent, mesh(sphere(0.14), PALETTE.potato, "food"), 0, y + 0.115, 0);
  body.scale.set(1.25, 0.82, 0.95);
  // Lumps break the sphere silhouette; eyes sell it as a potato.
  for (let i = 0; i < 3; i++) {
    const lump = put(
      parent,
      mesh(sphere(0.06, 10), PALETTE.potato, "food"),
      wobble(9, i) * 0.22,
      y + 0.12 + wobble(10, i) * 0.05,
      wobble(11, i) * 0.14,
    );
    lump.scale.setScalar(0.9 + wobble(12, i) * 0.4);
  }
  for (let i = 0; i < 2; i++) {
    put(
      parent,
      mesh(sphere(0.018, 8), PALETTE.potatoEye, "food"),
      wobble(13, i) * 0.16,
      y + 0.18,
      wobble(14, i) * 0.1,
    );
  }
  void item;
};

// --- chopped forms -----------------------------------------------------------

/** Chopped tomato: chunky wedges with a paler cut face. */
const choppedTomato: Builder = (parent, item, y) => {
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const r = 0.08 + wobble(15, i) * 0.03;
    const chunk = put(
      parent,
      mesh(roundedBox(0.1, 0.07, 0.1, 0.028), PALETTE.tomato, "food"),
      Math.cos(a) * r,
      y + 0.035 + (i % 2) * 0.055,
      Math.sin(a) * r,
    );
    chunk.rotation.y = a;
    const flesh = put(
      parent,
      mesh(roundedBox(0.07, 0.012, 0.07, 0.005), PALETTE.tomatoFlesh, "food"),
      chunk.position.x,
      chunk.position.y + 0.04,
      chunk.position.z,
    );
    flesh.rotation.y = a;
  }
  void item;
};

/** Shredded lettuce: thin curled ribbons. */
const choppedLettuce: Builder = (parent, item, y) => {
  const greens = [PALETTE.leafMid, PALETTE.leafLight, PALETTE.leafDark];
  // Density matters more than shape here: a handful of ribbons looks like
  // litter, a heap of them looks like a portion.
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 * 2.4;
    const r = 0.02 + (i / 16) * 0.075;
    const strip = put(
      parent,
      mesh(roundedBox(0.16, 0.018, 0.07, 0.009), greens[i % 3]!, "food"),
      Math.cos(a) * r,
      y + 0.022 + (i % 4) * 0.019,
      Math.sin(a) * r,
    );
    strip.rotation.set(wobble(17, i) * 0.5, a + wobble(18, i) * 0.8, wobble(19, i) * 0.35);
  }
  void item;
};

/** Grated cheese: a loose pile of shreds. */
const choppedCheese: Builder = (parent, item, y) => {
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 * 2.6;
    const r = 0.015 + (i / 18) * 0.075;
    const shred = put(
      parent,
      mesh(roundedBox(0.13, 0.018, 0.03, 0.008), i % 4 === 0 ? PALETTE.cheeseRind : PALETTE.cheese, "food"),
      Math.cos(a) * r,
      y + 0.02 + (i % 4) * 0.017,
      Math.sin(a) * r,
    );
    shred.rotation.set(0, a + wobble(21, i) * 0.7, wobble(22, i) * 0.25);
  }
  void item;
};

/** Chipped potato: raw matchsticks, stacked. */
const choppedPotato: Builder = (parent, item, y) => {
  for (let i = 0; i < 9; i++) {
    const stick = put(
      parent,
      mesh(roundedBox(0.045, 0.045, 0.23, 0.014), PALETTE.potatoFlesh, "food"),
      -0.09 + (i % 3) * 0.09 + wobble(23, i) * 0.02,
      y + 0.026 + Math.floor(i / 3) * 0.048,
      wobble(24, i) * 0.05,
    );
    stick.rotation.y = wobble(25, i) * 0.3;
  }
  void item;
};

// --- dishes ------------------------------------------------------------------

const pizza: Builder = (parent, item, y) => {
  const baked = item.processes.includes("baked");
  const crustColor = baked ? PALETTE.crustBaked : PALETTE.crustRaw;

  put(parent, mesh(cylinder(0.27, 0.25, 0.05), crustColor, "food"), 0, y + 0.025, 0);
  put(parent, mesh(torus(0.26, 0.035), crustColor, "food"), 0, y + 0.045, 0).rotation.x =
    Math.PI / 2;

  if (item.processes.includes("sauced")) {
    put(parent, mesh(cylinder(0.23, 0.23, 0.022), PALETTE.sauce, "food"), 0, y + 0.06, 0);
  }
  if (item.processes.includes("topped")) {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.4;
      const r = i % 2 === 0 ? 0.16 : 0.08;
      const blob = put(
        parent,
        mesh(roundedBox(0.06, 0.02, 0.06, 0.012), PALETTE.cheese, "food"),
        Math.cos(a) * r,
        y + 0.075,
        Math.sin(a) * r,
      );
      blob.rotation.y = a;
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.9;
      put(
        parent,
        mesh(cylinder(0.045, 0.045, 0.014), PALETTE.pepperoni, "food"),
        Math.cos(a) * 0.13,
        y + 0.086,
        Math.sin(a) * 0.13,
      );
    }
  }
};

const salad: Builder = (parent, item, y) => {
  const greens = [PALETTE.leafMid, PALETTE.leafLight, PALETTE.leafDark];
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2 * 1.6;
    const r = 0.03 + (i / 11) * 0.14;
    const leaf = put(
      parent,
      mesh(sphere(0.062, 10), greens[i % 3]!, "food"),
      Math.cos(a) * r,
      y + 0.04 + wobble(25, i) * 0.03,
      Math.sin(a) * r,
    );
    leaf.scale.set(1.3, 0.55, 1.3);
    leaf.rotation.set(wobble(26, i) * 0.5, a, wobble(27, i) * 0.5);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.6;
    put(
      parent,
      mesh(roundedBox(0.06, 0.045, 0.06, 0.018), PALETTE.tomato, "food"),
      Math.cos(a) * 0.1,
      y + 0.085,
      Math.sin(a) * 0.1,
    ).rotation.y = a;
  }
  void item;
};

const fries: Builder = (parent, item, y) => {
  // Tapered four-sided cylinder = a chip carton, rotated to face the camera.
  const carton = put(parent, mesh(cylinder(0.17, 0.11, 0.22, 4), PALETTE.carton, "food"), 0, y + 0.11, 0);
  carton.rotation.y = Math.PI / 4;
  const lip = put(parent, mesh(cylinder(0.175, 0.17, 0.03, 4), PALETTE.cartonLip, "food"), 0, y + 0.215, 0);
  lip.rotation.y = Math.PI / 4;

  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const r = 0.05 + wobble(28, i) * 0.03;
    const fry = put(
      parent,
      mesh(roundedBox(0.042, 0.24, 0.042, 0.014), PALETTE.fries, "food"),
      Math.cos(a) * r,
      y + 0.3 + wobble(29, i) * 0.03,
      Math.sin(a) * r,
    );
    fry.rotation.set(Math.cos(a) * 0.3, a, Math.sin(a) * 0.3);
  }
  void item;
};

// --- containers and failure states -------------------------------------------

const plate: Builder = (parent, item, y) => {
  const profile = lathe("plate", [
    [0, 0],
    [0.14, 0.004],
    [0.22, 0.016],
    [0.28, 0.042],
    [0.315, 0.07],
    [0.33, 0.082],
  ]);
  const dirty = item.processes.includes("dirty");
  const dish = new THREE.Mesh(
    profile,
    shellMaterial(dirty ? PALETTE.plateDirty : PALETTE.ceramic, dirty ? "ceramic" : "enamel"),
  );
  dish.castShadow = true;
  dish.receiveShadow = true;
  dish.position.y = y;
  parent.add(dish);

  // Leftovers, so a used plate reads as used from the far side of the room
  // rather than as a clean one someone forgot to pick up.
  if (dirty) {
    for (let i = 0; i < 5; i++) {
      const smear = put(
        parent,
        mesh(sphere(0.026 + Math.abs(wobble(41, i)) * 0.018, 8), PALETTE.crumbs, "food"),
        wobble(42, i) * 0.16,
        y + 0.022,
        wobble(43, i) * 0.16,
      );
      smear.scale.set(1.3, 0.42, 1.1);
    }
  }

  for (const child of item.contents) addModel(parent, child, y + 0.03);
};

/** Anything burnt collapses to the same charred lump — a clear, readable fail. */
const burnt: Builder = (parent, item, y) => {
  const lump = put(parent, mesh(sphere(0.15, 12), PALETTE.burnt, "stone"), 0, y + 0.1, 0);
  lump.scale.set(1.2, 0.7, 1.1);
  for (let i = 0; i < 4; i++) {
    const chunk = put(
      parent,
      mesh(roundedBox(0.1, 0.06, 0.1, 0.02), PALETTE.burnt, "stone"),
      wobble(30, i) * 0.22,
      y + 0.08 + wobble(31, i) * 0.06,
      wobble(32, i) * 0.18,
    );
    chunk.rotation.set(wobble(33, i), wobble(34, i) * 3, wobble(35, i));
  }
  void item;
};

const fallback: Builder = (parent, item, y) => {
  put(parent, mesh(roundedBox(0.24, 0.18, 0.24, 0.05), 0xcccccc, "food"), 0, y + 0.09, 0);
  void item;
};

// --- registry ----------------------------------------------------------------

/**
 * Looked up by exact item key first (`tomato|chopped`), then by ingredient base
 * (`tomato`). Add a new entry to give any item state its own model.
 */
const MODELS: Record<string, Builder> = {
  // exact states
  "tomato|chopped": choppedTomato,
  "tomato|chopped,crushed": crushedTomato,
  "lettuce|chopped": choppedLettuce,
  "cheese|chopped": choppedCheese,
  "potato|chopped": choppedPotato,

  // bases
  tomato,
  lettuce,
  cheese,
  flour,
  water,
  dough,
  potato,
  pizza,
  salad,
  fries,
  plate,
};

export function addModel(parent: THREE.Object3D, item: Item, y: number): void {
  if (item.processes.includes("burnt")) {
    burnt(parent, item, y);
    return;
  }
  const builder = MODELS[specKey(item)] ?? MODELS[item.base] ?? fallback;
  builder(parent, item, y);
}

export function buildItemModel(item: Item): THREE.Object3D {
  const group = new THREE.Group();
  addModel(group, item, 0);
  return group;
}

/** A display-only sample of an ingredient, used as the marker on crates. */
export function buildIngredientSample(base: string): THREE.Object3D {
  const model = buildItemModel({ id: -1, base, processes: [], contents: [] });
  model.scale.setScalar(0.85);
  return model;
}
