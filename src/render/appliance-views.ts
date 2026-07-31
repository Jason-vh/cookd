import * as THREE from "three";
import { applianceDef } from "../data/appliances";
import { RECIPE_BY_ID } from "../data/recipes";
import type { Appliance, Offer, Recipe, World } from "../sim/types";
import { playerById } from "../sim/world";
import { inward, outward } from "../sim/walls";
import { deliveryLabel, missingFor } from "../sim/cards";
import {
  canPlace,
  reachedTile,
  targetTile,
  unreachableAppliances,
  unreachableTables,
} from "../sim/queries";
import { offerLabel, offerPrice } from "../sim/shop";
import { chopLift, ease, workPhase } from "./anim";
import { setGlow } from "./glow";
import { Dial } from "./dial";
import { disposeSubtree } from "./dispose";
import { setGhost, setGhostOpacity } from "./ghost";
import {
  buildAppliance,
  paintSign,
  PITCH_DECK,
  type ApplianceParts,
  type SignFace,
} from "./appliance-meshes";
import { buildIngredientSample, buildItemModel } from "./models";
import { buildHighlight } from "./overlay-meshes";
import { PALETTE } from "./palette";
import { makeCardLabel, makeLabel } from "./sprites";

/**
 * Everything that draws an appliance: its mesh, its dial, its moving parts, and
 * the ghost that previews where a held one would land.
 *
 * Split out of `View`, which had grown to 1074 lines and owned this alongside
 * chef rigs, customer rigs, tables, items, highlights, effect cues, lighting
 * and the camera. Every one of those is the same shape — a `Map` keyed by
 * simulation id, with add, remove and update — so each is a module rather than
 * another two hundred lines in the same class.
 */

/** Per-appliance animation state that has no home in the simulation. */
type Visual = ApplianceParts & {
  dial: Dial;
  /** Eased dial fade and completion flash. */
  dialAlpha: number;
  dialFlash: number;
  /** How far the bin lid is still flipped open, 1..0. */
  binOpen: number;
  /** How much of the delivery has arrived on this square, 0..1. See `syncStall`. */
  presence: number;
  /**
   * What this stall slot is currently *showing*, as a string.
   *
   * The goods on the counter and the price above them are built from the offer,
   * so they have to be rebuilt when it changes — which is three times a
   * morning, not sixty times a second. Comparing a key is how we tell the
   * difference.
   */
  offerKey: string;
  /**
   * What this card stand is currently showing: the recipe, and what it would
   * have delivered. Both are on the key because the second changes without the
   * first — buy the oven yourself and the card stops promising you one.
   */
  cardKey: string;
  /** How far the card is lifted while somebody is considering it, 0..1. */
  armed: number;
  /** What the sign says, and the pop as it changes. 1..0. */
  signFace: SignFace;
  signPop: number;
  /** A refused purchase, flashing the price red. 1..0. */
  refused: number;
  /** Ring shown when nobody can walk to this. Built the first time it is needed. */
  warning?: THREE.Mesh;
  /** Placement ghost: eased position, fade, and the pop when it lands. */
  ghost: { alpha: number; x: number; z: number; pop: number; held: boolean };
};

export class ApplianceViews {
  private readonly visuals = new Map<number, Visual>();

