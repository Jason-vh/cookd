import * as THREE from "three";
import { applianceDef } from "../data/appliances";
import { ingredient } from "../data/ingredients";
import type { Appliance } from "../sim/types";
import { buildIngredientSample, buildProduceHeap } from "./models";
import { PALETTE, type SurfaceName } from "./palette";
import { dHandle, facing, grip, rim, SIDES } from "./parts";
import { cylinder, lathe, mesh, roundedBox, shellMesh, sphere, sweep } from "./primitives";
import { makeLabel } from "./sprites";
import { cssHex, textTexture } from "./text";

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
  /** Stall: where the goods stand, restocked by `appliance-views.ts`. */
  counter?: THREE.Object3D;
  /** Crate: the mouth of it, where the heap of stock sits. */
  produce?: THREE.Object3D;
  /** Stall: dropped over the goods while the kitchen is in service. */
  shutter?: THREE.Object3D;
  /** Card stand: the card itself — hidden on ordinary mornings, lifted when armed. */
  card?: THREE.Object3D;
  /** Card stand: where the dish model stands, dressed by `appliance-views.ts`. */
  cardArt?: THREE.Object3D;
  /** Sign: the board that turns over. */
  board?: THREE.Object3D;
  /** Sign: both faces of the board, repainted when the day opens or closes. */
  boardFaces?: THREE.MeshStandardMaterial[];
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
  } else if (appliance.kind === "stall") {
    buildStall(parts, h);
  } else if (appliance.kind === "cards") {
    buildCardStand(parts, h);
  } else if (appliance.kind === "sign") {
    buildSign(parts, h);
  } else if (appliance.kind === "crate") {
    buildCrate(parts, h);
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
    // A crate is stacked, so its stock is a heap sunk into the mouth of it.
    // Anything else with a source shows a single sample, standing on top.
    const nest = parts.produce;
    const stock = nest
      ? buildProduceHeap(appliance.source.base)
      : buildIngredientSample(appliance.source.base);
    if (!nest) stock.position.y = h + 0.06;
    (nest ?? root).add(stock);
  }

  // Labels are contextual: hidden until a chef looks at the appliance. Keeping
  // the world label-free is what lets the diorama read as a diorama.
  //
  // A stall slot's label is the price of what it is holding, and a card stand's
  // is the recipe on the card, so both change with their stock and are (re)built
  // by `appliance-views.ts` instead.
  const label = appliance.source ? ingredient(appliance.source.base).name : look.label;
  if (
    label &&
    appliance.kind !== "stall" &&
    appliance.kind !== "cards" &&
    appliance.kind !== "sign"
  ) {
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
 * The market stall: a timber counter under a striped awning.
 *
 * It is the only structure in the game that faces *outward*, and it is built to
 * be read from two distances. Close up you are looking at what is on the
 * counter and the price above it. From across the patio it is a silhouette —
 * awning, posts, goods — and its state is legible from that silhouette alone:
 * shutters down means closed, and closed is the answer to "can I buy something
 * mid-rush".
 */
function buildStall(parts: ApplianceParts, h: number): void {
  const group = parts.root;

  const counter = mesh(roundedBox(0.94, h, 0.94, 0.06), PALETTE.stallBody, "wood");
  counter.position.y = h / 2;
  group.add(counter);

  const top = mesh(roundedBox(1.02, 0.08, 1.02, 0.03), PALETTE.stallCounter, "wood");
  top.position.y = h + 0.02;
  group.add(top);

  // Where the goods stand. An empty group rather than a mesh: what is on the
  // counter changes every morning, so the shape of it belongs to whoever knows
  // what the offer is.
  const stock = new THREE.Group();
  stock.position.y = h + 0.06;
  group.add(stock);
  parts.counter = stock;

  // Two posts and a canopy. The awning is tilted forward so it catches the key
  // light on its upper face and shades the goods underneath.
  const canopyY = h + 0.92;
  for (const x of [-0.42, 0.42]) {
    const post = mesh(cylinder(0.035, 0.035, canopyY), PALETTE.stallPost, "wood");
    post.position.set(x, canopyY / 2, -0.4);
    group.add(post);
  }

  const awning = new THREE.Group();
  awning.position.set(0, canopyY, -0.1);
  awning.rotation.x = -0.28;
  for (let i = 0; i < 5; i++) {
    const stripe = mesh(
      roundedBox(0.2, 0.05, 0.86, 0.02),
      i % 2 === 0 ? PALETTE.awning : PALETTE.awningStripe,
      "ceramic",
    );
    stripe.position.x = -0.4 + i * 0.2;
    awning.add(stripe);
  }
  group.add(awning);

  // Shutters: hidden in the build phase, dropped during service. Positioned to
  // fill the gap between counter and awning exactly, so "closed" is a solid
  // face rather than a board hanging in the air.
  const shutter = mesh(roundedBox(0.9, 0.82, 0.06, 0.02), PALETTE.shutter, "wood");
  shutter.position.set(0, h + 0.44, -0.36);
  shutter.visible = false;
  group.add(shutter);
  parts.shutter = shutter;
}

/**
 * The recipe card stand: an easel on the apron, with a card on it or without.
 *
 * The **easel is always there** and the card is not. A stand that vanished
 * entirely on ordinary mornings would be an invisible thing to walk into — it
 * is furniture standing on the patio, and the patio is walked over by every
 * customer in the park. So it follows the stall's grammar instead: the place is
 * permanent, and whether it is *open* is legible from across the patio. Empty
 * easel, nothing to decide.
 */
function buildCardStand(parts: ApplianceParts, h: number): void {
  const group = parts.root;

  // Two splayed legs and a crossbar: an easel reads as "something is displayed
  // here" from any angle, which a plinth does not.
  for (const x of [-0.26, 0.26]) {
    const leg = mesh(cylinder(0.032, 0.038, h * 1.1), PALETTE.cardEasel, "wood");
    leg.position.set(x, (h * 1.1) / 2, 0.06);
    leg.rotation.z = x > 0 ? -0.12 : 0.12;
    group.add(leg);
  }
  const rail = mesh(roundedBox(0.62, 0.05, 0.09, 0.02), PALETTE.cardEasel, "wood");
  rail.position.set(0, h * 0.62, 0.02);
  group.add(rail);

  // The card: its own group so it can be hidden, and lifted while somebody is
  // considering it. Tilted back like a menu board, so the camera reads the face
  // rather than the edge.
  const card = new THREE.Group();
  card.position.set(0, h * 0.98, 0);
  card.rotation.x = -0.34;
  card.visible = false;
  group.add(card);
  parts.card = card;

  const backing = mesh(roundedBox(0.68, 0.86, 0.04, 0.03), PALETTE.cardEdge, "wood");
  card.add(backing);
  const face = mesh(roundedBox(0.6, 0.78, 0.02, 0.02), PALETTE.cardFace, "ceramic");
  face.position.z = 0.03;
  card.add(face);

  // Where the dish stands. Rotated back out of the card's tilt so the food is
  // upright: a pizza lying at 20 degrees reads as a pizza sliding off a plate.
  const art = new THREE.Group();
  art.position.set(0, 0.06, 0.12);
  art.rotation.x = 0.34;
  card.add(art);
  parts.cardArt = art;
}

/** What the board says, and the colour it says it in. */
export const SIGN_FACES = {
  open: { text: "OPEN", color: PALETTE.signOpen },
  closed: { text: "CLOSED", color: PALETTE.signClosed },
} as const;

export type SignFace = keyof typeof SIGN_FACES;

/**
 * The sign hanging in the doorway: a painted board on a hook, and the whole of
 * opening a restaurant.
 *
 * **Both faces say the same thing**, which is not how a real shop sign works
 * and is the right call here: the camera turns to any of four corners, so half
 * the time a player would be reading the back of the board and being told the
 * opposite of the truth. The turn is the animation; the state is on both sides
 * of it.
 *
 * It stands on its own post rather than being screwed to the wall behind it,
 * because that wall is a **26cm stub** whenever the camera is on its side of
 * the building — a board fixed to it would hang in mid-air from two of the four
 * corners.
 */
function buildSign(parts: ApplianceParts, h: number): void {
  const group = parts.root;

  const post = mesh(roundedBox(0.12, h, 0.12, 0.04), PALETTE.signBoard, "wood");
  post.position.y = h / 2;
  group.add(post);

  const arm = mesh(roundedBox(0.5, 0.08, 0.1, 0.03), PALETTE.signHook, "metal");
  arm.position.set(0, h - 0.06, 0);
  group.add(arm);

  // The board hangs from the arm and turns about the post. Its own group, so
  // `appliance-views.ts` can spin it without touching the ironmongery.
  const board = new THREE.Group();
  board.position.y = h - 0.42;
  group.add(board);
  parts.board = board;

  const frame = mesh(roundedBox(0.74, 0.56, 0.05, 0.03), PALETTE.signBoard, "wood");
  board.add(frame);

  // One material per face, both repainted together: the two faces exist so the
  // board has thickness, not so they can disagree.
  const faces: THREE.MeshStandardMaterial[] = [];
  for (const z of [0.031, -0.031]) {
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(0.66, 0.48),
      new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0 }),
    );
    face.position.z = z;
    face.rotation.y = z > 0 ? 0 : Math.PI;
    board.add(face);
    faces.push(face.material);
  }
  parts.boardFaces = faces;
  paintSign(faces, "closed");
}

