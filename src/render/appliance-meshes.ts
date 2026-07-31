import * as THREE from "three";
import { applianceDef } from "../data/appliances";
import { ingredient } from "../data/ingredients";
import type { Appliance } from "../sim/types";
import { buildIngredientSample, buildProduceHeap } from "./models";
import { PALETTE, shade, type SurfaceName } from "./palette";
import {
  cabinetFace,
  CORNERS,
  dHandle,
  deck,
  facing,
  grip,
  plinth,
  rim,
  roundedRect,
  SIDES,
  TOE_KICK,
} from "./parts";
import {
  cylinder,
  extruded,
  lathe,
  mesh,
  roundedBox,
  roundedCylinder,
  shellMesh,
  sphere,
  sweep,
  torus,
} from "./primitives";
import { makeLabel } from "./sprites";
import { jitter, type Jitter } from "./wobble";
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
  // Every appliance is a little out of true, and always the same little. See
  // `wobble.ts` for why this is not `Math.random()`.
  const nudge = jitter(appliance.id);

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
    buildCrate(parts, h, nudge);
  } else if (appliance.kind === "table") {
    buildTable(root, h, nudge);
  } else {
    // Standing on a recessed plinth rather than on its own bottom face. The
    // body loses exactly what the plinth gains, so `height` still means the
    // height of the appliance and every top, item and label sits where it did.
    const stand = look.grounded ? 0 : TOE_KICK;
    const bodyH = h - stand;
    const body = mesh(roundedBox(w, bodyH, w, 0.07), look.body[0], look.body[1]);
    body.position.y = stand + bodyH / 2;
    root.add(body);
    if (stand > 0) root.add(plinth(w, look.body[0], stand));
    if (look.cabinet) cabinetFace(root, w, bodyH, stand, look.body[0], look.body[1]);

    if (look.top) {
      // Wider than the body it sits on, not narrower. A worktop *overhangs* its
      // cabinet by an inch or two, and that lip is what casts the line of shadow
      // that separates the two; a top tucked inside the body reads as a lid.
      // Its upper face stays at h + 0.05, where items are placed.
      const slab = mesh(roundedBox(w + 0.04, 0.06, w + 0.04, 0.025), look.top[0], look.top[1]);
      slab.position.y = h + 0.02;
      // A worktop laid a fraction out of square with its cabinet. Tiny: a run of
      // counters must still read as one continuous surface.
      slab.rotation.y = nudge(1, 0.02);
      root.add(slab);
    }
    addDetails(parts, appliance, h, nudge);
  }

  if (appliance.source) {
    // A crate is stacked, so its stock is a heap sunk into the mouth of it.
    // Anything else with a source shows a single sample, standing on top.
    const nest = parts.produce;
    const stock = nest
      ? buildProduceHeap(appliance.source.base, appliance.id)
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

  const top = mesh(roundedBox(1.02, 0.08, 1.02, 0.03), PALETTE.woodTop, "wood");
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
    const leg = mesh(cylinder(0.032, 0.038, h * 1.1), PALETTE.woodDark, "wood");
    leg.position.set(x, (h * 1.1) / 2, 0.06);
    leg.rotation.z = x > 0 ? -0.12 : 0.12;
    group.add(leg);
  }
  const rail = mesh(roundedBox(0.62, 0.05, 0.09, 0.02), PALETTE.woodDark, "wood");
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
 * The sign on the wall by the door: a bracket, and a board swinging off it.
 *
 * **Both faces say the same thing**, which is not how a real shop sign works
 * and is the right call here: the camera turns to any of four corners, so half
 * the time a player would be reading the back of the board and being told the
 * opposite of the truth. The turn is the animation; the state is on both sides
 * of it.
 *
 * It used to stand on a post in the middle of its tile and spin to face the
 * camera. Both halves of that were wrong: a lamp post is not what a shop sign
 * is, and a sign that turns to follow you is a billboard. It hangs flat on the
 * wall by the door now, on two hooks, and holds still — `appliance-views.ts`
 * turns it to face into the room, which is a fact about the building rather
 * than about where anybody is standing. See `inward`.
 *
 * The wall it hangs on is the one wall the renderer never cuts down to a lip;
 * see `buildWalls`. Nothing here has to carry itself, which is why there is no
 * bracket and no post.
 *
 * Local axes: the wall is at -z, the room is at +z.
 */
