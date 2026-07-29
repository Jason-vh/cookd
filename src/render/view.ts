import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { EffectCue, World } from "../sim/types";
import { applianceAtTile, playerById } from "../sim/world";
import { biome as lookupBiome } from "../data/biomes";
import { lerp } from "./anim";
import { ApplianceViews } from "./appliance-views";
import { KitchenCamera, type FollowTarget } from "./camera";
import { disposeSubtree } from "./dispose";
import { createEnvironment } from "./environment";
import { HighlightViews } from "./highlight-views";
import { ItemViews } from "./item-views";
import { mergeStatic } from "./merge";
import { buildDoorway, buildWall, floorTexture } from "./shell-meshes";
import { PALETTE } from "./palette";
import { PeopleViews } from "./people-views";
import { Popups } from "./popups";
import { TableViews } from "./table-views";
import { createPost, postEnabled, type Post } from "./post";

/**
 * The render layer mirrors the simulation; it never writes to it.
 *
 * This file is the composition root: it owns the renderer, the lighting, the
 * camera and the kitchen shell, and it delegates every *entity* to a view
 * module beside it. Each of those has the same shape — a `Map` keyed by
 * simulation id, with add, remove and update — and each is separately
 * disposable.
 *
 * It used to be all of them at once, at 1074 lines: appliances, chef rigs,
 * customer rigs, tables, items, highlights, effect cues, lighting, camera and
 * the animation maths, in one class with fifteen mutable maps. Every new entity
 * type widened it, and none of the maths inside it could be reached by a test,
 * because importing this file touches `window`.
 *
 * Art direction lives in `palette.ts` (colour) and `meshes.ts` (form).
 */
/**
 * The rectangle the walls enclose, in tiles.
 *
 * "The kitchen" and "the world" used to be the same rectangle, and several
 * things quietly relied on it. They stopped being the same the day the patio
 * ring became real tiles, so the building has to be found rather than assumed.
 */
function wallBounds(world: World): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = world.width;
  let minY = world.height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      if (!world.tiles[y * world.width + x]?.wall) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return minX > maxX
    ? { minX: 0, minY: 0, maxX: world.width - 1, maxY: world.height - 1 }
    : { minX, minY, maxX, maxY };
}

export class View {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;

  private readonly rig: KitchenCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private post: Post | null = null;
  private readonly grade: { saturation: number; warmth: number; lift: number };

  private readonly appliances: ApplianceViews;
  private readonly people: PeopleViews;
  private readonly tables: TableViews;
  private readonly items: ItemViews;
  private readonly highlights: HighlightViews;
  private readonly popups = new Popups(this.scene);

  private readonly clock = new THREE.Clock();
  private lastEffectId = 0;
  /** Reused every frame so following allocates nothing. */
  private readonly followTargets: FollowTarget[] = [];
  private readonly shell: THREE.Object3D[] = [];
  private readonly onResize = (): void => this.resize();

