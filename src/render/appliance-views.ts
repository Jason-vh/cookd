import * as THREE from "three";
import { applianceDef } from "../data/appliances";
import { RECIPE_BY_ID } from "../data/recipes";
import type { Appliance, Offer, Recipe, World } from "../sim/types";
import { playerById } from "../sim/world";
import { inward } from "../sim/walls";
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
import { Dial } from "./dial";
import { disposeSubtree } from "./dispose";
import { setGhost, setGhostOpacity } from "./ghost";
import { buildAppliance, paintSign, type ApplianceParts, type SignFace } from "./appliance-meshes";
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

  /** Reused by `viewingAngle`, which runs every frame. */
  private readonly scratch = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
  ) {}

  /** The object an appliance is drawn as, for things that hang off it. */
  root(id: number): THREE.Object3D | undefined {
    return this.visuals.get(id)?.root;
  }

  /**
   * Which way to turn something so its front faces the camera.
   *
   * Read off the camera itself rather than from `orientation.ts`, so a face
   * swings round *with* the room while the view is easing between corners
   * rather than snapping ahead of it.
   */
  private viewingAngle(): number {
    const forward = this.scratch.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    return Math.atan2(-forward.x, -forward.z);
  }

  /** Show this appliance's contextual name for one frame. */
  showLabel(id: number): void {
    const label = this.visuals.get(id)?.label;
    if (label) label.visible = true;
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
      // pointing at this appliance — see `showLabel`.
      if (visual.label) visual.label.visible = false;

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
   * Dress a card stand: the dish on the card, what the card says, and the lift
   * that means somebody is about to choose it.
   *
   * The easel stands there either way — it is furniture on the apron, and an
   * invisible thing to walk into would be worse than an empty one. What comes
   * and goes is the card, which is the same grammar as the stall's shutters:
   * whether there is a decision to make is legible from across the patio.
   */
  private syncCards(
    world: World,
    appliance: Appliance,
    visual: Visual,
    dt: number,
    time: number,
  ): void {
    // The easel turns to face whoever is looking at it. Everything else in the
    // kitchen is a box and reads from any corner; this one has a *face*, and a
    // recipe card showing its back to the camera is the one appliance a turned
    // view could make unreadable.
    visual.root.rotation.y = this.viewingAngle();

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

    // Armed: the card lifts off the easel and sways, so a second player across
    // the patio can see a choice being made before it is made.
    const target = appliance.armedBy !== null && recipe ? 1 : 0;
    visual.armed += (target - visual.armed) * ease(12, dt);
    if (visual.card) {
      const base = applianceDef(appliance.kind).height * 0.98;
      visual.card.position.y = base + visual.armed * 0.26;
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
    label.position.y = applianceDef(appliance.kind).height + 1.5;
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
   * Dress a stall slot: the goods on the counter, the price above them, and
   * the shutters that say whether any of it is available.
   *
   * The goods are a **real, shrunken instance of the appliance** rather than an
   * icon, because the thing you are about to buy and the thing that will be
   * standing in your kitchen ought to be recognisably the same object. It costs
   * one `buildAppliance` per slot per morning.
   */
  private syncStall(world: World, appliance: Appliance, visual: Visual, dt: number): void {
    const open = world.phase === "build";
    if (visual.shutter) visual.shutter.visible = !open;

    // A slot that has handed something out today is empty, whatever it still
    // remembers being worth — the same rule the simulation applies.
    const offer = open && appliance.taken === null ? appliance.offer : null;
    const key = offer ? offerKeyOf(offer) : "";
    if (key !== visual.offerKey) {
      visual.offerKey = key;
      this.restock(appliance, visual, offer);
    }

    // Red for as long as the refusal is worth noticing, then back to white.
    // Rebuilding the sprite is what it costs, which is why it is gated on the
    // flash actually being over rather than eased every frame.
    if (visual.refused > 0) {
      const was = visual.refused;
      visual.refused = Math.max(0, visual.refused - dt * 1.6);
      if (was === 1 || (visual.refused === 0 && offer)) {
        this.priceLabel(appliance, visual, offer, visual.refused > 0);
      }
    }
  }

  /** Put this morning's goods on the counter, and their price over them. */
  private restock(appliance: Appliance, visual: Visual, offer: Offer | null): void {
    const counter = visual.counter;
    if (counter) {
      // Detached first, then freed: `clear()` mutates the array being walked.
      const old = counter.children.slice();
      counter.clear();
      for (const child of old) disposeSubtree(child);
      if (offer) counter.add(goodsModel(offer));
    }
    this.priceLabel(appliance, visual, offer, false);
  }

  private priceLabel(
    appliance: Appliance,
    visual: Visual,
    offer: Offer | null,
    refused: boolean,
  ): void {
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
    sprite.position.y = applianceDef(appliance.kind).height + 1.35;
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
 * and a fryer in the kitchen are the same object seen twice, and building the
 * sample any other way is how the two drift into looking like different things.
 * Plates are the exception because a plate is not an appliance — it is stock,
 * and `models.ts` already knows how to draw one.
 */
function goodsModel(offer: Offer): THREE.Object3D {
  if (offer.good === "plate") {
    const plate = buildIngredientSample("plate");
    plate.scale.setScalar(0.85);
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
  sample.scale.setScalar(0.34);
  return sample;
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