function buildSign(parts: ApplianceParts, h: number): void {
  const group = parts.root;

  // Two hooks, just proud of the wall face, and the board hanging off them.
  for (const x of [-0.26, 0.26]) {
    const hook = mesh(torus(0.03, 0.01), PALETTE.signHook, "metal");
    hook.position.set(x, h - 0.14, -0.36);
    group.add(hook);
  }

  // Its own group, so `appliance-views.ts` can turn it over without touching
  // the hooks it hangs from.
  const board = new THREE.Group();
  board.position.set(0, h - 0.44, -0.36);
  group.add(board);
  parts.board = board;

  const frame = mesh(roundedBox(0.74, 0.56, 0.05, 0.03), PALETTE.woodDark, "wood");
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
function buildTable(group: THREE.Group, h: number, nudge: Jitter): void {
  const top = mesh(roundedCylinder(0.42, 0.07, 0.022), PALETTE.woodTop, "wood");
  top.position.y = h - 0.035;
  group.add(top);

  const stem = mesh(cylinder(0.07, 0.09, h), PALETTE.steelDark, "paintedMetal");
  stem.position.y = h / 2;
  group.add(stem);

  // A weighted base, filleted where it meets the floor: the pedestal is the one
  // thing holding the whole table up and it should look like it could.
  const foot = mesh(roundedCylinder(0.26, 0.055, 0.018), PALETTE.steelDark, "paintedMetal");
  group.add(foot);

  // One chair per side, tucked under the overhang so they never spill into a
  // neighbouring tile and confuse what is walkable.
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2;
    const chair = new THREE.Group();
    // Pushed back and turned a little, the way a chair that has been sat in is.
    // The four of them square to the table was the tell that nobody ever had.
    const out = 0.42 + nudge(i, 0.05);
    chair.position.set(Math.sin(angle) * out, 0, Math.cos(angle) * out);
    chair.rotation.y = angle + nudge(i + 4, 0.3);

    const seat = mesh(roundedBox(0.26, 0.05, 0.26, 0.02), PALETTE.wood, "wood");
    seat.position.y = h * 0.62;
    chair.add(seat);

    const back = mesh(roundedBox(0.26, 0.22, 0.04, 0.02), PALETTE.wood, "wood");
    back.position.set(0, h * 0.62 + 0.13, 0.11);
    chair.add(back);

    for (const [lx, lz] of CORNERS) {
      const leg = mesh(roundedCylinder(0.018, h * 0.62, 0.008, 10), PALETTE.woodDark, "wood");
      leg.position.set(lx * 0.1, 0, lz * 0.1);
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
  /** Meets the floor on its own terms, so no plinth is put under it. */
  grounded?: true;
  /**
   * Has cupboard doors on it. True of everything you would find under a
   * worktop, and false of the things whose faces are already doing a job — an
   * oven's glass, a fryer's body, a hatch standing in a wall.
   */
  cabinet?: true;
};

const APPLIANCE_LOOK: Record<Appliance["kind"], Look> = {
  // Enamel bodies for anything that would really be enamelled steel.
  // Built by `buildStall`, and labelled with a price rather than a name.
  stall: { body: [PALETTE.stallBody, "wood"] },
  // Built by `buildCardStand`, and labelled with whatever is on the card.
  cards: { body: [PALETTE.woodDark, "wood"] },
  // Built by `buildSign`. No contextual label: a sign that needs a label to say
  // what it is has failed at the only job it has.
  sign: { body: [PALETTE.woodDark, "wood"] },
  counter: { body: [PALETTE.wood, "wood"], top: [PALETTE.woodTop, "wood"], cabinet: true },
  // Worktop like the counter's, with a block let into it — see `addDetails`.
  // A chopping station is a counter you have put a board on, and a whole top in
  // board colours is a claim that the counter *is* the board.
  board: {
    body: [PALETTE.wood, "wood"],
    top: [PALETTE.woodTop, "wood"],
    label: "Chop",
    cabinet: true,
  },
  // An upgrade has to be tellable from its plain twin across the kitchen, so
  // each one changes *material* rather than shape: a steel top where the wood
  // was, dark enamel and brass where the oven is grey.
  steel_board: {
    body: [PALETTE.wood, "wood"],
    top: [PALETTE.woodTop, "wood"],
    label: "Chop (fast)",
    cabinet: true,
  },
  // No slab: a fryer's deck is a frame around a vat, and it is built with a
  // hole in it by `addDetails`.
  fryer: { body: [PALETTE.fryerBody, "enamel"], label: "Fryer" },
  oven: { body: [PALETTE.ovenBody, "enamel"], top: [PALETTE.ovenGlass, "enamel"], label: "Oven" },
  bell_oven: {
    body: [PALETTE.ovenBodyPro, "enamel"],
    top: [PALETTE.brass, "metal"],
    label: "Bell oven",
  },
  // Built by `buildCrate`, which is slats and gaps rather than a box with a top.
  crate: { body: [PALETTE.wood, "wood"] },
  // No top slab and no decorative crockery: what the stack is holding is drawn
  // by `item-views.ts`, because it is now a real, countable pile. An empty
  // plate stack has to *look* empty — that is the moment the whole feature
  // exists to create.
  plates: { body: [PALETTE.steel, "enamel"], label: "Plates", cabinet: true },
  sink: { body: [PALETTE.sinkBody, "enamel"], label: "Sink", cabinet: true },
  bin: { body: [PALETTE.bin, "enamel"], top: [PALETTE.steelDark, "enamel"], label: "Bin" },
  table: { body: [PALETTE.wood, "wood"], label: "Table" },
  // The serving hatch: a steel sill in a hole in the wall. Enamel and a steel
  // top rather than the timber of the counters beside it, so the one tile you
  // hand food through is the one tile that does not look like a worktop.
  // The one body that is not standing on the floor: it fills a hole in a wall,
  // and a plinth under it would be a plinth inside the wall.
  hatch: {
    body: [PALETTE.sinkBody, "enamel"],
    top: [PALETTE.steel, "metal"],
    label: "Hatch",
    grounded: true,
  },
};

/** Small silhouette details: this is what stops every appliance reading as a box. */
function addDetails(parts: ApplianceParts, appliance: Appliance, h: number, nudge: Jitter): void {
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
        // Just above the door, where a door's handle is. It used to float 9cm
        // clear of the top of the glass, bolted to nothing.
        handle.position.set(x * 0.49, h * 0.5 + 0.24, z * 0.49);
        handle.rotation.y = facing(x, z);
        group.add(handle);
      }
      break;
    }
    case "fryer": {
      // The deck is a frame with the vat's mouth cut out of it, and the oil sits
      // down inside rather than as a slab laid on the lid. A fryer is a hole
      // full of hot fat; drawing it as a surface was drawing the one appliance
      // that is defined by its recess as though it had none.
      const rail = deck(0.98, 0.66, PALETTE.ceramic);
      rail.position.y = h + 0.02;
      group.add(rail);

      const vat = mesh(roundedBox(0.64, 0.3, 0.64, 0.03), PALETTE.ovenGlass, "metal");
      vat.position.y = h - 0.14;
      group.add(vat);

      // Filled nearly to the deck. Sunk to the bottom of the vat, the oil was a
      // glint at the bottom of a dark slot, and hot fat you can see is the one
      // thing that says "fryer" from across a kitchen.
      const oil = mesh(roundedBox(0.62, 0.06, 0.62, 0.02), PALETTE.oil, "ceramic");
      // Own material instance so the oil can glow into the bloom pass.
      const glow = standardMaterial(oil).clone();
      glow.emissive.setHex(PALETTE.oil);
      // Brighter at rest than it was on the lid: down in a well it catches far
      // less of the sun, and what it cannot catch it has to make.
      glow.emissiveIntensity = 0.55;
      oil.material = glow;
      oil.position.y = h;
      group.add(oil);
      parts.oil = oil;
      parts.oilGlow = glow;

      // A control plate and its dial: the one body left in the room with no
      // cupboard doors still needs something on its face.
      for (const [x, z] of SIDES) {
        const plate = mesh(
          roundedBox(0.66, 0.15, 0.04, 0.02),
          shade(PALETTE.fryerBody, 0.84),
          "enamel",
        );
        plate.position.set(x * 0.465, h - 0.22, z * 0.465);
        plate.rotation.y = facing(x, z);
        group.add(plate);

        const knob = mesh(roundedCylinder(0.036, 0.035, 0.012, 14), PALETTE.brass, "metal");
        knob.position.set(x * 0.475, h - 0.22, z * 0.475);
        knob.rotation.z = z === 0 ? Math.PI / 2 : 0;
        knob.rotation.x = z === 0 ? 0 : Math.PI / 2;
        group.add(knob);
      }

      // A basket standing in one corner of the vat rather than filling it. The
      // first one was nearly as wide as the mouth, which turned the appliance
      // whose whole point is a pool of glowing oil back into a lid with a
      // saucepan on it.
      const basket = new THREE.Group();
      basket.position.set(0.15, h - 0.05, 0.15);
      const bowl = shellMesh(
        lathe("fryer-basket", [
          [0, 0],
          [0.1, 0],
          [0.14, 0.04],
          [0.155, 0.14],
        ]),
        PALETTE.steel,
        "metal",
      );
      basket.add(bowl);
      const lip = rim(0.155, 0.014, PALETTE.steelDark);
      lip.position.y = 0.14;
      basket.add(lip);
      const arm = mesh(
        sweep(
          "fryer-basket-arm",
          [
            [0.1, 0.12, 0.1],
            [0.22, 0.24, 0.22],
            [0.32, 0.27, 0.32],
          ],
          0.016,
        ),
        PALETTE.steel,
        "metal",
      );
      basket.add(arm);
      const hold = grip(0.14, 0.026, PALETTE.woodDark);
      hold.position.set(0.36, 0.27, 0.36);
      hold.rotation.y = -Math.PI / 4;
      basket.add(hold);
      group.add(basket);
      parts.basket = basket;
      break;
    }
    case "steel_board":
    case "board": {
      // The block itself, let into the worktop and standing a few millimetres
      // proud of it, with a hand hole at one end. Steel where the upgrade is
      // steel: an upgrade changes material, never shape.
      const steel = appliance.kind === "steel_board";
      const block = mesh(
        extruded(
          "chopping-block",
          (shape) => {
            roundedRect(shape, 0.62, 0.46, 0.05);
            const hole = new THREE.Path();
            hole.absarc(0.23, 0, 0.032, 0, Math.PI * 2, true);
            shape.holes.push(hole);
          },
          0.05,
          0.012,
        ),
        steel ? PALETTE.steel : PALETTE.boardTop,
        steel ? "metal" : "wood",
      );
      block.rotation.x = -Math.PI / 2;
      block.position.set(nudge(2, 0.05), h + 0.03, nudge(3, 0.05));
      // Put down at whatever angle the hand let go at.
      block.rotation.z = nudge(4, 0.16);
      group.add(block);

      // A little knife resting on the board reads instantly as "chop here".
      // It hangs off a pivot at the handle so it can be swung when chopping.
      const knife = new THREE.Group();
      knife.position.set(-0.24 + nudge(5, 0.04), h + 0.09, 0.22 + nudge(6, 0.04));
      knife.rotation.y = 0.25 + nudge(7, 0.3);

      const blade = mesh(roundedBox(0.34, 0.02, 0.09, 0.008), PALETTE.steel, "metal");
      blade.position.set(0.3, 0, 0.06);
      knife.add(blade);

      const handle = mesh(roundedBox(0.14, 0.035, 0.05, 0.015), PALETTE.woodDark, "wood");
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
      // A basin hanging under a hole in the deck, not a bowl balanced on top of
      // it. The recess is what stops the sink reading as another counter: the
      // one place in the kitchen where the surface goes *down*.
      const basin = mesh(roundedBox(0.68, 0.24, 0.68, 0.04), PALETTE.sinkBasin, "metal");
      basin.position.y = h - 0.1;
      group.add(basin);

      const surround = deck(0.98, 0.7, PALETTE.steel, "metal");
      surround.position.y = h + 0.02;
      group.add(surround);

      const water = mesh(roundedBox(0.64, 0.03, 0.64, 0.02), PALETTE.suds, "ceramic");
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
function buildCrate(parts: ApplianceParts, h: number, nudge: Jitter): void {
  const group = parts.root;

  // Runners, so the crate stands on the tile rather than growing out of it.
  for (const z of [-0.28, 0.28]) {
    const runner = mesh(roundedBox(0.84, 0.06, 0.14, 0.02), PALETTE.woodDark, "wood");
    runner.position.set(0, 0.03, z);
    group.add(runner);
  }

  // A step lighter than the frame it sits in: the tonal ladder the crate used
  // to get from three brown palette entries now comes from one.
  const floor = mesh(roundedBox(0.88, 0.06, 0.88, 0.02), shade(PALETTE.woodDark, 1.14), "wood");
  floor.position.y = 0.09;
  group.add(floor);

  const bedY = h * 0.84;
  const inner = mesh(roundedBox(0.8, bedY - 0.09, 0.8, 0.02), PALETTE.woodShadow, "wood");
  inner.position.y = (bedY + 0.09) / 2;
  group.add(inner);

  for (const [x, z] of CORNERS) {
    const stile = mesh(roundedBox(0.13, h, 0.13, 0.035), PALETTE.woodDark, "wood");
    stile.position.set(x * 0.4, h / 2, z * 0.4);
    group.add(stile);
  }

  // Three boards a side. The gaps are the point, so the slat is deliberately
  // thinner than the pitch between the rows.
  let slats = 0;
  for (const t of [0.22, 0.5, 0.78]) {
    for (const [x, z] of SIDES) {
      const slat = mesh(roundedBox(0.84, h * 0.17, 0.055, 0.02), PALETTE.wood, "wood");
      // Nailed on by hand: each board sits a fraction off its neighbours, which
      // is most of the difference between a crate and a lattice.
      const index = slats++;
      slat.position.set(x * 0.44, h * t + nudge(index, 0.02), z * 0.44);
      slat.rotation.set(nudge(index + 12, 0.03), facing(x, z), nudge(index + 24, 0.03));
      group.add(slat);
    }
  }

  // A rail round the mouth: it caps the stiles and gives the top edge the one
  // continuous line the slats never make.
  for (const [x, z] of SIDES) {
    const rail = mesh(roundedBox(0.96, 0.08, 0.11, 0.03), shade(PALETTE.woodDark, 1.14), "wood");
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

  // A base ring, so the taper meets the floor on a foot rather than dying into
  // it. The one place the bin was still extruded tile.
  const base = mesh(roundedCylinder(0.36, 0.04, 0.012, 20), PALETTE.steelDark, "metal");
  bin.add(base);

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