  /** Appliances nobody can walk to, and the layout that answer was computed for. */
  private stranded = new Set<number>();
  private strandedFor = -1;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
  ) {}

  /** The object an appliance is drawn as, for things that hang off it. */
  root(id: number): THREE.Object3D | undefined {
    return this.visuals.get(id)?.root;
  }

  /** Show this appliance's contextual name for one frame. */
  showLabel(id: number): void {
    const label = this.visuals.get(id)?.label;
    if (label) label.visible = true;
  }

  /**
   * Light up the appliance a chef is pointing at.
   *
   * Cleared for everything at the top of every frame and re-asserted here, the
   * same way the contextual label works: whoever is pointing says so once a
   * frame, and nothing has to remember to stop pointing.
   */
  highlight(id: number, color: number): void {
    const visual = this.visuals.get(id);
    if (visual) setGlow(visual.root, color);
  }

  /** A bin had something thrown in it: flip the lid. */
  openBin(id: number): void {
    const visual = this.visuals.get(id);
    if (visual) visual.binOpen = 1;
  }

  /**
   * The stall said no: flash the price.
   *
   * A refusal has to be *seen*, not only logged. The player is looking at the
   * slot — that is how they got here — so the answer belongs on the slot, and
   * the log line is the detail rather than the notification.
   */
  refuse(id: number): void {
    const visual = this.visuals.get(id);
    if (visual) visual.refused = 1;
  }

  sync(world: World, dt: number, time: number): void {
    // Appliances can vanish: a reset renumbers the kitchen, and online the
    // server can hand us a completely different layout. Meshes for ids that no
    // longer exist have to go, or they hang in the scene forever.
    for (const [id, visual] of this.visuals) {
      if (world.appliances.has(id)) continue;
      this.release(visual);
      this.visuals.delete(id);
    }

    this.syncStranded(world);

    for (const appliance of world.appliances.values()) {
      let visual = this.visuals.get(appliance.id);
      if (!visual) {
        visual = this.create(appliance, world);
        this.visuals.set(appliance.id, visual);
      }

      this.place(world, appliance, visual, dt, time);
      this.syncWarning(appliance, visual, time);

      // Labels are off by default and turned on for one frame by whoever is
      // pointing at this appliance — see `showLabel` and `highlight`.
      if (visual.label) visual.label.visible = false;
      setGlow(visual.root, null);

      const phase = workPhase(appliance.motion, appliance.id, time);
      this.animateParts(appliance, visual, phase, dt);
      this.syncDial(appliance, visual, dt, time);
      if (appliance.kind === "stall") this.syncStall(world, appliance, visual, dt);
      if (appliance.kind === "cards") this.syncCards(world, appliance, visual, dt, time);
      if (appliance.kind === "sign") this.syncSign(world, appliance, visual, dt);
    }
  }

  /**
   * Everything nobody can walk to: tables the door cannot reach, and appliances
   * the chefs cannot.
   *
   * Two questions with one answer on screen, deliberately. A player looking at
   * a pulsing ring is being told "this will not work tomorrow", and which side
   * of the pass the wall is on is the log line's business, not the room's.
   *
   * Keyed on `layoutVersion`, so the two flood fills run when an appliance
   * moves rather than once a frame — and they run *the instant* it moves, which
   * is exactly when the answer can change.
   */
  private syncStranded(world: World): void {
    if (world.phase !== "build") {
      if (this.stranded.size > 0) this.stranded.clear();
      this.strandedFor = -1;
      return;
    }
    if (world.layoutVersion === this.strandedFor) return;
    this.strandedFor = world.layoutVersion;
    this.stranded = new Set(
      [...unreachableTables(world), ...unreachableAppliances(world)].map(
        (appliance) => appliance.id,
      ),
    );
  }

  /**
   * The ring over an appliance nobody can reach.
   *
   * Built lazily: it is the rarest thing in the kitchen, and a mesh per
   * appliance standing invisible forever is a cost every healthy room would pay
   * for a mistake most never make. Once built it stays — whoever walled it in
   * is about to walk over and unwall it.
   */
  private syncWarning(appliance: Appliance, visual: Visual, time: number): void {
    const show = appliance.heldBy === null && this.stranded.has(appliance.id);
    if (!show) {
      if (visual.warning) visual.warning.visible = false;
      return;
    }
    if (!visual.warning) {
      // Same red as a burning pan: this needs you. Above the top rather than on
      // the floor, where the appliance's own footprint hides most of the ring —
      // a poor showing for the one marker that means "this will not work
      // tomorrow".
      const ring = buildHighlight(PALETTE.progressBurn);
      ring.position.y = applianceDef(appliance.kind).height + 0.14;
      ring.scale.setScalar(1.15);
      visual.root.add(ring);
      visual.warning = ring;
    }
    visual.warning.visible = true;
    ringMaterial(visual.warning).opacity = 0.62 + Math.sin(time * 5) * 0.3;
  }

  /**
   * Dress a recipe board: the dish on the card, what the card says, and the
   * lift that means somebody is about to choose it.
   *
   * The board is bolted to the caravan either way. What comes and goes is the
   * paper on it, which is the same grammar as the hatch: whether there is a
   * decision to make is legible from across the grass.
   */
  private syncCards(
    world: World,
    appliance: Appliance,
    visual: Visual,
    dt: number,
    time: number,
  ): void {
    // Pasted flat on the outside of the shell, facing whoever walks up to it.
    // The same rule the sign uses on the inside face of the same wall, and for
    // the same reason: which wall a poster is on is a fact about the building,
    // not about where the camera happens to be.
    const face = outward(world.room, appliance.tile);
    visual.root.rotation.y = Math.atan2(face.x, face.y);

    // Cards are a morning thing. A day opening takes them with it, and the
    // simulation agrees — `beginDay` clears them — but the phase is what the
    // renderer can see first, on the very frame it changes.
    const id = world.phase === "build" ? appliance.card : null;
    const recipe = id === null ? undefined : RECIPE_BY_ID.get(id);
    // What it needs is asked of the world, so it answers for *this* kitchen and
    // stops promising an oven the moment the room buys one.
    const needs = recipe ? deliveryLabel(missingFor(world, recipe)) : "";
    const key = recipe ? `${recipe.id}|${needs}` : "";
    if (key !== visual.cardKey) {
      visual.cardKey = key;
      this.dressCard(appliance, visual, recipe, needs);
    }
    if (visual.card) visual.card.visible = recipe !== undefined;

    // Armed: the card lifts off the board and sways, so a second player across
    // the pitch can see a choice being made before it is made. Lifted *within*
    // its mount, which is what puts the board's own height and lean in the
    // builder rather than half here and half there.
    const target = appliance.armedBy !== null && recipe ? 1 : 0;
    visual.armed += (target - visual.armed) * ease(12, dt);
    if (visual.card) {
      visual.card.position.set(0, visual.armed * 0.24, visual.armed * 0.1);
      visual.card.rotation.z = Math.sin(time * 3.4) * 0.05 * visual.armed;
      visual.card.scale.setScalar(1 + visual.armed * 0.08);
    }
  }

  /** Repaint the sign when the restaurant opens or closes. See `signFaceOf`. */
  private syncSign(world: World, appliance: Appliance, visual: Visual, dt: number): void {
    // Faces into the room off the wall it is bolted to, and stays there. It used
    // to turn to face the camera like the card stand does — but a card stand is
    // a thing on an easel that somebody could reasonably have swivelled, and a
    // sign screwed to a wall is not. It can hold still because both of its faces
    // say the same thing, so there is no angle it becomes unreadable from.
    const face = inward(world.room, appliance.tile);
    visual.root.rotation.y = Math.atan2(face.x, face.y);

    // Repainted where it hangs, on the frame it changes.
    //
    // It used to turn over, and every version of that looked wrong once the
    // sign was on a wall rather than swinging in a doorway: rotating it about
    // its middle is a board passing through the masonry, lifting it clear first
    // is a sign taking itself off its hooks, and squashing its width reads as
    // the thing *inverting* rather than turning. All three were animating the
    // mechanism instead of the news.
    //
    // The news is the colour: a green board where a red one was, which the eye
    // catches across a room without being asked to. It gets the pop the chefs
    // get when what they are holding changes — the same idiom, so a state change
    // in the kitchen always reads the same way.
    const showing = signFaceOf(world);
    if (showing !== visual.signFace) {
      visual.signFace = showing;
      visual.signPop = 1;
      if (visual.boardFaces) paintSign(visual.boardFaces, showing);
    }
    if (visual.signPop <= 0) return;

    visual.signPop = Math.max(0, visual.signPop - dt * 4);
    const pop = visual.signPop * visual.signPop;
    visual.board?.scale.set(1 + 0.12 * pop, 1 + 0.12 * pop, 1);
  }

  /** Put a recipe on the card: its dish, and everything the card promises. */
  private dressCard(
    appliance: Appliance,
    visual: Visual,
    recipe: Recipe | undefined,
    needs: string,
  ): void {
    const art = visual.cardArt;
    if (art) {
      const old = art.children.slice();
      art.clear();
      for (const child of old) disposeSubtree(child);
      if (recipe) {
        // The dish itself, at a third scale — the same object the plate will
        // carry, for the same reason the stall shows a real fryer.
        const dish = buildItemModel({
          id: -1,
          base: recipe.dish.base,
          processes: [...recipe.dish.processes],
          contents: [],
        });
        dish.scale.setScalar(0.62);
        art.add(dish);
      }
    }

    if (visual.label) {
      visual.root.remove(visual.label);
      disposeSubtree(visual.label);
      visual.label = undefined;
    }
    if (!recipe) return;
    // Name, reward, steps, requirements — the whole card, read only when a chef
    // is standing in front of it. See `makeCardLabel`.
    const label = makeCardLabel([
      `${recipe.name}  +$${recipe.reward}`,
      recipe.steps.join(" \u2192 "),
      needs ? `needs: ${needs}` : "",
    ]);
    label.position.y = applianceDef(appliance.kind).height + 0.5;
    label.visible = false;
    visual.root.add(label);
    visual.label = label;
  }

  private create(appliance: Appliance, world: World): Visual {
    const parts = buildAppliance(appliance);
    // A sign is built closed, so a kitchen joined mid-service would otherwise
    // play its opening turn as a welcome to somebody who has arrived late.
    const signFace = signFaceOf(world);
    if (parts.boardFaces && signFace === "open") paintSign(parts.boardFaces, signFace);
    const dial = new Dial(this.camera);
    dial.object.position.y = applianceDef(appliance.kind).height + 0.72;
    parts.root.add(dial.object);
    this.scene.add(parts.root);
    return {
      ...parts,
      dial,
      dialAlpha: 0,
      dialFlash: 0,
      binOpen: 0,
      // Starts absent and arrives on the first frame of a morning, so a client
      // joining mid-service does not watch three deliveries fly away.
      presence: 0,
      offerKey: "",
      cardKey: "",
      armed: 0,
      refused: 0,
      signFace,
      signPop: 0,
      ghost: { alpha: 0, x: 0, z: 0, pop: 0, held: false },
    };
  }

  /**
   * Stand this morning's delivery on its square, and price it.
   *
   * The goods are a **real, full-size instance of the appliance**, because the
   * thing you are about to buy and the thing that will be standing in your
   * kitchen are the same object and there is no reason to draw two of them. It
   * costs one `buildAppliance` per square per morning.
   *
   * Everything vanishes when the day opens — the pallet with it — so the
   * paving is bare all through service and there is no closed shop to draw. A
   * delivery that has not been carried in by opening time was collected, which
   * is both the truth about the simulation (the slots re-roll overnight) and
   * the reason nothing out here needs a shutter.
   */
  private syncStall(world: World, appliance: Appliance, visual: Visual, dt: number): void {
    const open = world.phase === "build";

    // The delivery is set down in the morning and collected when the day opens,
    // and both are worth *seeing*: three things blinking into existence is the
    // one move a diorama may not make, and it is also the only cue a player
    // gets that the shop has closed. It drops the last half-metre and settles
    // with the squash the chefs get when what they are holding changes, then
    // lifts and stretches away again — one idiom, played backwards.
    //
    // **Arriving and leaving are not the same event, so they are not the same
    // motion.** A delivery is set down square by square, so the rate carries a
    // wobble seeded from the square's own id and the three land a beat apart.
    // Opening the restaurant is one moment — the same keypress for all of them
    // — so they go together, and briskly: a slow exit is the shop asking for
    // attention at exactly the point the day is asking for it instead.
    //
    // Applied to the pallet group rather than the root, because `place()`
    // writes the root's position every frame.
    // Arriving is eased, because an ease *settles* — it is the right curve for
    // something being put down. Leaving is **linear**, because an ease never
    // actually arrives: the tail of it left a full-size pallet hanging at the
    // top of its lift for the best part of a second, having visibly stopped
    // moving, waiting for a number to get small enough to hide it.
    if (open) {
      visual.presence += (1 - visual.presence) * ease(7 + (appliance.id % 5) * 0.9, dt);
    } else {
      visual.presence = Math.max(0, visual.presence - dt * 3.6);
    }

    const pitch = visual.pitch;
    if (pitch) {
      const away = 1 - visual.presence;
      // And it shrinks out over the last half of the trip, so the moment it
      // stops moving is the moment it is gone rather than a cut a frame later.
      const grow = Math.min(1, visual.presence * 2);
      pitch.visible = visual.presence > 0.002;
      pitch.position.y = away * away * 0.75;
      pitch.scale.set(grow * (1 + 0.1 * away), grow * (1 - 0.16 * away), grow * (1 + 0.1 * away));
    }

    // A square that has handed something out today is empty, whatever it still
    // remembers being worth — the same rule the simulation applies. Not gated
    // on the phase, though: what is standing here has to *ride the pallet out*
    // at opening rather than evaporating off it as it goes.
    const offer = appliance.taken === null ? appliance.offer : null;
    // The price is the half that is gated, because a label on a shop that has
    // closed is a price nobody may pay. `open` is on the key so that closing
    // rebuilds the label without rebuilding the goods.
    const key = offer ? `${offerKeyOf(offer)}|${open}` : "";
    if (key !== visual.offerKey) {
      visual.offerKey = key;
      this.restock(visual, offer, open);
    }

    // Red for as long as the refusal is worth noticing, then back to white.
    // Rebuilding the sprite is what it costs, which is why it is gated on the
    // flash actually being over rather than eased every frame.
    if (visual.refused > 0) {
      const was = visual.refused;
      visual.refused = Math.max(0, visual.refused - dt * 1.6);
      if (was === 1 || (visual.refused === 0 && offer)) {
        this.priceLabel(visual, offer, visual.refused > 0);
      }
    }
  }

  /** Stand this morning's goods on the square, and their price over them. */
  private restock(visual: Visual, offer: Offer | null, sellable: boolean): void {
    const counter = visual.counter;
    if (counter) {
      // Detached first, then freed: `clear()` mutates the array being walked.
      const old = counter.children.slice();
      counter.clear();
      for (const child of old) disposeSubtree(child);
      if (offer) counter.add(goodsModel(offer));
    }
    this.priceLabel(visual, sellable ? offer : null, false);
  }

  private priceLabel(visual: Visual, offer: Offer | null, refused: boolean): void {
    if (visual.label) {
      visual.root.remove(visual.label);
      disposeSubtree(visual.label);
      visual.label = undefined;
    }
    if (!offer) return;
    const sprite = makeLabel(
      `${offerLabel(offer)}  $${offerPrice(offer)}`,
      refused ? PALETTE.progressBurn : 0xffffff,
    );
    // Over the goods rather than over the square, because the goods are what is
    // standing here: a plate needs the label at plate height and an oven needs
    // it a foot higher. This is the whole of the shop's signage — contextual,
    // like every other appliance's name, and shown only to a chef facing it.
    sprite.position.y = offerHeight(offer) + 0.98;
    sprite.visible = false;
    visual.root.add(sprite);
    visual.label = sprite;
  }

  private release(visual: Visual): void {
    visual.dial.dispose();
    disposeSubtree(visual.root);
  }

  /** Free every appliance visual. Used when the whole view goes away. */
  dispose(): void {
    for (const visual of this.visuals.values()) this.release(visual);
    this.visuals.clear();
  }

  /**
   * The parts that move: a knife swinging with the chop, oil boiling, oven
   * glass glowing, a bin lid falling shut.
   *
   * Fryers and ovens work unattended, so they have to advertise it themselves —
   * the dial only shows when you are stood there.
   */
  private animateParts(appliance: Appliance, visual: Visual, phase: number, dt: number): void {
    const height = applianceDef(appliance.kind).height;

    if (visual.knife) {
      // The knife swings with the chop, on the same phase as the chef's arms.
      const lift = appliance.motion === "chop" ? chopLift(phase) : 0;
      visual.knife.rotation.z = lift * 1.15;
      visual.knife.position.y = height + 0.09 + lift * 0.1;
    }

    if (visual.oil && visual.oilGlow) {
      const frying = appliance.motion === "fry";
      const boil = Math.sin(phase) * 0.5 + Math.sin(phase * 2.7) * 0.5;
      // The oil lies in the vat, filled nearly to the deck.
      visual.oil.position.y = height + (frying ? boil * 0.012 : 0);
      visual.oil.scale.y = frying ? 1 + boil * 0.35 : 1;
      visual.oilGlow.emissiveIntensity = frying ? 0.85 + boil * 0.5 : 0.55;
      // The basket sits *in* the oil, so what the boil moves is how high it
      // rides and how much it rolls — not the lean of a stick in mid-air.
      if (visual.basket) {
        visual.basket.position.y = height - 0.05 + (frying ? boil * 0.018 : 0);
        visual.basket.rotation.z = frying ? Math.sin(phase * 0.7) * 0.05 : 0;
      }
    }

    if (visual.water) {
      // Water sloshes while somebody is at it and lies flat when they are not.
      // A sink with a pile waiting already advertises itself — the pile is
      // drawn, and it grows — so this only has to say "in use".
      const scrubbing = appliance.motion === "scrub";
      const slosh = Math.sin(phase) * 0.6 + Math.sin(phase * 1.9) * 0.4;
      visual.water.position.y = height - 0.01 + (scrubbing ? slosh * 0.012 : 0);
      visual.water.scale.y = scrubbing ? 1 + slosh * 0.5 : 1;
    }

    if (visual.glass) {
      // Slow, uneven ember glow: an oven does not blink, it breathes. Kept low
      // on purpose: pushed hard the emissive washes the dark glass out to flat
      // orange paint. It should read as embers behind a window.
      const heat =
        appliance.motion === "bake"
          ? 0.3 + Math.sin(phase) * 0.12 + Math.sin(phase * 3.3) * 0.05
          : 0;
      for (const pane of visual.glass) pane.emissiveIntensity = heat;
    }

    if (visual.lid) {
      visual.binOpen = Math.max(0, visual.binOpen - dt * 2.2);
      visual.lid.rotation.x = -visual.binOpen * 1.15;
    }
  }

  /**
   * A held appliance is drawn as a **ghost standing on the tile it would go
   * to**, not carried on the chef's head.
   *
   * Balancing an oven on someone's hat is funny once; it also puts the thing
   * you are deciding about in the one place you are not looking. The decision
   * during the build phase is "does it go *there*", so the preview belongs
   * there — and because the ghost slides between tiles it doubles as a readout
   * of which tile you're actually pointing at.
   */
  private place(
    world: World,
    appliance: Appliance,
    visual: Visual,
    dt: number,
    time: number,
  ): void {
    const held = appliance.heldBy !== null ? playerById(world, appliance.heldBy) : undefined;
    const state = visual.ghost;

    if (held) {
      const tile = targetTile(held);
      // A wall between chef and square is the same answer as an occupied one:
      // it would not go there. The ghost still shows *where*, and hovers.
      const valid = reachedTile(world, held) !== null && canPlace(world, tile.x, tile.y);
      const inGrid = tile.x >= 0 && tile.y >= 0 && tile.x < world.width && tile.y < world.height;
      // The ghost always answers "where would this go"; whether it *settles* or
      // stays hovering answers "can it". Two questions, two channels — plus the
      // highlight underneath turns red. Off the grid entirely there is no tile
      // to point at, so it stays with the chef.
      const targetX = inGrid ? tile.x + 0.5 : held.pos.x;
      const targetZ = inGrid ? tile.y + 0.5 : held.pos.y;

      if (!state.held) {
        state.held = true;
        state.x = held.pos.x;
        state.z = held.pos.y;
        state.alpha = 0;
        setGhost(visual.root, true);
      }
      const chase = ease(16, dt);
      state.x += (targetX - state.x) * chase;
      state.z += (targetZ - state.z) * chase;
      state.alpha = Math.min(1, state.alpha + dt * 6);

      const settle = state.alpha * state.alpha;
      // Valid: sinks onto the tile. Invalid: hangs above it with a slow bob,
      // which reads as "held" rather than "placed" without needing a colour.
      const hover = 0.42 + Math.sin(time * 3) * 0.03;
      visual.root.position.set(state.x, valid ? 0.06 * (2 - settle) : hover, state.z);
      visual.root.scale.setScalar(0.86 + 0.14 * settle);
      setGhostOpacity(visual.root, valid ? state.alpha : state.alpha * 0.7);
      return;
    }

    if (state.held) {
      // Just set down: go solid and pop.
      state.held = false;
      state.alpha = 0;
      state.pop = 1;
      setGhost(visual.root, false);
    }
    state.pop = Math.max(0, state.pop - dt * 4);
    const pop = state.pop * state.pop;
    visual.root.position.set(appliance.tile.x + 0.5, 0, appliance.tile.y + 0.5);
    visual.root.scale.set(1 + 0.13 * pop, 1 - 0.18 * pop, 1 + 0.13 * pop);
  }

  /**
   * Ease the dial in and out, and let it say *what* is happening rather than
   * only how far along it is:
   *
   *   - prep is mint, cooking is gold — the two feel different, so they look it;
   *   - burning is red and **pulses**, because in peripheral vision movement
   *     carries where colour does not, and burning is the one state that needs
   *     you to look;
   *   - finishing flashes white and expands, so a completed chop registers even
   *     if you were watching another chef at the time.
   */
  private syncDial(appliance: Appliance, visual: Visual, dt: number, time: number): void {
    const burning = appliance.overcook > 0;
    const active = appliance.progress > 0.001;

    // Ease in fast, out slow: appearing should feel instant, leaving should not
    // snatch the last frame of information away.
    const target = active ? 1 : 0;
    visual.dialAlpha += (target - visual.dialAlpha) * ease(active ? 9 : 4, dt);
    if (appliance.justFinished) visual.dialFlash = 1;
    visual.dialFlash = Math.max(0, visual.dialFlash - dt * 3.2);

    const pulse = burning ? 1 + Math.sin(time * 14) * 0.09 : 1;
    visual.dial.apply({
      progress: appliance.progress,
      color: burning ? PALETTE.progressBurn : cookingColor(appliance),
      alpha: visual.dialAlpha,
      flash: visual.dialFlash * visual.dialFlash,
      scale: pulse * (1 + visual.dialFlash * 0.28),
    });
  }
}

