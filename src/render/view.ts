import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { applianceDef } from "../data/appliances";
import { specKey } from "../sim/items";
import { DT } from "../sim/step";
import { canPlace, targetTile } from "../sim/systems/interaction";
import { CUSTOMER_SPEED, EAT_TIME, unreachableTables } from "../sim/systems/customers";
import type { Appliance, ChefMotion, Customer, Item, Motion, World } from "../sim/types";
import { PLAYER_SPEED, applianceAtTile, playerById } from "../sim/world";
import { biome as lookupBiome } from "../data/biomes";
import { PALETTE } from "./palette";
import { createEnvironment } from "./environment";
import { mergeStatic } from "./merge";
import { KitchenCamera, type FollowTarget } from "./camera";
import { Dial } from "./dial";
import { Bubble } from "./bubble";
import { setGhost, setGhostOpacity } from "./ghost";
import { Popups } from "./popups";
import { buildItemModel } from "./models";
import {
  type ChefParts,
  PLAYER_COLORS,
  buildAppliance,
  buildChef,
  buildCustomer,
  buildDoorway,
  buildTipStack,
  makeNameTag,
  buildHighlight,
  buildWall,
  floorTexture,
} from "./meshes";
import { createPost, postEnabled, type Post } from "./post";

/**
 * The render layer mirrors the simulation; it never writes to it.
 *
 * Objects are keyed by simulation entity id and reused across frames, so a
 * steady-state frame allocates nothing and issues a stable set of draw calls.
 * Visual state that depends on item composition is rebuilt only when the item's
 * canonical key changes (e.g. tomato -> chopped tomato).
 *
 * Art direction lives in `palette.ts` (colour) and `meshes.ts` (form); this
 * file owns the scene, lighting, camera and animation.
 */
export class View {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  private rig: KitchenCamera;
  private renderer: THREE.WebGLRenderer;
  private post: Post | null = null;
  private grade: { saturation: number; warmth: number; lift: number };

  private applianceObjects = new Map<number, THREE.Object3D>();
  private itemObjects = new Map<number, { object: THREE.Object3D; key: string }>();
  private chefs = new Map<
    number,
    ChefParts & {
      phase: number;
      pop: number;
      lastCarried: number;
      tag?: THREE.Sprite;
      tagName?: string;
      wasAway?: boolean;
    }
  >();
  private customers = new Map<number, ChefParts & { phase: number; slump: number }>();
  /** Order bubble per table appliance id. */
  private bubbles = new Map<number, Bubble>();
  /** Tip coins per table appliance id, and how far they have risen into view. */
  private tips = new Map<number, { object: THREE.Object3D; alpha: number }>();
  /** Tables the dining room cannot reach, recomputed only in the build phase. */
  private stranded = new Set<number>();
  /** Table id -> how much of the meal on it is left, 1..0. */
  private eatingTables = new Map<number, number>();
  private highlights = new Map<number, THREE.Mesh>();
  private liveItems = new Set<number>();
  private clock = new THREE.Clock();
  private popups = new Popups(this.scene);
  /** Bin id -> how far its lid is still flipped open, 1..0. */
  private binOpen = new Map<number, number>();
  private lastEffectId = 0;
  /** Palette slot per player, so a name tag matches its chef. */
  private tagColors = new Map<number, number>();
  private dialState: Record<number, { alpha: number; flash: number }> = {};
  private heldState: Record<
    number,
    { alpha: number; x: number; z: number; pop: number; started: boolean }
  > = {};
  /** This frame's delta, shared by everything that eases. */
  private frameDt = 1 / 60;
  /** Reused every frame so following allocates nothing. */
  private followTargets: FollowTarget[] = [];