  constructor(canvas: HTMLCanvasElement, world: World, biomeId: string) {
    const biome = lookupBiome(biomeId);
    this.grade = biome.grade;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !postEnabled() });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = biome.exposure;

    // Orthographic at a 3/4 angle: real 3D, isometric read. It follows the
    // local chefs and never shows past these bounds — see render/camera.ts.
    this.rig = new KitchenCamera(
      new THREE.Box3(
        new THREE.Vector3(-0.4, -1.4, -0.4),
        new THREE.Vector3(world.width + 0.4, 2.0, world.height + 0.4),
      ),
    );
    this.camera = this.rig.camera;

    this.appliances = new ApplianceViews(this.scene, this.camera);
    this.people = new PeopleViews(this.scene);
    this.tables = new TableViews(this.camera, this.appliances);
    this.items = new ItemViews(this.scene, this.people);
    this.highlights = new HighlightViews(this.scene, this.appliances, this.people);

    // Sky, sunlight, ground and scenery all come from the biome.
    this.setupImageBasedLighting(biome.environmentIntensity);
    createEnvironment(this.scene, biome, { width: world.width, height: world.height });
    this.buildKitchenShell(world);

    this.resize();
    window.addEventListener("resize", this.onResize);
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
   * The kitchen itself: its tiled floor and its walls.
   *
   * Walls are fixed by the level and the floor never moves, so the whole shell
   * is baked down to one draw call per material alongside the scenery. There is
   * no rebuild path — a resizable kitchen or editable walls would need one.
   */
  private buildKitchenShell(world: World): void {
    const shell = new THREE.Group();

    // The kitchen is no longer the whole grid: the patio ring is part of the
    // world now, and it is paved by the biome rather than tiled by the kitchen.
    // Measured from the walls rather than passed in, because a floor is the
    // thing inside walls — and a level with a different ring would otherwise
    // have to remember to say so somewhere else as well.
    const room = wallBounds(world);
    const width = room.maxX - room.minX + 1;
    const height = room.maxY - room.minY + 1;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshStandardMaterial({
        map: floorTexture(width, height),
        roughness: 0.85,
        metalness: 0,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(room.minX + width / 2, 0.004, room.minY + height / 2);
    floor.receiveShadow = true;
    shell.add(floor);

    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const tile = world.tiles[y * world.width + x];
        if (tile?.door) {
          // The gap customers arrive through. A frame around it is what stops
          // it reading as a hole somebody forgot to wall up.
          const frame = buildDoorway();
          frame.position.set(x + 0.5, 0, y + 0.5);
          shell.add(frame);
          continue;
        }
        if (!tile?.wall) continue;
        // The two edges nearest the camera are a low lip, otherwise they would
        // occlude the kitchen. Which edges those are is a fact about the
        // *building*, not about the grid: with a patio ring the world's last
        // column is paving, and testing against it would leave the real near
        // walls at full height with the kitchen hidden behind them.
        const near = x === room.maxX || y === room.maxY;
        const wall = buildWall(near ? 0.26 : 1.1);
        wall.position.set(x + 0.5, 0, y + 0.5);
        shell.add(wall);
      }
    }

    const baked = mergeStatic(shell);
    this.shell.push(...baked);
    this.scene.add(...baked);
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
    const time = this.clock.elapsedTime;

    this.syncEffects(world, dt);
    this.appliances.sync(world, dt, time);
    this.people.syncChefs(world, alpha, dt, time);
    this.people.syncCustomers(world, alpha, dt, time);
    this.tables.sync(world, dt, time);
    this.items.sync(world, time);
    this.highlights.sync(world);
    this.popups.update(dt);
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

  /**
   * Turn one-shot sim cues into things you can see. Effects carry ids and live
   * for a second, so a frame spanning several ticks can never miss one; we just
   * remember the highest id already shown.
   */
  private syncEffects(world: World, dt: number): void {
    void dt;
    // A reset (or going online) hands us a world whose id counter starts over.
    // Keeping the old high-water mark would silently suppress every effect
    // until the new world counted past it.
    //
    // Judged from the cues themselves rather than from `world.nextId`: cues are
    // appended in id order and only ever dropped from the front, so the last
    // one is the highest id this world has reached. Asking `nextId` instead
    // spawned every popup once per *frame* online, where the drawn world is
    // filled in from the wire and its own counter never moves.
    const newest = world.effects.at(-1);
    if (newest && newest.id < this.lastEffectId) this.lastEffectId = 0;

    for (const cue of world.effects) {
      if (cue.id <= this.lastEffectId) continue;
      this.lastEffectId = cue.id;
      this.showCue(world, cue);
    }
  }

  /**
   * One cue, drawn.
   *
   * A `switch` with a `never` default rather than the if/else chain this used to
   * be: adding an `EffectCue` kind now fails the build instead of compiling
   * cleanly and rendering nothing at all.
   */
  private showCue(world: World, cue: EffectCue): void {
    switch (cue.kind) {
      case "served": {
        const player = playerById(world, cue.playerId);
        if (player) {
          this.popups.spawn(
            `+$${cue.amount}`,
            PALETTE.rewardServe,
            player.pos.x,
            1.5,
            player.pos.y,
          );
        }
        return;
      }
      case "tipped": {
        // A different colour from the delivery reward, because it is a
        // different decision being paid for: coming back to clear the table.
        const player = playerById(world, cue.playerId);
        if (player) {
          this.popups.spawn(`+$${cue.amount}`, PALETTE.rewardTip, player.pos.x, 1.5, player.pos.y);
        }
        return;
      }
      case "paid":
        this.popups.spawn(
          `+$${cue.amount}`,
          PALETTE.rewardServe,
          cue.tile.x + 0.5,
          1.5,
          cue.tile.y + 0.5,
        );
        return;
      case "walkout":
        this.popups.spawn(
          "walked out",
          PALETTE.lossWalkout,
          cue.tile.x + 0.5,
          1.3,
          cue.tile.y + 0.5,
        );
        return;
      case "binned": {
        const appliance = applianceAtTile(world, cue.tile.x, cue.tile.y);
        if (appliance) this.appliances.openBin(appliance.id);
        return;
      }
      case "spent":
        // Money going *out*, in its own colour. The same popup machinery as a
        // reward, deliberately: a purchase and a delivery are both "the number
        // in the corner just moved", and reading them the same way is what
        // makes rent land as a thing that happened rather than as a surprise
        // discovered later in the HUD.
        this.popups.spawn(
          `-$${cue.amount}`,
          PALETTE.spend,
          cue.tile.x + 0.5,
          1.5,
          cue.tile.y + 0.5,
        );
        return;
      case "refused": {
        const appliance = applianceAtTile(world, cue.tile.x, cue.tile.y);
        if (appliance) this.appliances.refuse(appliance.id);
        return;
      }
      default: {
        const unreachable: never = cue;
        throw new Error(`unhandled effect cue: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  /**
   * Give everything back.
   *
   * There was none of this, which was survivable only because exactly one
   * `View` is ever built and it lives as long as the tab. It is what "let the
   * player change biome" or "resize the kitchen" would have needed first.
   */
  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.appliances.dispose();
    this.people.dispose();
    this.tables.dispose();
    this.items.dispose();
    this.highlights.dispose();
    this.popups.dispose();
    for (const part of this.shell) disposeSubtree(part);
    this.shell.length = 0;
    this.scene.environment?.dispose();
    this.post?.dispose();
    this.renderer.dispose();
  }
}