/**
 * Repaint both faces of a sign.
 *
 * The word is baked into the texture rather than hung in front of the board as
 * a sprite: a sprite always faces the camera, and a sign that turns has to be
 * able to show you its back.
 */
export function paintSign(faces: THREE.MeshStandardMaterial[], face: SignFace): void {
  const { text, color } = SIGN_FACES[face];
  const texture = textTexture(text, {
    font: "800 34px system-ui, sans-serif",
    color: "#f6f1e6",
    backing: { kind: "pill", color: cssHex(color) },
    padding: 30,
    supersample: 2,
  }).texture;
  for (const material of faces) {
    material.map = texture;
    material.color.setHex(color);
    material.needsUpdate = true;
  }
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
  // Built by `buildStall`, and labelled with a price rather than a name.
  stall: { body: [PALETTE.stallBody, "wood"] },
  // Built by `buildCardStand`, and labelled with whatever is on the card.
  cards: { body: [PALETTE.cardEasel, "wood"] },
  // Built by `buildSign`. No contextual label: a sign that needs a label to say
  // what it is has failed at the only job it has.
  sign: { body: [PALETTE.signBoard, "wood"] },
  counter: { body: [PALETTE.wood, "wood"], top: [PALETTE.woodTop, "wood"] },
  board: { body: [PALETTE.wood, "wood"], top: [PALETTE.boardTop, "wood"], label: "Chop" },
  // An upgrade has to be tellable from its plain twin across the kitchen, so
  // each one changes *material* rather than shape: a steel top where the wood
  // was, dark enamel and brass where the oven is grey.
  steel_board: {
    body: [PALETTE.wood, "wood"],
    top: [PALETTE.steel, "metal"],
    label: "Chop (fast)",
  },
  fryer: { body: [PALETTE.fryerBody, "enamel"], top: [PALETTE.ceramic, "enamel"], label: "Fryer" },
  oven: { body: [PALETTE.ovenBody, "enamel"], top: [PALETTE.ovenGlass, "enamel"], label: "Oven" },
  bell_oven: {
    body: [PALETTE.ovenBodyPro, "enamel"],
    top: [PALETTE.brass, "metal"],
    label: "Bell oven",
  },
  // Built by `buildCrate`, which is slats and gaps rather than a box with a top.
  crate: { body: [PALETTE.crate, "wood"] },
  // No top slab and no decorative crockery: what the stack is holding is drawn
  // by `item-views.ts`, because it is now a real, countable pile. An empty
  // plate stack has to *look* empty — that is the moment the whole feature
  // exists to create.
  plates: { body: [PALETTE.steel, "enamel"], label: "Plates" },
  sink: { body: [PALETTE.sinkBody, "enamel"], label: "Sink" },
  bin: { body: [PALETTE.bin, "enamel"], top: [PALETTE.steelDark, "enamel"], label: "Bin" },
  table: { body: [PALETTE.wood, "wood"], label: "Table" },
  // The serving hatch: a steel sill in a hole in the wall. Enamel and a steel
  // top rather than the timber of the counters beside it, so the one tile you
  // hand food through is the one tile that does not look like a worktop.
  hatch: { body: [PALETTE.sinkBody, "enamel"], top: [PALETTE.steel, "metal"], label: "Hatch" },
};