  constructor(canvas: HTMLCanvasElement, world: World, biomeId: string) {
    const biome = lookupBiome(biomeId);
    this.grade = biome.grade;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !postEnabled() });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = biome.exposure;

    const cx = world.width / 2;
    const cz = world.height / 2;

    // Orthographic at a 3/4 angle: real 3D, isometric read. It follows the
    // local chefs and never shows past these bounds — see render/camera.ts.
    this.rig = new KitchenCamera(
      new THREE.Box3(
        new THREE.Vector3(-0.4, -1.4, -0.4),
        new THREE.Vector3(world.width + 0.4, 2.0, world.height + 0.4),
      ),
    );
    this.camera = this.rig.camera;

    // Sky, sunlight, ground and scenery all come from the biome.
    this.setupImageBasedLighting(biome.environmentIntensity);
    createEnvironment(this.scene, biome, { width: world.width, height: world.height });
    this.buildKitchenShell(world, cx, cz);

    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  // --- scene setup -----------------------------------------------------------

  private setupImageBasedLighting(intensity: number): void {
    // RoomEnvironment gives image-based lighting with zero assets: soft
    // directional variation and believable roughness response on every surface.
    // This is the single biggest quality win over plain analytic lights.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = intensity;
    pmrem.dispose();
  }

  /**
   * The kitchen itself: its paved floor and its walls.
   *
   * Walls are fixed by the level and the floor never moves, so the whole shell
   * is baked down to one draw call per material alongside the scenery.
   */
  private buildKitchenShell(world: World, cx: number, cz: number): void {
    const shell = new THREE.Group();

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(world.width, world.height),
      new THREE.MeshStandardMaterial({
        map: floorTexture(world.width, world.height),
        roughness: 0.85,
        metalness: 0,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0.004, cz);
    floor.receiveShadow = true;
    shell.add(floor);

    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const tile = world.tiles[y * world.width + x];
        if (tile?.door) {
          // The gap customers arrive through. A frame around it is what stops it
          // reading as a hole somebody forgot to wall up.
          const frame = buildDoorway();
          frame.position.set(x + 0.5, 0, y + 0.5);
          shell.add(frame);
          continue;
        }
        if (!tile?.wall) continue;
        // The two edges nearest the camera are a low lip, otherwise they would
        // occlude the kitchen.
        const near = x === world.width - 1 || y === world.height - 1;
        const wall = buildWall(near ? 0.26 : 1.1);
        wall.position.set(x + 0.5, 0, y + 0.5);
        shell.add(wall);
      }
    }

    this.scene.add(...mergeStatic(shell));
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.rig.setAspect(w / h);

    if (postEnabled() && !this.post) {
      this.post = createPost(this.renderer, this.scene, this.camera, this.grade);
    }
    this.post?.resize(w, h);
  }

  /**
   * `localIds` are the players this browser drives; the camera follows them and
   * ignores everyone else, so an online kitchen does not drag your view across
   * the room every time a stranger walks off.
   */
  render(world: World, alpha: number, localIds: readonly number[] = []): void {
    const dt = Math.min(0.1, this.clock.getDelta());
    this.frameDt = dt;
    this.syncEffects(world, dt);
    this.syncAppliances(world);
    this.syncChefs(world, alpha, dt);
    this.syncCustomers(world, alpha, dt);
    this.syncTables(world, dt);
    this.syncItems(world, alpha);
    this.syncHighlights(world);
    this.rig.update(this.followPoints(world, alpha, localIds), dt);

    if (this.post) this.post.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /**
   * Where the local chefs are *this frame*. Interpolated with the same `alpha`
   * the chefs themselves are drawn at, or the camera would chase a body that is
   * 60Hz-steppy while the body it is chasing is smooth.
   */
  private followPoints(world: World, alpha: number, localIds: readonly number[]): FollowTarget[] {
    this.followTargets.length = 0;
    for (const player of world.players) {
      if (!localIds.includes(player.id)) continue;
      this.followTargets.push({
        x: lerp(player.prevPos.x, player.pos.x, alpha),
        z: lerp(player.prevPos.y, player.pos.y, alpha),
      });
    }
    return this.followTargets;
  }

  // --- appliances ------------------------------------------------------------

  private syncAppliances(world: World): void {
    // Appliances can vanish: a reset renumbers the kitchen, and online the
    // server can hand us a completely different layout. Meshes for ids that no
    // longer exist have to go, or they hang in the scene forever.
    for (const [id, object] of this.applianceObjects) {
      if (world.appliances.has(id)) continue;
      this.scene.remove(object);
      this.applianceObjects.delete(id);
      delete this.dialState[id];
      delete this.heldState[id];
    }

    for (const appliance of world.appliances.values()) {
      let object = this.applianceObjects.get(appliance.id);
      if (!object) {
        object = buildAppliance(appliance);
        const dial = new Dial(this.camera);
        dial.object.position.y = applianceDef(appliance.kind).height + 0.72;
        object.add(dial.object);
        object.userData.dial = dial;
        this.scene.add(object);
        this.applianceObjects.set(appliance.id, object);
      }

      this.placeApplianceObject(world, appliance, object);

      const label = object.userData.label as THREE.Object3D | undefined;
      if (label) label.visible = false;

      const phase = workPhase(appliance, this.clock.elapsedTime);

      // The knife swings with the chop, on the same phase as the chef's arms.
      const knife = object.userData.knife as THREE.Object3D | undefined;
      if (knife) {
        const lift = appliance.motion === "chop" ? chopLift(phase) : 0;
        knife.rotation.z = lift * 1.15;
        knife.position.y = applianceDef(appliance.kind).height + 0.09 + lift * 0.1;
      }

      // Fryers and ovens work unattended, so they have to advertise it
      // themselves — the progress bar only shows when you're stood there.
      const frying = appliance.motion === "fry";
      const oil = object.userData.oil as THREE.Mesh | undefined;
      if (oil) {
        const glow = object.userData.oilGlow as THREE.MeshStandardMaterial;
        const boil = Math.sin(phase) * 0.5 + Math.sin(phase * 2.7) * 0.5;
        oil.position.y = applianceDef(appliance.kind).height + 0.05 + (frying ? boil * 0.012 : 0);
        oil.scale.y = frying ? 1 + boil * 0.35 : 1;
        glow.emissiveIntensity = frying ? 0.7 + boil * 0.5 : 0.4;
        const basket = object.userData.basket as THREE.Object3D | undefined;
        if (basket) basket.rotation.z = 0.4 + (frying ? Math.sin(phase * 0.7) * 0.12 : 0);
      }

      const glass = object.userData.glass as THREE.MeshStandardMaterial[] | undefined;
      if (glass) {
        // Slow, uneven ember glow: an oven does not blink, it breathes.
        // Kept low on purpose: pushed hard the emissive washes the dark glass
        // out to flat orange paint. It should read as embers behind a window.
        const heat =
          appliance.motion === "bake"
            ? 0.3 + Math.sin(phase) * 0.12 + Math.sin(phase * 3.3) * 0.05
            : 0;
        for (const g of glass) g.emissiveIntensity = heat;
      }

      // The bin lid flips open for a moment when something goes in.
      const lid = object.userData.lid as THREE.Object3D | undefined;
      if (lid) {
        const open = this.binOpen.get(appliance.id) ?? 0;
        lid.rotation.x = -open * 1.15;
      }

      this.syncDial(appliance, object);
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
   *
   * It slides rather than snapping, fades in when picked up and pops when set
   * down, so the appliance never appears or vanishes without a transition.
   */
  private placeApplianceObject(world: World, appliance: Appliance, object: THREE.Object3D): void {
    const held = appliance.heldBy !== null ? playerById(world, appliance.heldBy) : undefined;
    const state = (this.heldState[appliance.id] ??= {
      alpha: 0,
      x: 0,
      z: 0,
      pop: 0,
      started: false,
    });

    if (held) {
      const tile = targetTile(held);
      const valid = canPlace(world, tile.x, tile.y);
      const inGrid = tile.x >= 0 && tile.y >= 0 && tile.x < world.width && tile.y < world.height;
      // The ghost always answers "where would this go"; whether it *settles* or
      // stays hovering answers "can it". Two questions, two channels — plus the
      // highlight underneath turns red. Off the grid entirely there is no tile
      // to point at, so it stays with the chef.
      const targetX = inGrid ? tile.x + 0.5 : held.pos.x;
      const targetZ = inGrid ? tile.y + 0.5 : held.pos.y;

      if (!state.started) {
        state.started = true;
        state.x = held.pos.x;
        state.z = held.pos.y;
        state.alpha = 0;
        setGhost(object, true);
      }
      const chase = Math.min(1, this.frameDt * 16);
      state.x += (targetX - state.x) * chase;
      state.z += (targetZ - state.z) * chase;
      state.alpha = Math.min(1, state.alpha + this.frameDt * 6);

      const settle = state.alpha * state.alpha;
      // Valid: sinks onto the tile. Invalid: hangs above it with a slow bob,
      // which reads as "held" rather than "placed" without needing a colour.
      const hover = 0.42 + Math.sin(this.clock.elapsedTime * 3) * 0.03;
      object.position.set(state.x, valid ? 0.06 * (2 - settle) : hover, state.z);
      object.scale.setScalar(0.86 + 0.14 * settle);
      setGhostOpacity(object, valid ? state.alpha : state.alpha * 0.7);
      return;
    }

    if (state.started) {
      // Just set down: go solid and pop.
      state.started = false;
      state.alpha = 0;
      state.pop = 1;
      setGhost(object, false);
    }
    state.pop = Math.max(0, state.pop - this.frameDt * 4);
    const pop = state.pop * state.pop;
    object.position.set(appliance.tile.x + 0.5, 0, appliance.tile.y + 0.5);
    object.scale.set(1 + 0.13 * pop, 1 - 0.18 * pop, 1 + 0.13 * pop);
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
  private syncDial(appliance: Appliance, object: THREE.Object3D): void {
    const dial = object.userData.dial as Dial;
    const burning = appliance.overcook > 0;
    const active = appliance.progress > 0.001;

    const state = (this.dialState[appliance.id] ??= { alpha: 0, flash: 0 });
    // Ease in fast, out slow: appearing should feel instant, leaving should not
    // snatch the last frame of information away.
    const target = active ? 1 : 0;
    const rate = active ? 9 : 4;
    state.alpha += (target - state.alpha) * Math.min(1, rate * this.frameDt);
    if (appliance.justFinished) state.flash = 1;
    state.flash = Math.max(0, state.flash - this.frameDt * 3.2);

    const pulse = burning ? 1 + Math.sin(this.clock.elapsedTime * 14) * 0.09 : 1;
    dial.apply({
      progress: appliance.progress,
      color: burning ? PALETTE.progressBurn : cookingColor(appliance),
      alpha: state.alpha,
      flash: state.flash * state.flash,
      scale: pulse * (1 + state.flash * 0.28),
    });
  }

  // --- chefs -----------------------------------------------------------------

  /**
   * All chef animation is derived from simulation state — never stored in it.
   * Walk cycle, forward lean and the squash on pickup do more for how the game
   * feels than any amount of extra geometry would.
   */
  /**
   * Turn one-shot sim cues into things you can see. Effects carry ids and live
   * for a second, so a frame spanning several ticks can never miss one; we just
   * remember the highest id already shown.
   */
  private syncEffects(world: World, dt: number): void {
    // A reset (or going online) hands us a world whose id counter starts over.
    // Keeping the old high-water mark would silently suppress every effect
    // until the new world counted past it.
    if (world.nextId < this.lastEffectId) this.lastEffectId = 0;

    for (const cue of world.effects) {
      if (cue.id <= this.lastEffectId) continue;
      this.lastEffectId = cue.id;
      if (cue.kind === "served") {
        const player = playerById(world, cue.playerId);
        if (player)
          this.popups.spawn(`+$${cue.amount}`, "#ffd479", player.pos.x, 1.5, player.pos.y);
      } else if (cue.kind === "tipped") {
        // A different colour from the delivery reward, because it is a
        // different decision being paid for: coming back to clear the table.
        const player = playerById(world, cue.playerId);
        if (player)
          this.popups.spawn(`+$${cue.amount}`, "#b8e08a", player.pos.x, 1.5, player.pos.y);
      } else if (cue.kind === "paid") {
        this.popups.spawn(`+$${cue.amount}`, "#ffd479", cue.tile.x + 0.5, 1.5, cue.tile.y + 0.5);
      } else if (cue.kind === "walkout") {
        this.popups.spawn("walked out", "#e08a6f", cue.tile.x + 0.5, 1.3, cue.tile.y + 0.5);
      } else if (cue.kind === "binned") {
        const appliance = applianceAtTile(world, cue.tile.x, cue.tile.y);
        if (appliance) this.binOpen.set(appliance.id, 1);
      }
    }
    for (const [id, open] of this.binOpen) {
      const next = open - dt * 2.2;
      if (next <= 0) this.binOpen.delete(id);
      else this.binOpen.set(id, next);
    }
    this.popups.update(dt);
  }

  private syncChefs(world: World, alpha: number, dt: number): void {
    const live = new Set(world.players.map((player) => player.id));
    for (const [id, chef] of this.chefs) {
      if (live.has(id)) continue;
      this.scene.remove(chef.root);
      this.chefs.delete(id);
      this.tagColors.delete(id);
    }
    for (const player of world.players) {
      if (!this.tagColors.has(player.id)) {
        this.tagColors.set(player.id, this.tagColors.size % PLAYER_COLORS.length);
      }
    }

    const time = this.clock.elapsedTime;

    for (const player of world.players) {
      let chef = this.chefs.get(player.id);
      if (!chef) {
        const parts = buildChef(this.tagColors.get(player.id) ?? this.chefs.size);
        this.scene.add(parts.root);
        chef = { ...parts, phase: 0, pop: 0, lastCarried: 0 };
        this.chefs.set(player.id, chef);
      }

      // A held seat is faded out, reusing the placement-ghost machinery. It has
      // to be visibly *not* a player standing idle, or the others will keep
      // waiting for them to do something. The name tag stays solid — knowing
      // who is missing is the point.
      if (player.away !== chef.wasAway) {
        chef.wasAway = player.away;
        setGhost(chef.root, player.away);
      }

      // Name tags only exist online, where there is a name to show. Offline
      // everyone is in the same room and floating labels are just clutter.
      if (player.name !== chef.tagName) {
        if (chef.tag) chef.root.remove(chef.tag);
        chef.tagName = player.name;
        chef.tag = player.name
          ? makeNameTag(player.name, PLAYER_COLORS[this.tagColors.get(player.id) ?? 0]!)
          : undefined;
        if (chef.tag) {
          chef.tag.position.y = 1.34;
          chef.root.add(chef.tag);
        }
      }
      const x = lerp(player.prevPos.x, player.pos.x, alpha);
      const z = lerp(player.prevPos.y, player.pos.y, alpha);
      chef.root.position.set(x, 0, z);
      chef.root.rotation.y = Math.atan2(player.facing.x, player.facing.y);

      // 0..1 fraction of top speed, from how far the sim moved them this tick.
      const moved = Math.hypot(player.pos.x - player.prevPos.x, player.pos.y - player.prevPos.y);
      const speed = Math.min(1, moved / (PLAYER_SPEED * DT));
      chef.phase += dt * (6 + 8 * speed);

      const swing = Math.sin(chef.phase * 2) * speed;
      const carrying = player.carried !== null || player.carriedAppliance !== null;

      const station =
        player.workingOn !== null ? world.appliances.get(player.workingOn) : undefined;
      // Fryers and ovens cook by themselves; standing at one is not an action.
      const motion = isChefMotion(station?.motion ?? null) ? station!.motion : null;

      // Baseline pose, overwritten below by whichever pose is active. Every
      // channel a pose touches must be reset here, or it sticks once the pose
      // ends (a chef who kneaded once would lean forever).
      chef.body.position.y =
        0.28 + Math.abs(Math.sin(chef.phase * 2)) * 0.05 * speed + Math.sin(time * 2.2) * 0.008;
      chef.body.position.z = 0;
      chef.body.rotation.x = 0.16 * speed;
      chef.head.rotation.x = -0.1 * speed;

      if (motion && station) {
        this.poseWorking(chef, motion as ChefMotion, workPhase(station, time));
      } else if (carrying) {
        // Both hands out front, holding the item.
        chef.armL.rotation.x = -1.35 + swing * 0.12;
        chef.armR.rotation.x = -1.35 - swing * 0.12;
        chef.armL.rotation.z = 0.25;
        chef.armR.rotation.z = -0.25;
      } else {
        chef.armL.rotation.x = swing * 0.8;
        chef.armR.rotation.x = -swing * 0.8;
        chef.armL.rotation.z = 0.08;
        chef.armR.rotation.z = -0.08;
      }
      if (!motion) {
        chef.legL.rotation.x = -swing * 0.85;
        chef.legR.rotation.x = swing * 0.85;
      }

      // Squash-and-stretch pop whenever what they're holding changes.
      const carriedId = player.carried?.id ?? 0;
      if (carriedId !== chef.lastCarried) {
        chef.lastCarried = carriedId;
        chef.pop = 1;
      }
      chef.pop = Math.max(0, chef.pop - dt * 5);
      const pop = chef.pop * chef.pop;
      chef.body.scale.set(1 + 0.16 * pop, 1 - 0.2 * pop, 1 + 0.16 * pop);
    }
  }

  /**
   * Working poses. Each motion has its own rhythm and shape so a glance tells
   * you what a chef is doing, even off-screen-edge or behind a counter.
   */
  private poseWorking(chef: ChefParts, motion: ChefMotion, phase: number): void {
    switch (motion) {
      case "chop": {
        // Both hands on the knife: raise high, slam down, recoil.
        const lift = chopLift(phase);
        const hit = chopImpact(phase);
        chef.armL.rotation.x = -0.7 - lift * 1.75;
        chef.armR.rotation.x = chef.armL.rotation.x;
        // Elbows flare wide on the way up. Anatomically it lets go of the
        // knife, but a chef working a counter to the north faces away from a
        // fixed camera, and arms held together vanish behind their own torso.
        // Swinging them clear of the silhouette is what makes the chop read.
        chef.armL.rotation.z = 0.3 - lift * 0.55;
        chef.armR.rotation.z = -chef.armL.rotation.z;
        // Rock back with the lift, punch forward into the strike.
        chef.body.rotation.x = 0.24 - lift * 0.13 + hit * 0.18;
        chef.body.position.y -= hit * 0.035;
        chef.head.rotation.x = 0.1 + hit * 0.14;
        chef.legL.rotation.x = 0;
        chef.legR.rotation.x = 0;
        break;
      }
      case "knead": {
        // Slower, heavier: lean in and push down with the whole body.
        const push = Math.sin(phase);
        chef.armL.rotation.x = -1.25 - push * 0.25;
        chef.armR.rotation.x = chef.armL.rotation.x;
        chef.armL.rotation.z = 0.16;
        chef.armR.rotation.z = -0.16;
        chef.body.rotation.x = 0.3 + push * 0.14;
        chef.body.position.z = push * 0.05;
        chef.head.rotation.x = 0.2;
        chef.legL.rotation.x = 0;
        chef.legR.rotation.x = 0;
        break;
      }
      case "mix": {
        chef.armL.rotation.x = -1.3 + Math.sin(phase) * 0.28;
        chef.armR.rotation.x = -1.3 + Math.sin(phase + Math.PI) * 0.28;
        chef.armL.rotation.z = 0.2 + Math.cos(phase) * 0.25;
        chef.armR.rotation.z = -0.2 + Math.cos(phase) * 0.25;
        chef.body.rotation.x = 0.22;
        chef.head.rotation.x = 0.14;
        chef.legL.rotation.x = 0;
        chef.legR.rotation.x = 0;
        break;
      }
    }
  }

  // --- customers -------------------------------------------------------------

  /**
   * Customers use the chef rig and the chef walk cycle, with two states of
   * their own: **seated** (dropped onto the chair, knees forward, facing the
   * table) and **impatient** (a slump that deepens as the ring runs down).
   *
   * The slump is the point of putting people in the room at all. A ticket going
   * red is information; somebody sinking into their chair is the same
   * information, readable from the fryer without looking away from it.
   */
  private syncCustomers(world: World, alpha: number, dt: number): void {
    const live = new Set(world.customers.map((customer) => customer.id));
    for (const [id, parts] of this.customers) {
      if (live.has(id)) continue;
      this.scene.remove(parts.root);
      this.customers.delete(id);
    }

    const time = this.clock.elapsedTime;
    for (const customer of world.customers) {
      let person = this.customers.get(customer.id);
      if (!person) {
        // Indexed by id so the same customer keeps the same coat all visit, and
        // two people arriving together rarely match.
        const parts = buildCustomer(customer.id);
        this.scene.add(parts.root);
        person = { ...parts, phase: 0, slump: 0 };
        this.customers.set(customer.id, person);
      }

      let x = lerp(customer.prevPos.x, customer.pos.x, alpha);
      let z = lerp(customer.prevPos.y, customer.pos.y, alpha);
      // The simulation seats people on the tile beside the table, because tiles
      // are what it can reason about. The chair is half a tile in from there,
      // so the drawing pulls them onto it — sitting a foot away from your own
      // chair looks like a bug even when the rules are right.
      const table = customer.table === null ? undefined : world.appliances.get(customer.table);
      if (table && customer.state !== "arriving" && customer.state !== "leaving") {
        x += (table.tile.x + 0.5 - x) * 0.42;
        z += (table.tile.y + 0.5 - z) * 0.42;
      }
      person.root.position.set(x, 0, z);
      person.root.rotation.y = Math.atan2(customer.facing.x, customer.facing.y);

      const moved = Math.hypot(
        customer.pos.x - customer.prevPos.x,
        customer.pos.y - customer.prevPos.y,
      );
      const speed = Math.min(1, moved / (CUSTOMER_SPEED * DT));
      person.phase += dt * (5 + 7 * speed);
      const swing = Math.sin(person.phase * 2) * speed;

      const seated =
        customer.state === "deciding" ||
        customer.state === "ordering" ||
        customer.state === "eating";

      // Impatience builds only while there is something to be impatient about.
      const impatient =
        customer.state === "ordering" ? 1 - Math.max(0, customer.remaining / customer.patience) : 0;
      person.slump += (impatient - person.slump) * Math.min(1, dt * 2);
      const slump = person.slump * person.slump;

      // Seated is *higher* than standing, not lower: the hips land on the chair
      // rather than on the floor. Getting this backwards put every customer's
      // head level with the tabletop, where it read as a lump behind the plate
      // instead of as a person waiting for it.
      person.body.position.y =
        (seated ? SEAT_HEIGHT : 0.28) + Math.abs(Math.sin(person.phase * 2)) * 0.05 * speed;
      person.body.position.z = 0;
      person.body.rotation.x = 0.14 * speed + slump * 0.34;
      person.head.rotation.x = -0.08 * speed + slump * 0.3;
      // Only the eating pose squashes the head; everything else must put it
      // back, or one meal would leave a customer dented for the rest of the day.
      person.head.scale.set(1, 1, 1);

      if (customer.state === "eating") {
        this.poseEating(person, customer, time);
      } else if (seated) {
        // Knees up, hands resting on the table edge, sinking as patience goes.
        person.legL.rotation.x = -1.35;
        person.legR.rotation.x = -1.35;
        person.armL.rotation.x = -0.9 + slump * 0.5;
        person.armR.rotation.x = -0.9 + slump * 0.5;
        person.armL.rotation.z = 0.2;
        person.armR.rotation.z = -0.2;
        // A restless glance around the room, faster the longer they have waited.
        person.head.rotation.y =
          Math.sin(time * (0.7 + slump * 1.6) + customer.id) * 0.24 * (0.3 + slump);
      } else {
        person.legL.rotation.x = -swing * 0.85;
        person.legR.rotation.x = swing * 0.85;
        person.armL.rotation.x = swing * 0.8;
        person.armR.rotation.x = -swing * 0.8;
        person.armL.rotation.z = 0.08;
        person.armR.rotation.z = -0.08;
        person.head.rotation.y = 0;
      }
    }
  }

  /**
   * Eating: fork up, bite, chew, repeat.
   *
   * Dwell time is a throughput constraint — a table is occupied for as long as
   * somebody is sitting at it — so "still eating" has to be legible from the
   * other side of the kitchen, and legible as *progress* rather than as an
   * idle. Hence a cycle with a clear beat rather than a loop of noise: the arm
   * arriving at the mouth is the moment the eye catches, and the chewing after
   * it is what stops the pose reading as frozen between bites.
   *
   * Driven by wall clock rather than by the meal timer, offset per customer, so
   * a full dining room never chews in unison.
   */
  private poseEating(person: ChefParts, customer: Customer, time: number): void {
    // A bob, not a mime. An earlier version raised a fork to the mouth on a
    // proper bite cycle, and almost none of it survived the trip to the screen:
    // a customer faces their table, which from a fixed camera means facing
    // away, so the entire performance happened behind their own back. What
    // does read at this size is the head — it is the biggest thing on them and
    // the only part clear of the tabletop.
    //
    // `abs(sin)` rather than a sine: the bounce off the bottom is what makes it
    // munching rather than nodding.
    const munch = Math.abs(Math.sin(time * MUNCH_RATE + customer.id));

    person.legL.rotation.x = -1.35;
    person.legR.rotation.x = -1.35;

    person.body.rotation.x = 0.16 + munch * 0.06;
    person.body.position.y = SEAT_HEIGHT - munch * 0.014;
    person.head.rotation.x = 0.08 + munch * 0.34;
    person.head.rotation.y = 0;
    // A little squash on the way down. Cartoon licence, and it is what stops
    // the bob reading as a stiff hinge.
    person.head.scale.set(1 + munch * 0.07, 1 - munch * 0.09, 1 + munch * 0.07);

    // Both hands stay on the table, out of the way of the one part that reads.
    person.armL.rotation.x = -0.95;
    person.armR.rotation.x = -0.95;
    person.armL.rotation.z = 0.22;
    person.armR.rotation.z = -0.22;
  }

  // --- tables ----------------------------------------------------------------

  /**
   * What a table has to say: the order bubble above it, and the tip left on it.
   *
   * Both are keyed by appliance id and torn down when the appliance goes, which
   * it can — a reset renumbers the kitchen and online the server can hand us a
   * different layout entirely.
   */
  private syncTables(world: World, dt: number): void {
    for (const [id, bubble] of this.bubbles) {
      const object = this.applianceObjects.get(id);
      if (object && world.appliances.get(id)?.kind === "table") continue;
      if (object) bubble.dispose(object);
      this.bubbles.delete(id);
    }
    for (const [id, tip] of this.tips) {
      if (world.appliances.get(id)?.kind === "table") continue;
      this.applianceObjects.get(id)?.remove(tip.object);
      this.tips.delete(id);
    }

    // Recomputed only in the build phase: during service nothing can move, so
    // the answer cannot change, and the flood fill would be pure waste.
    if (world.phase === "build") {
      this.stranded = new Set(unreachableTables(world).map((table) => table.id));
    } else if (this.stranded.size > 0) {
      this.stranded.clear();
    }

    for (const appliance of world.appliances.values()) {
      if (appliance.kind !== "table") continue;
      const object = this.applianceObjects.get(appliance.id);
      if (!object) continue;

      let bubble = this.bubbles.get(appliance.id);
      if (!bubble) {
        bubble = new Bubble(this.camera);
        object.add(bubble.object);
        this.bubbles.set(appliance.id, bubble);
        // A table nobody can walk to is the one build-phase mistake that
        // silently ends a run, so it is marked in the room rather than only
        // mentioned in the log. Same red as a burning pan: this needs you.
        const warning = buildHighlight(PALETTE.progressBurn);
        // Above the tabletop, not under it: on the floor the table's own
        // footprint hides most of the ring, which is a poor showing for the
        // one marker that means "this will not work tomorrow".
        warning.position.y = applianceDef("table").height + 0.14;
        warning.scale.setScalar(1.15);
        warning.visible = false;
        object.add(warning);
        object.userData.warning = warning;
      }

      const warning = object.userData.warning as THREE.Mesh | undefined;
      if (warning) {
        warning.visible = world.phase === "build" && this.stranded.has(appliance.id);
        if (warning.visible) {
          const material = warning.material as THREE.MeshBasicMaterial;
          material.opacity = 0.62 + Math.sin(this.clock.elapsedTime * 5) * 0.3;
        }
      }
      const customer =
        world.customers.find((c) => c.table === appliance.id && c.state === "ordering") ?? null;
      bubble.update(customer, dt);

      // The tip rises out of the table when it appears and sinks away when
      // collected, so money never simply blinks into or out of the room.
      let tip = this.tips.get(appliance.id);
      if (!tip) {
        const coins = buildTipStack();
        // Off to one side: the middle of the table belongs to the plate that
        // has to be picked up with it.
        coins.position.set(0.26, applianceDef("table").height + 0.04, -0.22);
        coins.visible = false;
        object.add(coins);
        tip = { object: coins, alpha: 0 };
        this.tips.set(appliance.id, tip);
      }
      const wanted = appliance.tip > 0 ? 1 : 0;
      tip.alpha += (wanted - tip.alpha) * Math.min(1, dt * (wanted ? 11 : 7));
      tip.object.visible = tip.alpha > 0.01;
      if (tip.object.visible) {
        const settle = tip.alpha * tip.alpha;
        tip.object.scale.setScalar(settle);
        tip.object.position.y = applianceDef("table").height + 0.04 + (1 - settle) * 0.12;
        tip.object.rotation.y += dt * 0.8;
      }
    }
  }

  // --- items -----------------------------------------------------------------

  private syncItems(world: World, alpha: number): void {
    this.liveItems.clear();

    // How much of each meal is left, so the plate can empty as it is eaten.
    this.eatingTables.clear();
    for (const customer of world.customers) {
      if (customer.state !== "eating" || customer.table === null) continue;
      this.eatingTables.set(customer.table, Math.max(0, Math.min(1, customer.timer / EAT_TIME)));
    }

    for (const appliance of world.appliances.values()) {
      if (!appliance.item || appliance.heldBy !== null) continue;
      const height = applianceDef(appliance.kind).height;
      const object = this.placeItem(
        appliance.item,
        appliance.tile.x + 0.5,
        height + 0.06,
        appliance.tile.y + 0.5,
      );
      // Food squashes on the beat, so the work reads even when the chef is
      // hidden behind the counter they're working at.
      animateWorkedItem(object, appliance, this.clock.elapsedTime);
      // ...and shrinks as it is eaten, so the dirty plate that follows is the
      // end of something you watched happen rather than a swap.
      setPlateFullness(object, this.eatingTables.get(appliance.id) ?? 1);
    }

    for (const player of world.players) {
      if (!player.carried) continue;
      const chef = this.chefs.get(player.id);
      if (!chef) continue;
      // Anchor to the chef's hands so the carried item inherits the walk cycle.
      chef.carry.getWorldPosition(WORLD_POS);
      this.placeItem(player.carried, WORLD_POS.x, WORLD_POS.y, WORLD_POS.z).scale.set(1, 1, 1);
    }

    void alpha;

    for (const [id, entry] of this.itemObjects) {
      if (this.liveItems.has(id)) continue;
      this.scene.remove(entry.object);
      this.itemObjects.delete(id);
    }
  }

  private placeItem(item: Item, x: number, y: number, z: number): THREE.Object3D {
    this.liveItems.add(item.id);
    const key = itemVisualKey(item);
    let entry = this.itemObjects.get(item.id);
    if (!entry || entry.key !== key) {
      if (entry) this.scene.remove(entry.object);
      entry = { object: buildItemModel(item), key };
      this.scene.add(entry.object);
      this.itemObjects.set(item.id, entry);
    }
    entry.object.position.set(x, y, z);
    return entry.object;
  }

  // --- interaction highlights ------------------------------------------------

  private syncHighlights(world: World): void {
    const live = new Set(world.players.map((player) => player.id));
    for (const [id, mesh] of this.highlights) {
      if (live.has(id)) continue;
      this.scene.remove(mesh);
      this.highlights.delete(id);
    }
    for (const player of world.players) {
      let mesh = this.highlights.get(player.id);
      if (!mesh) {
        mesh = buildHighlight(PLAYER_COLORS[this.highlights.size % PLAYER_COLORS.length]!);
        this.scene.add(mesh);
        this.highlights.set(player.id, mesh);
      }
      const tile = targetTile(player);
      const inside = tile.x >= 0 && tile.y >= 0 && tile.x < world.width && tile.y < world.height;
      mesh.visible = inside;
      if (!inside) continue;

      const appliance = applianceAtTile(world, tile.x, tile.y);
      const height = appliance ? applianceDef(appliance.kind).height + 0.1 : 0.03;
      mesh.position.set(tile.x + 0.5, height, tile.y + 0.5);

      // Name the thing you're pointing at, and only that thing — but yield to
      // the progress bar, which occupies the same space and says more.
      if (appliance && appliance.progress <= 0.001) {
        const label = this.applianceObjects.get(appliance.id)?.userData.label as
          | THREE.Object3D
          | undefined;
        if (label) label.visible = true;
      }

      const material = mesh.material as THREE.MeshBasicMaterial;
      const placing = world.phase === "build" && player.carriedAppliance !== null;
      const blocked = placing && !canPlace(world, tile.x, tile.y);
      material.color.setHex(
        blocked
          ? PALETTE.progressBurn
          : world.phase === "build"
            ? PALETTE.progressGood
            : PLAYER_COLORS[this.tagColors.get(player.id) ?? 0]!,
      );
      material.opacity = blocked ? 0.7 : appliance ? 0.75 : 0.28;
    }
  }
}

const WORLD_POS = new THREE.Vector3();

/**
 * Hip height of a seated customer, a touch below the chair seat in
 * `buildTable` so they settle into it rather than hover.
 */
const SEAT_HEIGHT = 0.3;

/**
 * Radians per second of the eating bob. Offset per customer by their id, so a
 * full dining room never munches in unison.
 */
const MUNCH_RATE = 4.6;

/**
 * Shrink the food on a plate without shrinking the plate.
 *
 * The plate model keeps its contents in their own group precisely so this can
 * happen: scaling the whole object would shrink the crockery too, which reads
 * as the plate receding rather than the meal going down.
 */
function setPlateFullness(object: THREE.Object3D, fullness: number): void {
  const contents = object.userData.contents as THREE.Object3D | undefined;
  if (!contents) return;
  // Never quite to nothing: what is left becomes the crumbs on the dirty plate
  // a moment later, and food that vanished first would break that handover.
  contents.scale.setScalar(0.22 + 0.78 * fullness);
}

/**
 * Per-motion reaction of the food itself. Chopped food is struck, kneaded food
 * is pressed, frying food bobs in the oil and baking food barely moves — the
 * appliance is doing the work, not the ingredient.
 */
function animateWorkedItem(object: THREE.Object3D, appliance: Appliance, time: number): void {
  const motion = appliance.motion;
  if (!motion) {
    object.scale.set(1, 1, 1);
    return;
  }
  const phase = workPhase(appliance, time);
  if (motion === "fry") {
    object.position.y += Math.sin(phase) * 0.035;
    object.rotation.y = Math.sin(phase * 0.6) * 0.25;
    object.scale.set(1, 1, 1);
    return;
  }
  if (motion === "bake") {
    const swell = 1 + Math.sin(phase) * 0.03;
    object.scale.set(swell, swell, swell);
    return;
  }
  const beat = motion === "chop" ? chopImpact(phase) : Math.max(0, Math.sin(phase));
  const squash = motion === "chop" ? 0.3 : 0.14;
  object.scale.set(1 + beat * squash * 0.5, 1 - beat * squash, 1 + beat * squash * 0.5);
}

/** Prep and cooking feel different, so their gauges look different. */
function cookingColor(appliance: Appliance): number {
  return appliance.motion === "fry" || appliance.motion === "bake"
    ? PALETTE.progressCook
    : PALETTE.progressGood;
}

/** Cycles per second for each action. */
const WORK_RATE: Record<Motion, number> = { chop: 3.8, knead: 1.1, mix: 1.8, fry: 1.7, bake: 0.45 };

const CHEF_MOTIONS = new Set<Motion>(["chop", "knead", "mix"]);
function isChefMotion(motion: Motion | null): motion is ChefMotion {
  return motion !== null && CHEF_MOTIONS.has(motion);
}

const TAU = Math.PI * 2;

/** Fractions of one chop cycle: lift, strike, then rest. */
const CHOP_RAISE = 0.55;
const CHOP_FALL = 0.17;
const CHOP_RECOIL = 0.22;

/**
 * A chop is not a sine wave. It lifts slowly, hangs at the top, then falls
 * *fast* and stays down while the chef resets — the pause at the bottom is what
 * makes the next strike read as a strike. 0 = knife on the board, 1 = top of
 * the swing.
 */
function chopLift(phase: number): number {
  const u = (phase / TAU) % 1;
  if (u < CHOP_RAISE) {
    const t = u / CHOP_RAISE;
    return 1 - (1 - t) * (1 - t); // ease out into the hang
  }
  if (u < CHOP_RAISE + CHOP_FALL) {
    const t = (u - CHOP_RAISE) / CHOP_FALL;
    return 1 - t * t; // ease in: the strike accelerates
  }
  return 0;
}

/**
 * 1 on the frame the knife lands, decaying fast. Drives the chef's recoil and
 * the food's squash, so the hit lands on both at once.
 */
function chopImpact(phase: number): number {
  const since = ((phase / TAU) % 1) - (CHOP_RAISE + CHOP_FALL);
  if (since < 0 || since > CHOP_RECOIL) return 0;
  return 1 - since / CHOP_RECOIL;
}

/**
 * One shared phase per appliance drives the chef's arms, the knife and the food
 * together, so the whole action lands on the same beat. Offsetting by id keeps
 * two chefs working side by side from looking like a chorus line.
 */
function workPhase(appliance: Appliance, time: number): number {
  const rate = appliance.motion ? WORK_RATE[appliance.motion] : 0;
  return time * rate * TAU + appliance.id * 1.7;
}

function itemVisualKey(item: Item): string {
  const own = specKey(item);
  if (item.contents.length === 0) return own;
  return `${own}[${item.contents.map(itemVisualKey).join(";")}]`;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
