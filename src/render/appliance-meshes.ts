import * as THREE from "three";
import { applianceDef } from "../data/appliances";
import { ingredient } from "../data/ingredients";
import type { Appliance } from "../sim/types";
import { buildIngredientSample } from "./models";
import { PALETTE, type SurfaceName } from "./palette";
import { cylinder, mesh, roundedBox, sphere, torus } from "./primitives";
import { makeLabel } from "./sprites";

/**
 * The appliances themselves: bodies, tops, and the small details that stop each
 * one reading as a box.
 *
 * Split out of a 681-line `meshes.ts` that five modules imported, none of which
 * needed more than two of its exports — the slices were near-disjoint, which is
 * what a god object looks like from the outside. This one has a single
 * consumer, `appliance-views.ts`.
 *
 * Two rules from the old file still hold everywhere:
 *  1. **Everything is rounded.** Hard 90 degree edges read as programmer art; a
 *     small bevel catches the key light and makes primitives look sculpted.
 *  2. **Geometry is built at final size and cached**, never unit-scaled.
 */

/**
 * A mesh's material as the standard material it is.
 *
 * `Mesh.material` is `Material | Material[]`, so reading `.emissive` off it
 * needs narrowing. Everything `primitives.mesh` builds is a single
 * MeshStandardMaterial; this asserts that once, loudly, instead of once per
 * call site and silently.
 */
function standardMaterial(target: THREE.Mesh): THREE.MeshStandardMaterial {
  const material = target.material;
  if (Array.isArray(material) || !(material instanceof THREE.MeshStandardMaterial)) {
    throw new Error("expected a single MeshStandardMaterial");
  }
  return material;
}

// --- appliances --------------------------------------------------------------

/**
 * The moving parts of one appliance, named and typed.
 *
 * These used to live in `object.userData`, which three.js types as
 * `Record<string, any>`. Every reader therefore looked like
 * `object.userData.knife as THREE.Object3D | undefined` — a cast asserting
 * something the compiler had no way to check, because the only thing that made
 * it true was a line in this file setting that exact key.
 *
 * Renaming `userData.knife` here type-checked cleanly and broke the chop
 * animation at runtime. There were thirteen of these keys and ten readers, and
 * two of the readers (`oilGlow`, `dial`) cast without a `| undefined`, so a
 * missing one would not even fail politely.
 *
 * Now the parts a builder produces and the parts an animator consumes are the
 * same declaration, and getting it wrong is a build error.
 */
export type ApplianceParts = {
  root: THREE.Object3D;
  /** Contextual name, hidden until a chef looks at it. */
  label?: THREE.Object3D;
  /** Board: swings with the chop. */
  knife?: THREE.Object3D;
  /** Fryer: the oil surface, and its own emissive material so it can glow. */
  oil?: THREE.Mesh;
  oilGlow?: THREE.MeshStandardMaterial;
  basket?: THREE.Object3D;
  /** Sink: the water surface, which ripples while somebody is scrubbing. */
  water?: THREE.Mesh;
  /** Oven: one per camera-facing door. */
  glass?: THREE.MeshStandardMaterial[];
  /** Bin: flips open when something goes in. */
  lid?: THREE.Object3D;
};

