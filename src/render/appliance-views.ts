import * as THREE from "three";
import { applianceDef, pushes } from "../data/appliances";
import { RECIPE_BY_ID } from "../data/recipes";
import type { Appliance, Offer, World } from "../sim/types";
import { cardinal, playerById } from "../sim/world";
import { inward } from "../sim/walls";
import { deliveryLabel, missingFor } from "../sim/cards";
import { isBurnt } from "../sim/items";
import { canPlace, reachedTile, targetTile, unreachableTables } from "../sim/queries";
import { hasDelivery, offerLabel, offerPrice } from "../sim/shop";
import { chopLift, ease, shortestTurn, workPhase } from "./anim";
import { setGlow } from "./glow";
import { Dial } from "./dial";
import { disposeSubtree } from "./dispose";
import { setGhost, setGhostOpacity } from "./ghost";
import {
  BELT_RUN,
  beltSlatZ,
  buildAppliance,
  buildFitting,
  paintSign,
  PITCH_DECK,
  type ApplianceParts,
  type SignFace,
} from "./appliance-meshes";
import { buildHighlight } from "./overlay-meshes";
import { PALETTE } from "./palette";
import { PUFFS, type Particles, type PuffKind } from "./particles";
import { makeLabel, makeRecipeCard } from "./sprites";

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
   * What a recipe card on this square would be delivered with, as its label
   * says it. Kept because it changes without the offer changing — buy the oven
   * yourself and the card stops promising you one.
   */
  needs: string;
  /** What the sign says, and the pop as it changes. 1..0. */
  signFace: SignFace;
  signPop: number;
  /** A refused purchase, flashing the price red. 1..0. */
  refused: number;
  /**
   * Seconds until this appliance lets go of its next puff.
   *
   * Per appliance rather than per frame, because a plume is *steady* and a
   * frame is not: emitting one puff per frame would tie how much steam a fryer
   * makes to how fast the machine drawing it happens to be running.
   */
  puff: number;
  /** Ring shown when nobody can walk to this. Built the first time it is needed. */
  warning?: THREE.Mesh;
  /** The fitting drawn on this one's worktop, and which kind it is. */
  topper: Appliance["topper"];
  topperMesh?: THREE.Object3D;
  /** Placement ghost: eased position, fade, and the pop when it lands. */
  ghost: { alpha: number; x: number; z: number; pop: number; held: boolean };
};

export class ApplianceViews {
  private readonly visuals = new Map<number, Visual>();

  /** Tables nobody can walk to, and the layout that answer was computed for. */
  private stranded = new Set<number>();
  private strandedFor = -1;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly particles: Particles,
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