/** What a slot is showing, as one string. Changes exactly when the goods do. */
/**
 * Which way the sign should be showing.
 *
 * Read from the world rather than remembered from the grab that changed it: the
 * simulation is the only thing that knows whether a flip was *allowed* — an
 * open refused because somebody is holding an oven, a close a predicted tick
 * was not permitted to make — and a board animated from the keypress would tell
 * that lie for a round trip.
 *
 * `dayTime` is in the answer as well as the phase, so the sign turns itself
 * back over at closing time: the day the clock runs out is the day the room
 * stops taking customers, and the object that says so should say so.
 */
function signFaceOf(world: World): SignFace {
  return world.phase === "service" && world.dayTime > 0 ? "open" : "closed";
}

function offerKeyOf(offer: Offer): string {
  return offer.good === "plate" ? "plate" : `${offer.kind}:${offer.source?.base ?? ""}`;
}

/**
 * The goods, shrunk onto the counter.
 *
 * A whole appliance at a third scale, not a bespoke icon: a fryer on the stall
 * and a fryer in the kitchen are the same object, seen before and after buying
 * it, and building it any other way is how the two drift into looking like
 * different things. It is drawn at **very nearly full size** for the same
 * reason: the shop is not a picture of an oven, it is an oven standing outside
 * — see `GOODS_SCALE` for the fifth that comes off it and why.
 * Plates are the exception because a plate is not an appliance — it is stock,
 * and `models.ts` already knows how to draw one.
 */
