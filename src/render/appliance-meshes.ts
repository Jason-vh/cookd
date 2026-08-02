import * as THREE from "three";
import { applianceDef } from "../data/appliances";
import { ingredient } from "../data/ingredients";
import type { Appliance, ApplianceKind, Item } from "../sim/types";
import { RECIPE_BY_ID } from "../data/recipes";
import { buildIngredientSample, buildProduceHeap } from "./models";
import { framedPhoto } from "./photo";
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
  box,
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
  /** Conveyor: the slats across the band, which scroll and wrap. */
  slats?: THREE.Object3D;
  /** Shop square: the pallet and everything on it, so the delivery can arrive. */
  pitch?: THREE.Object3D;
  /** Shop square: the pallet's planks alone, hidden for a delivery that stands up. */
  deck?: THREE.Object3D;
  /** Shop square: where the goods stand, restocked by `appliance-views.ts`. */
  counter?: THREE.Object3D;
  /** Crate: the mouth of it, where the heap of stock sits. */
  produce?: THREE.Object3D;
  /** Recipe card: the whole A-frame, so the delivery can animate it. */
  card?: THREE.Object3D;
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
  } else if (appliance.kind === "belt") {
    buildBelt(parts, h);
  } else if (appliance.kind === "stall") {
    buildPitch(parts, nudge);
  } else if (appliance.kind === "cards") {
    buildCard(parts, h, appliance.card);
  } else if (appliance.kind === "sign") {
    buildSign(parts, h);
  } else if (appliance.kind === "hopper") {
    buildHopper(parts, h);
  } else if (appliance.kind === "crate") {
    buildCrate(parts, h, nudge);
  } else if (appliance.kind === "table") {
    buildTable(root, h, nudge);
  } else if (def.fitting) {
    // No body, no worktop: a fitting is the thing you put *on* a worktop, and
    // this is only ever the one in somebody's hands or the one on the pallet.
    // Built at its own `height` so that the knife lands where `animateParts`
    // expects to find it, exactly as it does on a counter.
    const fitting = buildFitting(appliance.kind, appliance.id, h);
    root.add(fitting.root);
    parts.knife = fitting.knife;
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
    addDetails(parts, appliance, h);
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
 * A chopping board: the block, and the knife lying on it.
 *
 * Its own builder because it is drawn on two different things. A **fitting**
 * has no body of its own — what a board *is* is a block you put on a worktop —
 * so this is the whole of it, and the only difference between one in a chef's
 * hands and one on a counter is the height it is built at.
 *
 * `id` seeds the wobble, so a board keeps the angle it was put down at wherever
 * it is drawn. Returns the knife too: it swings with the chop, and whoever owns
 * the appliance's animation has to be able to reach it.
 */
export function buildFitting(
  kind: ApplianceKind,
  id: number,
  height: number,
): { root: THREE.Object3D; knife: THREE.Object3D } {
  const nudge = jitter(id);
  const group = new THREE.Group();

  // Steel where the upgrade is steel: an upgrade changes material, never shape.
  const steel = kind === "steel_board";
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
  block.position.set(nudge(2, 0.05), height + 0.03, nudge(3, 0.05));
  // Put down at whatever angle the hand let go at.
  block.rotation.z = nudge(4, 0.16);
  group.add(block);

  // A little knife resting on the board reads instantly as "chop here". It
  // hangs off a pivot at the handle so it can be swung when chopping.
  const knife = new THREE.Group();
  knife.position.set(-0.24 + nudge(5, 0.04), height + 0.09, 0.22 + nudge(6, 0.04));
  knife.rotation.y = 0.25 + nudge(7, 0.3);

  const blade = mesh(roundedBox(0.34, 0.02, 0.09, 0.008), PALETTE.steel, "metal");
  blade.position.set(0.3, 0, 0.06);
  knife.add(blade);

  const handle = mesh(roundedBox(0.14, 0.035, 0.05, 0.015), PALETTE.woodDark, "wood");
  handle.position.set(0.05, 0, 0.02);
  knife.add(handle);
  group.add(knife);

  return { root: group, knife };
}

/**
 * A pallet on the paving, with whatever is for sale standing on it — the goods
 * themselves are put there by `appliance-views.ts`, because they change every
 * morning.
 *
 * **There is no shop.** This was a market stall, and then a caravan, and both
 * had the same thing wrong with them: they were a structure that existed only
 * because the game needed somewhere to put a price. What a player walks up to
 * now is the *goods* themselves — an oven, a table, a crate — so nothing
 * stands outside the kitchen that the world does not already contain.
 *
 * Which leaves the shop one thing to draw, and a pallet is about the least a
 * delivery can stand on: it says *this was dropped off* rather than *this is a
 * display*, it gives a lone plate something to sit on instead of a bare slab,
 * and an empty one is how a square says the morning's delivery has already
 * been carried inside.
 *
 * The rule underneath it all is one the game has always enforced and never
 * used to say anything with: **nothing may be placed on the paving**, so
 * anything standing out here is not yours yet.
 */
function buildPitch(parts: ApplianceParts, nudge: Jitter): void {
  const pallet = new THREE.Group();
  // Put down by hand, like everything else in this game — see `wobble.ts`.
  pallet.rotation.y = nudge(1, 0.22);
  parts.root.add(pallet);
  // The whole delivery hangs off this one group, pallet and goods together, so
  // that arriving and being collected is one thing moving rather than a pallet
  // and a crate agreeing to move at the same time. `place()` owns the root.
  parts.pitch = pallet;

  // Three bearers across, five boards along: the shape everybody recognises,
  // and the gaps between the boards are what make it read as one rather than
  // as a plank.
  //
  // Its own group inside the pallet, because one delivery does not come on a
  // pallet: a recipe card is a sandwich board, and a sandwich board standing on
  // a pallet reads as one nobody unpacked. Hiding the deck leaves the goods
  // spot and the arrival animation exactly where they were.
  const planks = new THREE.Group();
  pallet.add(planks);
  parts.deck = planks;
  for (const x of [-0.34, 0, 0.34]) {
    const bearer = mesh(roundedBox(0.14, 0.07, 0.82, 0.02), PALETTE.woodShadow, "wood");
    bearer.position.set(x, 0.035, 0);
    planks.add(bearer);
  }
  for (let i = 0; i < 5; i++) {
    const board = mesh(roundedBox(0.86, 0.04, 0.13, 0.015), PALETTE.woodDark, "wood");
    board.position.set(0, 0.09, -0.34 + i * 0.17);
    planks.add(board);
  }

  // Where the goods stand: an empty group, because what is on this pallet
  // changes every morning and the shape of it belongs to whoever knows what the
  // offer is. A child of the pallet, so a crate put down crooked is crooked
  // *with* the thing it was put down on.
  const spot = new THREE.Group();
  spot.position.y = PITCH_DECK;
  spot.rotation.y = nudge(2, 0.3);
  pallet.add(spot);
  parts.counter = spot;
}

/** The top of a pallet: where the goods stand, and where their price sits over. */
export const PITCH_DECK = 0.11;

/**
 * A recipe poster, pasted on the outside wall beside the door.
 *
 * The card stand was an easel of its own standing on the paving — one more
 * object in a scene that already had too many. A poster hangs on a wall the
 * building already has, so it costs the world nothing: **mounted**, like the
 * sign, which means the square in front of it is still paving anybody may walk
 * across.
 *
 * The board is always there and the paper is not. Whether there is a decision
 * to make is legible from across the patio, which is the same grammar the
 * goods use: a bare square means nothing to buy, a bare board means nothing to
 * choose.
 */
/**
 * A recipe card: an A-frame board with a photograph of the dish on it.
 *
 * Three goes at this. It was an easel, then a poster pasted flat on the outside
 * of the shell, then — once a card became a good rather than furniture — a page
 * hovering at knee height with nothing holding it up. All three had the same
 * fault the market stall had: an object invented to hold an offer.
 *
 * A **sandwich board** is the thing a restaurant already owns for this. Two
 * panels hinged at the top and splayed at the bottom, standing on their own
 * feet on the paving, which is why it is also the one delivery that arrives
 * without a pallet under it.
 *
 * **Printed on both faces**, and for the reason the sign by the door is: the
 * camera turns to any of four corners, so half the time the player would be
 * looking at the back of it.
 *
 * **No lettering anywhere on it.** At the followed camera a panel is about 40
 * pixels across and at the wide framing about 20, so any text on it would be a
 * texture that looks like writing rather than something anybody reads — and the
 * label that appears when a chef faces it is already the readable copy. What a
 * board carries is a picture, which is legible at both sizes because a picture
 * is what an icon is.
 */
function buildCard(parts: ApplianceParts, h: number, id: string | null): void {
  const board = new THREE.Group();
  parts.root.add(board);
  parts.card = board;

  const recipe = id === null ? null : RECIPE_BY_ID.get(id);
  const dish: Item | null = recipe
    ? { id: -1, base: recipe.dish.base, processes: [...recipe.dish.processes], contents: [] }
    : null;

  // The splay is the whole silhouette: two leaves at this angle read as a
  // sandwich board from any side, where one leaf reads as a page whatever is
  // drawn on it.
  //
  // **Each leaf hangs from the ridge.** The group's origin is the hinge, the
  // panel hangs below it, and the rotation swings the *foot* out — which is how
  // the hinge works on the real thing. Rotating a centred panel instead splays
  // it from the middle, so the two leaves come apart at the top and the board
  // stands on its own ridge, upside down.
  const lean = 0.19;
  const panelH = h * 0.95;
  const panelW = 0.52;
  const thickness = 0.035;
  for (const side of [1, -1]) {
    const leaf = new THREE.Group();
    leaf.position.y = h;
    leaf.rotation.x = side * lean;
    board.add(leaf);

    const panel = mesh(roundedBox(panelW, panelH, thickness, 0.015), PALETTE.wood, "wood");
    panel.position.y = -panelH / 2;
    leaf.add(panel);

    if (!dish) continue;
    // A leaf leaning one way has its outward face on that side, and the print
    // goes on the face somebody can see. Proud of the panel by a hair, so it
    // reads as pinned on rather than inlaid.
    const print = framedPhoto(dish, panelW * 0.86, panelH * 0.78);
    print.position.set(0, -panelH / 2, side > 0 ? -(thickness / 2 + 0.002) : thickness / 2 + 0.002);
    print.rotation.y = side > 0 ? Math.PI : 0;
    leaf.add(print);
  }

  // The hinge, and the feet. Both are what a board is *made of* rather than
  // decoration: the batten is the thing the two leaves turn on, and without
  // feet the panels end in a line and the board looks buried.
  const hinge = mesh(roundedBox(panelW * 0.94, 0.055, 0.07, 0.025), PALETTE.woodDark, "wood");
  hinge.position.y = h;
  board.add(hinge);
  const spread = Math.sin(lean) * panelH;
  for (const side of [1, -1]) {
    const foot = mesh(roundedBox(panelW, 0.05, 0.08, 0.02), PALETTE.woodDark, "wood");
    foot.position.set(0, 0.025, -side * spread);
    board.add(foot);
  }
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
 * and is the right call here: the camera turns to any of four corners, and from
 * the two behind this wall you are looking at the back of the board. A player
 * being told the opposite of the truth by the back of a sign is worse than a
 * sign that is legible from everywhere and slightly impossible.
 *
 * It used to stand on a post in the middle of its tile and spin to face the
 * camera. Both halves of that were wrong: a lamp post is not what a shop sign
 * is, and a sign that turns to follow you is a billboard. It hangs flat on the
 * wall by the door now, on two hooks, and holds still — `appliance-views.ts`
 * turns it to face into the room, which is a fact about the building rather
 * than about where anybody is standing. See `inward`.
 *
 * The wall it hangs on is the one wall the renderer never cuts down to a lip;
 * see `addWalls`. Nothing here has to carry itself, which is why there is no
 * bracket and no post.
 *
 * Local axes: the wall is at -z, the room is at +z.
 */
function buildSign(parts: ApplianceParts, h: number): void {
  const group = parts.root;

  // Two hooks, sitting on the board's top edge rather than through it.
  for (const x of [-0.26, 0.26]) {
    const hook = mesh(torus(0.03, 0.01), PALETTE.signHook, "metal");
    hook.position.set(x, h - 0.13, -0.36);
    group.add(hook);
  }

  // Its own group, so `appliance-views.ts` can pop it without touching the
  // hooks it hangs from.
  const board = new THREE.Group();
  board.position.set(0, h - 0.44, -0.36);
  group.add(board);
  parts.board = board;

  const frame = mesh(roundedBox(0.74, 0.56, 0.05, 0.03), PALETTE.woodDark, "wood");
  board.add(frame);

  // One material per face, both repainted together: the two faces exist so the
  // board has thickness, not so they can disagree. The back is turned about y,
  // so the word on it reads the right way up from the corners that see it.
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
 * a sprite: a sprite always faces the camera, and a sign screwed to a wall has
 * to be able to show you its back.
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
  // Built by `buildPitch`, which draws a pallet and nothing else: what stands
  // on it is the appliance for sale, near enough full size. Labelled with a
  // price rather than a name.
  stall: { body: [PALETTE.woodDark, "wood"] },
  // Built by `buildCard`: an A-frame in the kitchen's own timber, carrying a
  // photograph of the dish. Labelled with the recipe card a chef can read.
  cards: { body: [PALETTE.wood, "wood"] },
  // Built by `buildSign`. No contextual label: a sign that needs a label to say
  // what it is has failed at the only job it has.
  sign: { body: [PALETTE.woodDark, "wood"] },
  counter: { body: [PALETTE.wood, "wood"], top: [PALETTE.woodTop, "wood"], cabinet: true },
  // Built by `buildBelt`: a frame you can see under, not a cabinet. Labelled,
  // because unlike a counter it has a rule a chef has to learn.
  belt: { body: [PALETTE.beltBand, "enamel"], label: "Conveyor" },
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
  // Built by `buildHopper`: a funnel on legs with a chute out over the tile in
  // front. Like a crate, its contextual label is overridden by what it holds.
  hopper: { body: [PALETTE.ovenBody, "enamel"] },
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
    case "board":
      // A board is drawn by `buildFitting`, because it is drawn in two places:
      // in a chef's hands, and on top of whatever counter it has been set on.
      break;
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
 * A hopper: a funnel on legs, with a chute out over the tile it faces.
 *
 * The **chute** is the whole of the design. A funnel on its own is a container,
 * and this is not a container — it holds nothing at all. It is a mouth over one
 * tile and a spout over the next, and which way it runs is the thing a player
 * has to be able to read from across the kitchen. The chute overhangs the tile
 * edge deliberately: the food it drops has to look like it came out of
 * something rather than appearing on the belt.
 *
 * Nothing is drawn *in* it, and that is the model telling the truth: what comes
 * out of a hopper belongs to the crate standing behind it.
 *
 * Built pointing along local **+z**, like the conveyor, and turned to its `dir`
 * by `appliance-views.ts`.
 */
function buildHopper(parts: ApplianceParts, h: number): void {
  const group = parts.root;
  const standH = h * 0.44;

  for (const [x, z] of CORNERS) {
    const leg = mesh(roundedCylinder(0.032, standH, 0.012, 10), PALETTE.steelDark, "metal");
    leg.position.set(x * 0.3, 0, z * 0.3);
    group.add(leg);
  }

  // The funnel: wide at the mouth, narrow where it meets the chute. A cone is
  // the one silhouette that says "this empties downward" without a label.
  const bodyH = h - standH;
  const funnel = mesh(cylinder(0.4, 0.15, bodyH, 20), PALETTE.ovenBody, "enamel");
  funnel.position.y = standH + bodyH / 2;
  group.add(funnel);

  const lip = rim(0.4, 0.03, PALETTE.steel);
  lip.position.y = h;
  group.add(lip);

  // A band round the waist, where the taper is steepest: without it the cone
  // reads as a paper cup.
  const band = mesh(cylinder(0.29, 0.29, 0.04, 20), PALETTE.brass, "metal");
  band.position.y = standH + bodyH * 0.45;
  group.add(band);

  const chute = mesh(roundedBox(0.3, 0.05, 0.44, 0.02), PALETTE.steel, "metal");
  chute.position.set(0, standH + 0.04, 0.32);
  // Positive tilts the far end down, which is the end the food leaves by.
  chute.rotation.x = 0.38;
  group.add(chute);

  // A mouth on the back, over the tile it draws from: the other end of the
  // chute, and the half of the silhouette that says this machine has a behind
  // as well as a front.
  const mouth = mesh(roundedBox(0.3, 0.05, 0.34, 0.02), PALETTE.steel, "metal");
  mouth.position.set(0, standH + bodyH * 0.62, -0.3);
  mouth.rotation.x = -0.42;
  group.add(mouth);
}

/**
 * A conveyor: a band between two rollers, on legs.
 *
 * **On legs, and open underneath.** Everything else in this kitchen is a solid
 * body standing on the floor, so daylight under the frame is most of what says
 * this is a machine rather than another worktop — the silhouette does the work
 * before the colour gets a chance to.
 *
 * The **rollers** are the other half of that, and they are what tell you which
 * way it goes when it is standing empty and the slats are not moving: a belt
 * with its ends showing has an axis, and an axis is a direction.
 *
 * Built running along local **+z**, which `appliance-views.ts` turns to the
 * belt's own direction — the same trick the sign uses to face into the room.
 */
function buildBelt(parts: ApplianceParts, h: number): void {
  const group = parts.root;
  const deckY = h - 0.06;

  for (const [x, z] of CORNERS) {
    const leg = mesh(roundedCylinder(0.03, deckY - 0.05, 0.012, 10), PALETTE.steelDark, "metal");
    leg.position.set(x * 0.34, 0, z * 0.32);
    group.add(leg);
  }

  // Side rails, running the length of it: the band is held between them, and
  // they are what stops a tomato rolling off sideways.
  for (const x of [-1, 1]) {
    const rail = mesh(roundedBox(0.07, 0.1, 0.98, 0.025), PALETTE.steel, "metal");
    rail.position.set(x * 0.42, deckY, 0);
    group.add(rail);
  }

  const band = mesh(roundedBox(0.76, 0.08, 0.92, 0.025), PALETTE.beltBand, "enamel");
  band.position.y = deckY;
  group.add(band);

  for (const z of [-1, 1]) {
    const roller = mesh(cylinder(0.056, 0.056, 0.78, 14), PALETTE.steel, "metal");
    roller.rotation.z = Math.PI / 2;
    roller.position.set(0, deckY, z * 0.46);
    group.add(roller);
  }

  // The slats, which are the whole of the motion: a moving belt with a plain
  // surface is a still belt, whatever the simulation thinks. Plain boxes rather
  // than bevelled ones — at 12mm thick a fillet costs 588 triangles to render
  // nothing. See `box`.
  const slats = new THREE.Group();
  slats.position.y = deckY + 0.045;
  group.add(slats);
  parts.slats = slats;
  for (let i = 0; i < BELT_SLATS; i++) {
    const slat = mesh(box(0.72, 0.014, 0.05), shade(PALETTE.beltBand, 1.7), "enamel");
    slat.position.z = beltSlatZ(i);
    slats.add(slat);
  }
}

/** How many slats there are, and the length of band they are spread over. */
export const BELT_SLATS = 6;
export const BELT_RUN = 0.9;

/** Where slat `i` sits along the band, before it is scrolled. */
export function beltSlatZ(i: number): number {
  return -BELT_RUN / 2 + (i / BELT_SLATS) * BELT_RUN;
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