      this.syncTopper(appliance, visual);
      const phase = workPhase(appliance.motion, appliance.id, time);
      this.animateParts(appliance, visual, phase, dt, time);
      this.syncDial(appliance, visual, dt, time);
      this.syncPlume(appliance, visual, dt);
      if (appliance.kind === "stall") this.syncStall(world, appliance, visual, dt);
      if (appliance.kind === "sign") this.syncSign(world, appliance, visual, dt);
    }
  }

  /**
   * Tables no customer can walk to.
   *
   * This used to ring appliances the *chefs* could not reach as well, and that
   * half was simply wrong: a chef reaches diagonally (`canReach`) and the check
   * was four-way, so a perfectly usable oven in a corner pulsed red while
   * somebody cooked on it. It is gone — see the note in `kitchenWarnings`.
   * A table is a different question with the same shape, and it survives
   * because customers really do walk four ways.
   *
   * Keyed on `layoutVersion`, so the flood fill runs when an appliance moves
   * rather than once a frame — and it runs *the instant* it moves, which is
   * exactly when the answer can change.
   */
  private syncStranded(world: World): void {
    if (world.phase !== "build") {
      if (this.stranded.size > 0) this.stranded.clear();
      this.strandedFor = -1;
      return;
    }
    if (world.layoutVersion === this.strandedFor) return;
    this.strandedFor = world.layoutVersion;
    this.stranded = new Set(unreachableTables(world).map((appliance) => appliance.id));
  }

  /**
   * The board on a counter's worktop, put there and taken away again.
   *
   * Built from the *host's* id and height, so a fitting keeps the angle it was
   * put down at and lands on the surface rather than in it. The knife comes
   * with it and is handed to `animateParts`, which is what makes a fitted board
   * swing exactly as the appliance-shaped one used to.
   *
   * Gated on the kind rather than run every frame: a board is fitted a handful
   * of times a morning and never during service.
   */
  private syncTopper(appliance: Appliance, visual: Visual): void {
    if (visual.topper === appliance.topper) return;
    visual.topper = appliance.topper;
    if (visual.topperMesh) {
      visual.root.remove(visual.topperMesh);
      disposeSubtree(visual.topperMesh);
      visual.topperMesh = undefined;
      visual.knife = undefined;
    }
    if (appliance.topper === null) return;
    const fitting = buildFitting(
      appliance.topper,
      appliance.id,
      applianceDef(appliance.kind).height,
    );
    visual.root.add(fitting.root);
    visual.topperMesh = fitting.root;
    visual.knife = fitting.knife;
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
  /**
   * A price, or a whole recipe card.
   *
   * Goods get one line, because the name and the number are all there is to
   * say about an oven somebody can already see. A card's face is the thing it
   * is *for* — the dish, what it pays, the steps, and what the kitchen would be
   * sent — and it survives from the poster this replaced, with the price it
   * never used to have on the end of the first line.
   */
  private offerSprite(visual: Visual, offer: Offer, refused: boolean): THREE.Object3D {
    const recipe = offer.recipe === undefined ? undefined : RECIPE_BY_ID.get(offer.recipe);
    const colour = refused ? PALETTE.progressBurn : 0xffffff;
    // A price is a name and a number, and a pill is the right shape for it.
    if (!recipe) return makeLabel(`${offerLabel(offer)}  $${offerPrice(offer)}`, colour);
    return makeRecipeCard(
      {
        name: recipe.name,
        price: `$${offerPrice(offer)}  \u00b7  +$${recipe.reward} a plate`,
        blurb: recipe.blurb,
        // "with nothing" is worth saying out loud: it is the difference between
        // a card that is also a free fryer and a card that is only a dish, and
        // an absent line reads as the card having failed to say something.
        //
        // Kept short because the card is sized by its own contents: this is
        // reliably the longest line on it, so its wording sets the width of the
        // whole thing.
        delivery: visual.needs ? `Comes with: ${visual.needs}` : "Comes with nothing",
      },
      colour,
    );
  }

  private create(appliance: Appliance, world: World): Visual {
    const parts = buildAppliance(appliance);
    // A sign is built closed, so a kitchen joined mid-service would otherwise
    // play its opening turn as a welcome to somebody who has arrived late.
    const signFace = signFaceOf(world);
    if (parts.boardFaces && signFace === "open") paintSign(parts.boardFaces, signFace);
    // Facing the right way from its very first frame: everything after this is
    // eased, and easing from zero would spin every belt in a kitchen as it
    // loads. See `aim`.
    if (pushes(appliance.kind)) {
      parts.root.rotation.y = Math.atan2(appliance.dir.x, appliance.dir.y);
    }
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
      needs: "",
      topper: null,
      refused: 0,
      puff: 0,
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
    // Nothing is delivered on the first morning, and that has to include the
    // pallets: an empty one means "already carried inside", which on day one
    // would be a lie about a delivery that never came. Asked of the same rule
    // the roll asks, so the paving and the simulation cannot disagree.
    const open = world.phase === "build" && hasDelivery(world);

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

    // A sandwich board stands on its own feet, so the planks go and it lands on
    // the paving: it is the one delivery that is not a boxed good. The pallet
    // *group* stays, so arriving and being collected animate as they always did.
    const boarded = offer?.recipe !== undefined;
    if (visual.deck) visual.deck.visible = !boarded;
    if (visual.counter) visual.counter.position.y = boarded ? 0 : PITCH_DECK;
    // What a card would deliver is asked of the *world*, so it answers for this
    // kitchen and stops promising an oven the moment the room buys one. On the
    // key because it changes while the offer does not.
    const recipe = offer?.recipe === undefined ? null : RECIPE_BY_ID.get(offer.recipe);
    const needs = recipe ? deliveryLabel(missingFor(world, recipe)) : "";
    // The price is the half that is gated, because a label on a shop that has
    // closed is a price nobody may pay. `open` is on the key so that closing
    // rebuilds the label without rebuilding the goods.
    const key = offer ? `${offerKeyOf(offer)}|${needs}|${open}` : "";
    if (key !== visual.offerKey) {
      visual.offerKey = key;
      this.restock(visual, offer, open, needs);
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
  private restock(visual: Visual, offer: Offer | null, sellable: boolean, needs: string): void {
    const counter = visual.counter;
    if (counter) {
      // Detached first, then freed: `clear()` mutates the array being walked.
      const old = counter.children.slice();
      counter.clear();
      for (const child of old) disposeSubtree(child);
      if (offer) counter.add(goodsModel(offer));
    }
    visual.needs = needs;
    this.priceLabel(visual, sellable ? offer : null, false);
  }

  private priceLabel(visual: Visual, offer: Offer | null, refused: boolean): void {
    if (visual.label) {
      visual.root.remove(visual.label);
      disposeSubtree(visual.label);
      visual.label = undefined;
    }
    if (!offer) return;
    const sprite = this.offerSprite(visual, offer, refused);
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
  private animateParts(
    appliance: Appliance,
    visual: Visual,
    phase: number,
    dt: number,
    time: number,
  ): void {
    const height = applianceDef(appliance.kind).height;

    if (visual.slats) {
      // A belt runs whether or not there is anything on it, because a belt is
      // *switched on* — and a machine that only moves when it is loaded looks
      // like a machine that is broken the rest of the time. Driven off the
      // clock rather than off `progress` for the same reason: the item's own
      // travel already says how far along it is, and this says the thing is
      // live.
      const pitch = BELT_RUN / visual.slats.children.length;
      const scroll = (time * BELT_SCROLL) % pitch;
      for (const [i, slat] of visual.slats.children.entries()) {
        slat.position.z = beltSlatZ(i) + scroll;
      }
    }

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
      const valid =
        reachedTile(world, held) !== null && canPlace(world, tile.x, tile.y, appliance.kind);
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
      // A held belt points wherever the chef is looking, so the ghost answers
      // "which way would this run" at the same time as it answers "where would
      // it go" — rather than only after it has been put down and turned.
      this.aim(appliance, visual, cardinal(held.facing), dt);

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
    this.aim(appliance, visual, appliance.dir, dt);
    visual.root.position.set(appliance.tile.x + 0.5, 0, appliance.tile.y + 0.5);
    visual.root.scale.set(1 + 0.13 * pop, 1 - 0.18 * pop, 1 + 0.13 * pop);
  }

  /**
   * Turn an appliance that has a direction to face it.
   *
   * Only the ones that push something somewhere: everything else is drawn
   * square to the room, and a sign turns itself to face inward a moment later
   * (`syncSign`). Both are built pointing along local +z, so this is the same
   * `atan2` the sign uses.
   *
   * **Swung rather than snapped**, and by the short way round: a belt that is
   * turned should be *seen* to turn, or a quarter turn is indistinguishable
   * from the belt being replaced by a different one. It is the same easing the
   * ghost slides between tiles with, so a held belt turning with its chef and a
   * standing one being turned by one are the same motion. A newly built visual
   * snaps — see `create` — because a kitchen appearing has nothing to swing
   * from.
   */
  private aim(
    appliance: Appliance,
    visual: Visual,
    dir: { x: number; y: number },
    dt: number,
  ): void {
    if (!pushes(appliance.kind)) return;
    const target = Math.atan2(dir.x, dir.y);
    visual.root.rotation.y += shortestTurn(target - visual.root.rotation.y) * ease(13, dt);
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
    // A machine that pushes spends `progress` on doing so — how far along the
    // band an item has got, or how long until the next one drops — and a work
    // gauge counting that down would be measuring the wrong thing entirely.
    // See `Appliance.progress` and `pushes`.
    const active = appliance.progress > 0.001 && !pushes(appliance.kind);

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

  /**
   * Steam off a working appliance, smoke off a burning one.
   *
   * Emitted from here rather than from an effect cue because neither is a
   * *moment*: `world.effects` carries things that happened once, and a fryer
   * being busy or a pizza being ruined are states the kitchen is *in*. Reading
   * the state means somebody who joined ten seconds ago sees the smoke that was
   * already there, which a replayed cue could never give them.
   *
   * A **held** appliance makes nothing. It is in somebody's hands during the
   * build phase, its contents were cleared at closing time, and a plume
   * following a chef across the patio would be the funniest bug in the game.
   */
  private syncPlume(appliance: Appliance, visual: Visual, dt: number): void {
    const kind = plumeOf(appliance);
    if (!kind) {
      // Reset rather than left to run down, so the next thing this appliance
      // cooks steams at once instead of after the remainder of an interval it
      // was part-way through when the last day ended.
      visual.puff = 0;
      return;
    }
    visual.puff -= dt;
    if (visual.puff > 0) return;
    visual.puff = PUFFS[kind].every;
    this.particles.emit(
      kind,
      appliance.tile.x + 0.5,
      applianceDef(appliance.kind).height + 0.1,
      appliance.tile.y + 0.5,
    );
  }
}

/**
 * What this appliance is putting into the air, if anything.
 *
 * Burning wins outright: an oven that is both cooking and ruining what is in it
 * is ruining it, and a plume that mixed the two would be the game hedging about
 * the one state that needs you to move.
 *
 * **Something already ruined keeps saying so.** `overcook` counts up to the
 * moment food burns and is then reset, so for the whole life of the burnt thing
 * afterwards — which is until somebody walks over and bins it — the appliance
 * holding it looked exactly like an idle one. The dish is drawn black, and that
 * is the only thing that was saying it, from whatever angle the camera happened
 * to be at.
 *
 * It is worth more now than it was. A chef who ruins a pizza was standing at the
 * oven and knows; the failure this misses is the one at the far end of a
 * [conveyor](../../docs/automation.md) — a burnt item stops the appliance
 * holding it from taking anything else, which backs the belt up behind it and
 * stops the hopper feeding it, and the whole line goes quiet with nothing
 * anywhere saying why. A wisp of smoke over the thing that stopped is the
 * difference between a jam you can find and a machine that has silently
 * stopped paying.
 *
 * Steam is only for **heat**. A chopping board does not steam, and a sink
 * deliberately does not either — it is the one place in the kitchen where
 * nothing can go wrong (see `ESSENTIAL` in `data/appliances.ts`), and giving it
 * a plume would put it in the same visual language as the things that can.
 */
function plumeOf(appliance: Appliance): PuffKind | null {
  if (appliance.heldBy !== null) return null;
  if (appliance.overcook > 0) return "smoke";
  if (appliance.item && isBurnt(appliance.item)) return "smoke";
  if (appliance.progress <= 0.001) return null;
  return appliance.motion === "fry" || appliance.motion === "bake" ? "steam" : null;
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
  return `${offer.kind}:${offer.source?.base ?? ""}`;
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
 */
function goodsModel(offer: Offer): THREE.Object3D {
  const sample = buildAppliance({
    id: -1,
    kind: offer.kind,
    tile: { x: 0, y: 0 },
    item: null,
    progress: 0,
    overcook: 0,
    justFinished: false,
    motion: null,
    topper: null,
    // Square to the pallet: a belt in the delivery is a belt nobody has decided
    // the direction of yet.
    dir: { x: 0, y: 1 },
    source: offer.source,
    offer: null,
    taken: null,
    // A card on a pallet is dressed with its dish, exactly as a crate on one is
    // dressed with its ingredient.
    card: offer.recipe ?? null,
    heldBy: null,
    tip: 0,
  }).root;
  // A card is not shrunk with the rest: see `offerHeight`.
  if (offer.recipe === undefined) sample.scale.setScalar(GOODS_SCALE);
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

/**
 * How fast a conveyor's slats travel, in tiles per second.
 *
 * Faster than the belt actually carries (`travel`), and deliberately: a band
 * moving at exactly the speed of the thing on it reads as a stuck item being
 * dragged. Belts in real kitchens run visibly faster than the queue on them
 * looks like it is going, because the load slips.
 */
const BELT_SCROLL = 0.55;

/** How high the top of the goods is, pallet included, so the price sits over it. */
function offerHeight(offer: Offer): number {
  // A recipe card stands on the paving rather than on the deck, and at full
  // size: a sandwich board shrunk to four fifths beside a full-size oven would
  // be a sandwich board for a smaller restaurant.
  if (offer.recipe !== undefined) return applianceDef(offer.kind).height;
  return PITCH_DECK + applianceDef(offer.kind).height * GOODS_SCALE;
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