export function buildAppliance(appliance: Appliance): ApplianceParts {
  const def = applianceDef(appliance.kind);
  const root = new THREE.Group();
  const parts: ApplianceParts = { root };
  const h = def.height;
  const w = 0.94;

  const look = APPLIANCE_LOOK[appliance.kind];

  // Most appliances are a box with details bolted on. A few earn their own
  // silhouette instead — see buildBin.
  if (appliance.kind === "bin") {
    root.add(buildBin(parts, h));
  } else if (appliance.kind === "table") {
    buildTable(root, h);
  } else {
    const body = mesh(roundedBox(w, h, w, 0.07), look.body[0], look.body[1]);
    body.position.y = h / 2;
    root.add(body);

    if (look.top) {
      const slab = mesh(roundedBox(w * 0.9, 0.08, w * 0.9, 0.03), look.top[0], look.top[1]);
      slab.position.y = h + 0.01;
      root.add(slab);
    }
    addDetails(parts, appliance, h);
  }

  if (appliance.source) {
    // Crates show an actual sample of what they dispense.
    const marker = buildIngredientSample(appliance.source.base);
    marker.position.y = h + 0.06;
    root.add(marker);
  }

  // Labels are contextual: hidden until a chef looks at the appliance. Keeping
  // the world label-free is what lets the diorama read as a diorama.
  const label = appliance.source ? ingredient(appliance.source.base).name : look.label;
  if (label) {
    const sprite = makeLabel(label);
    // Just above the progress bar. depthTest is off, so it draws over a chef
    // standing in front rather than fighting them for space.
    sprite.position.y = h + (appliance.source ? 1.15 : 0.98);
    sprite.visible = false;
    root.add(sprite);
    parts.label = sprite;
  }

  return parts;
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

/**
 * How each kind of appliance looks, as one table.
 *
 * This was five parallel `switch (kind)` statements — `bodyLook`, `topLook`,
 * `addDetails`, `labelFor`, and the animation branches in `view.ts` — so adding
 * a sink meant finding all five and remembering the fifth. Worse, `labelFor`
 * had already drifted from the `label` in `data/appliances.ts`: the data said
 * "Chopping board" and "Plate stack", the switch said "Chop" and `null`. Two
 * sources of truth for one string, and no way to notice.
 *
 * `Record<ApplianceKind, ...>` rather than a partial map, so adding a kind to
 * the simulation fails the build here rather than rendering an untextured box.
 */
type Look = {
  body: [number, SurfaceName];
  top?: [number, SurfaceName];
  /**
   * What the contextual label says. Absent means no label — a counter does not
   * need to introduce itself. Crates override this with what they dispense.
   */
  label?: string;
};

const APPLIANCE_LOOK: Record<Appliance["kind"], Look> = {
  // Enamel bodies for anything that would really be enamelled steel.
  wall: { body: [PALETTE.wood, "wood"] },
  counter: { body: [PALETTE.wood, "wood"], top: [PALETTE.woodTop, "wood"] },
  board: { body: [PALETTE.wood, "wood"], top: [PALETTE.boardTop, "wood"], label: "Chop" },
  fryer: { body: [PALETTE.fryerBody, "enamel"], top: [PALETTE.ceramic, "enamel"], label: "Fryer" },
  oven: { body: [PALETTE.ovenBody, "enamel"], top: [PALETTE.ovenGlass, "enamel"], label: "Oven" },
  crate: { body: [PALETTE.crate, "wood"], top: [PALETTE.crateTop, "wood"] },
  // No top slab and no decorative crockery: what the stack is holding is drawn
  // by `item-views.ts`, because it is now a real, countable pile. An empty
  // plate stack has to *look* empty — that is the moment the whole feature
  // exists to create.
  plates: { body: [PALETTE.steel, "enamel"], label: "Plates" },
  sink: { body: [PALETTE.sinkBody, "enamel"], label: "Sink" },
  bin: { body: [PALETTE.bin, "enamel"], top: [PALETTE.steelDark, "enamel"], label: "Bin" },
  table: { body: [PALETTE.wood, "wood"], label: "Table" },
};

/** Small silhouette details: this is what stops every appliance reading as a box. */
function addDetails(parts: ApplianceParts, appliance: Appliance, h: number): void {
  const group = parts.root;
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
        const glass = standardMaterial(door).clone();
        glass.emissive.setHex(PALETTE.ember);
        glass.emissiveIntensity = 0;
        door.material = glass;
        door.position.set(x, h * 0.5, z);
        door.rotation.y = ry;
        group.add(door);
        (parts.glass ??= []).push(glass);
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
      const glow = standardMaterial(oil).clone();
      glow.emissive.setHex(PALETTE.oil);
      glow.emissiveIntensity = 0.4;
      oil.material = glow;
      oil.position.y = h + 0.05;
      group.add(oil);
      parts.oil = oil;
      parts.oilGlow = glow;
      const basket = mesh(cylinder(0.03, 0.03, 0.34), PALETTE.brass, "metal");
      basket.position.set(0.3, h + 0.2, 0.3);
      basket.rotation.z = 0.4;
      group.add(basket);
      parts.basket = basket;
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
      parts.knife = knife;
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
      // A shallow lip, so plates put back on it look put *away* rather than
      // balanced on a box.
      const lip = mesh(torus(0.34, 0.028), PALETTE.steelDark, "metal");
      lip.rotation.x = Math.PI / 2;
      lip.position.y = h + 0.02;
      group.add(lip);
      break;
    }
    case "sink": {
      // A basin sunk into the top, a rim around it, and a tap at the back. The
      // recess is what stops the sink reading as another counter: the one place
      // in the kitchen where the surface goes *down*.
      const basin = mesh(roundedBox(0.66, 0.14, 0.66, 0.05), PALETTE.sinkBasin, "metal");
      basin.position.y = h - 0.06;
      group.add(basin);

      const rim = mesh(roundedBox(0.82, 0.06, 0.82, 0.03), PALETTE.steel, "metal");
      rim.position.y = h + 0.01;
      group.add(rim);

      const water = mesh(roundedBox(0.62, 0.03, 0.62, 0.02), PALETTE.suds, "ceramic");
      water.position.y = h - 0.01;
      group.add(water);
      parts.water = water;

      const spout = mesh(cylinder(0.03, 0.035, 0.34), PALETTE.brass, "metal");
      spout.position.set(0, h + 0.17, -0.36);
      group.add(spout);
      const neck = mesh(cylinder(0.028, 0.028, 0.22), PALETTE.brass, "metal");
      neck.rotation.x = Math.PI / 2;
      neck.position.set(0, h + 0.32, -0.27);
      group.add(neck);
      const tap = mesh(sphere(0.05), PALETTE.brass, "metal");
      tap.position.set(0, h + 0.34, -0.36);
      group.add(tap);
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
function buildBin(parts: ApplianceParts, h: number): THREE.Object3D {
  const bin = new THREE.Group();
  const bodyH = h * 0.86;

  const body = mesh(cylinder(0.44, 0.34, bodyH, 20), PALETTE.bin, "enamel");
  body.position.y = bodyH / 2;
  bin.add(body);

  // A couple of bands break up the taper and catch the light.
  for (const t of [0.32, 0.66]) {
    const band = mesh(
      cylinder(0.34 + 0.1 * t + 0.012, 0.34 + 0.1 * t + 0.012, 0.035, 20),
      PALETTE.steelDark,
      "metal",
    );
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
  parts.lid = lid;

  // Pedal: the detail that names the object.
  const pedal = mesh(roundedBox(0.26, 0.05, 0.14, 0.02), PALETTE.steelDark, "metal");
  pedal.position.set(0, 0.05, 0.42);
  bin.add(pedal);

  return bin;
}