function goodsModel(offer: Offer): THREE.Object3D {
  if (offer.good === "plate") {
    const plate = buildIngredientSample("plate");
    plate.scale.setScalar(0.85 * GOODS_SCALE);
    return plate;
  }

  const sample = buildAppliance({
    id: -1,
    kind: offer.kind,
    tile: { x: 0, y: 0 },
    item: null,
    progress: 0,
    overcook: 0,
    justFinished: false,
    motion: null,
    source: offer.source,
    offer: null,
    taken: null,
    card: null,
    armedBy: null,
    armTime: 0,
    heldBy: null,
    tip: 0,
  }).root;
  sample.scale.setScalar(GOODS_SCALE);
  return sample;
}

/**
 * A shade under full size.
 *
 * The goods are the same models that will stand in the kitchen — that is the
 * whole idea — but a full-size oven on a pallet swallows the pallet, and the
 * pallet is what says the thing was *delivered* rather than installed. A fifth
 * off leaves the silhouette unmistakable and the timber visible underneath.
 */
const GOODS_SCALE = 0.8;

/** How high the top of the goods is, pallet included, so the price sits over it. */
function offerHeight(offer: Offer): number {
  const model = offer.good === "plate" ? 0.12 : applianceDef(offer.kind).height;
  return PITCH_DECK + model * GOODS_SCALE;
}

/** The warning ring's own material, narrowed rather than asserted. */
function ringMaterial(ring: THREE.Mesh): THREE.MeshBasicMaterial {
  if (Array.isArray(ring.material) || !(ring.material instanceof THREE.MeshBasicMaterial)) {
    throw new Error("highlight lost its material");
  }
  return ring.material;
}

/** Prep and cooking feel different, so their gauges look different. */
function cookingColor(appliance: Appliance): number {
  return appliance.motion === "fry" || appliance.motion === "bake"
    ? PALETTE.progressCook
    : PALETTE.progressGood;
}