/** Small silhouette details: this is what stops every appliance reading as a box. */
function addDetails(parts: ApplianceParts, appliance: Appliance, h: number): void {
  const group = parts.root;
  switch (appliance.kind) {
    case "bell_oven":
    case "oven": {
      // A dark glass door on every side, because the camera turns and an oven
      // showing its blank back is an oven you cannot tell is baking.
      for (const [x, z] of SIDES) {
        const door = mesh(roundedBox(0.56, 0.34, 0.04, 0.02), PALETTE.ovenGlass, "enamel");
        // Own material instance: the glass glows while something is baking, and
        // materials are shared by colour+surface elsewhere.
        const glass = standardMaterial(door).clone();
        glass.emissive.setHex(PALETTE.ember);
        glass.emissiveIntensity = 0;
        door.material = glass;
        door.position.set(x * 0.48, h * 0.5, z * 0.48);
        door.rotation.y = facing(x, z);
        group.add(door);
        (parts.glass ??= []).push(glass);

        const handle = dHandle(0.58, 0.07);
        handle.position.set(x * 0.49, h * 0.5 + 0.26, z * 0.49);
        handle.rotation.y = facing(x, z);
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
      // A real basket sitting in the oil, rather than the bare stick at 0.4
      // radians that stood in for one. Open mesh, a rim, and a handle that
      // reaches out over the corner where a chef would take hold of it.
      const basket = new THREE.Group();
      basket.position.set(0.06, h + 0.06, 0.06);
      const bowl = shellMesh(
        lathe("fryer-basket", [
          [0, 0],
          [0.16, 0],
          [0.21, 0.06],
          [0.23, 0.16],
        ]),
        PALETTE.steelDark,
        "metal",
      );
      basket.add(bowl);
      const lip = rim(0.23, 0.016, PALETTE.steel);
      lip.position.y = 0.16;
      basket.add(lip);
      const arm = mesh(
        sweep(
          "fryer-basket-arm",
          [
            [0.16, 0.14, 0.16],
            [0.3, 0.24, 0.3],
            [0.42, 0.26, 0.42],
          ],
          0.018,
        ),
        PALETTE.steel,
        "metal",
      );
      basket.add(arm);
      const hold = grip(0.16, 0.03, PALETTE.crateTrim);
      hold.position.set(0.47, 0.26, 0.47);
      hold.rotation.y = -Math.PI / 4;
      basket.add(hold);
      group.add(basket);
      parts.basket = basket;
      break;
    }
    case "steel_board":
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
    case "plates": {
      // A shallow lip, so plates put back on it look put *away* rather than
      // balanced on a box.
      const lip = rim(0.34, 0.028);
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

      const surround = mesh(roundedBox(0.82, 0.06, 0.82, 0.03), PALETTE.steel, "metal");
      surround.position.y = h + 0.01;
      group.add(surround);

      const water = mesh(roundedBox(0.62, 0.03, 0.62, 0.02), PALETTE.suds, "ceramic");
      water.position.y = h - 0.01;
      group.add(water);
      parts.water = water;

      // A mixer tap in one piece: up off the deck, over, and down into the
      // basin. It used to be three cylinders and a ball, with the joints
      // showing at both bends.
      const spout = mesh(
        sweep(
          "sink-tap",
          [
            [0, 0.02, -0.36],
            [0, 0.26, -0.36],
            [0, 0.36, -0.28],
            [0, 0.34, -0.12],
            [0, 0.29, -0.08],
          ],
          0.028,
          24,
          10,
        ),
        PALETTE.brass,
        "metal",
      );
      spout.position.y = h;
      group.add(spout);

      // The lever, which is what makes it a tap rather than a pipe.
      const lever = mesh(roundedBox(0.16, 0.035, 0.05, 0.016), PALETTE.brass, "metal");
      lever.position.set(0.02, h + 0.28, -0.4);
      lever.rotation.z = 0.22;
      group.add(lever);
      break;
    }
    default:
      break;
  }
}

/**
 * A slatted produce crate, open at the top and stacked with what it dispenses.
 *
 * The old crate was the counter's box with two bands round it and a single
 * sample balanced on the lid, which made the one appliance you take things *out
 * of* look like somewhere to put things down. A real crate is defined by its
 * gaps: corner stiles, boards with daylight between them, and pallet runners
 * holding it off the floor.
 *
 * The interior is a solid dark block rather than nothing. Without it the gaps
 * look straight through to the tiles on the far side and the crate reads as a
 * lantern; with it they read as shadow, and the heap standing proud of the rim
 * reads as a crate that is full.
 */
function buildCrate(parts: ApplianceParts, h: number): void {
  const group = parts.root;

  // Runners, so the crate stands on the tile rather than growing out of it.
  for (const z of [-0.28, 0.28]) {
    const runner = mesh(roundedBox(0.84, 0.06, 0.14, 0.02), PALETTE.crateTrim, "wood");
    runner.position.set(0, 0.03, z);
    group.add(runner);
  }

  const floor = mesh(roundedBox(0.88, 0.06, 0.88, 0.02), PALETTE.crateTop, "wood");
  floor.position.y = 0.09;
  group.add(floor);

  const bedY = h * 0.84;
  const inner = mesh(roundedBox(0.8, bedY - 0.09, 0.8, 0.02), PALETTE.crateInner, "wood");
  inner.position.y = (bedY + 0.09) / 2;
  group.add(inner);

  for (const [x, z] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    const stile = mesh(roundedBox(0.13, h, 0.13, 0.035), PALETTE.crateTrim, "wood");
    stile.position.set(x * 0.4, h / 2, z * 0.4);
    group.add(stile);
  }

  // Three boards a side. The gaps are the point, so the slat is deliberately
  // thinner than the pitch between the rows.
  for (const t of [0.22, 0.5, 0.78]) {
    for (const [x, z] of SIDES) {
      const slat = mesh(roundedBox(0.84, h * 0.17, 0.055, 0.02), PALETTE.crate, "wood");
      slat.position.set(x * 0.44, h * t, z * 0.44);
      slat.rotation.y = facing(x, z);
      group.add(slat);
    }
  }

  // A rail round the mouth: it caps the stiles and gives the top edge the one
  // continuous line the slats never make.
  for (const [x, z] of SIDES) {
    const rail = mesh(roundedBox(0.96, 0.08, 0.11, 0.03), PALETTE.crateTop, "wood");
    rail.position.set(x * 0.42, h - 0.04, z * 0.42);
    rail.rotation.y = facing(x, z);
    group.add(rail);
  }

  // Where the stock heaps up, filled in by `buildAppliance` once it knows what
  // this crate holds.
  const stock = new THREE.Group();
  stock.position.y = bedY;
  group.add(stock);
  parts.produce = stock;
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

  const lip = rim(0.44, 0.035);
  lip.position.y = bodyH;
  bin.add(lip);

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
