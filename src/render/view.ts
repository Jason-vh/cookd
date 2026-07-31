import * as THREE from "three";
import type { EffectCue, Rect, Seam, World } from "../sim/types";
import type { Biome } from "../data/biomes";
import { applianceAtTile, playerById } from "../sim/world";
import { hatchOf } from "../sim/lane";
import { edgeSeam, horizontalWall, verticalWall } from "../sim/walls";
import { biome as lookupBiome } from "../data/biomes";
import { cameraYaw } from "../orientation";
import { lerp } from "./anim";
import { ApplianceViews } from "./appliance-views";
import { CarViews } from "./car-views";
import { KitchenCamera, type FollowTarget } from "./camera";
import { disposeSubtree } from "./dispose";
import { createEnvironment, lightingEnvironment } from "./environment";
import { HighlightViews } from "./highlight-views";
import { ItemViews } from "./item-views";
import { mergeStatic } from "./merge";
import { buildDoorway, buildServingHatch, buildWall, floorTexture } from "./shell-meshes";
import { PALETTE } from "./palette";
import { PeopleViews } from "./people-views";
import { Popups } from "./popups";
import { OrderViews } from "./order-views";
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
 * Which of the four corners a yaw is looking from, as a value that can be
 * compared. Only which side of each axis the camera is on matters.
 */
function corner(yaw: number): string {
  return `${Math.sin(yaw) > 0 ? "+" : "-"}${Math.cos(yaw) > 0 ? "+" : "-"}`;
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
  private readonly cars: CarViews;
  private readonly tables: TableViews;
  private readonly orders: OrderViews;
  private readonly items: ItemViews;
  private readonly highlights: HighlightViews;
  private readonly popups = new Popups(this.scene);

  private readonly clock = new THREE.Clock();
  private lastEffectId = 0;
  /** Reused every frame so following allocates nothing. */
  private readonly followTargets: FollowTarget[] = [];
  private readonly shell: THREE.Object3D[] = [];
  /** Rebuilt when the camera crosses to another corner. See `buildWalls`. */
  private readonly walls: THREE.Object3D[] = [];
  private wallCorner = "";
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
    this.cars = new CarViews(this.scene);
    this.tables = new TableViews(this.appliances);
    // A customer is drawn as a person or as a car, never both, so the bubble
    // over their head asks for whichever of the two this kitchen has.
    this.orders = new OrderViews(
      this.scene,
      this.camera,
      (id) => this.people.customerRoot(id) ?? this.cars.carRoot(id),
    );
    this.items = new ItemViews(this.scene, this.people);
    this.highlights = new HighlightViews(this.scene, this.appliances, this.people);

    // Sky, sunlight, ground and scenery all come from the biome.
    this.setupImageBasedLighting(biome);
    createEnvironment(this.scene, biome, {
      width: world.width,
      height: world.height,
      lane: world.lane,
    });
    this.buildKitchenShell(world);

    this.resize();
    window.addEventListener("resize", this.onResize);
  }

  // --- scene setup -----------------------------------------------------------

  private setupImageBasedLighting(biome: Biome): void {
    // Image-based lighting with zero assets: soft directional variation and a
    // believable roughness response on every surface, which is the single
    // biggest quality win over plain analytic lights. The environment is built
    // out of the biome rather than out of three.js's white studio, so what a
    // steel rim catches is this kitchen's sky and this kitchen's sun.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const world = lightingEnvironment(biome);
    this.scene.environment = pmrem.fromScene(world, 0.04).texture;
    this.scene.environmentIntensity = biome.environmentIntensity;
    disposeSubtree(world);
    pmrem.dispose();
  }

  /**
   * The kitchen itself: its tiled floor and its walls.
   *
   * The floor never moves, so it is baked once. The walls are rebuilt whenever
   * the camera crosses to a new corner — see `buildWalls` for why they cannot
   * simply be baked with it.
   */
  private buildKitchenShell(world: World): void {
    const shell = new THREE.Group();

    // The kitchen is not the whole grid: the patio ring is part of the world
    // too, and it is paved by the biome rather than tiled by the kitchen. The
    // building says where it is — the renderer used to go looking for it by
    // scanning for wall tiles, which stopped being a thing to find the day
    // walls moved onto the seams.
    const { x, y, width, height } = world.room;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshStandardMaterial({
        map: floorTexture(width, height),
        roughness: 0.85,
        metalness: 0,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(x + width / 2, 0.004, y + height / 2);
    floor.receiveShadow = true;
    shell.add(floor);

    const baked = mergeStatic(shell);
    this.shell.push(...baked);
    this.scene.add(...baked);
    this.buildWalls(world);
  }

  /**
   * The walls, with the two edges nearest the camera cut down to a lip.
   *
   * Full-height near walls would stand between the camera and the kitchen, so
   * which two are near is not decoration — it is whether you can see the room
   * at all. That used to be a fact about the *building* alone (the south and
   * east runs, because that is where the camera stood); now the camera turns,
   * so it is a fact about the building **and** where we are looking from, and
   * the walls are rebuilt when that answer changes.
   *
   * Rebuilt rather than toggled because they are baked into one merged mesh per
   * material, which is what keeps a hundred wall segments off the draw call
   * budget. It happens on a keypress, four times around, and never during play.
   */
  private buildWalls(world: World): void {
    for (const part of this.walls) disposeSubtree(part);
    this.walls.length = 0;

    const yaw = this.rig.facing;
    this.wallCorner = corner(yaw);

    const room = world.room;
    // The near edges are the ones whose outside faces the camera: with the
    // camera at +x/+z those are the east and south lines of the shell, and each
    // quarter turn hands the lip to the next two runs. Only the shell gets it:
    // an interior wall cut to a lip would be a divider you could see over from
    // one side of the room and not the other.
    const nearX = Math.sin(yaw) > 0 ? room.x + room.width : room.x;
    const nearY = Math.cos(yaw) > 0 ? room.y + room.height : room.y;

    const group = new THREE.Group();
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x <= world.width; x++) {
        if (!verticalWall(world, x, y)) continue;
        const wall = buildWall(x === nearX ? 0.26 : 1.1, "vertical");
        wall.position.set(x, 0, y + 0.5);
        group.add(wall);
      }
    }
    for (let y = 0; y <= world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        if (!horizontalWall(world, x, y)) continue;
        const wall = buildWall(y === nearY ? 0.26 : 1.1, "horizontal");
        wall.position.set(x + 0.5, 0, y);
        group.add(wall);
      }
    }

    // The gaps in the shell. A frame around one is what stops it reading as a
    // hole somebody forgot to wall up — and a drive-through's hatch is a hole
    // in exactly the same sense, framed differently so that it reads as one.
    group.add(frameGap(edgeSeam(world.room, world.door), buildDoorway()));
    const hatch = hatchOf(world);
    if (hatch) {
      const seam = edgeSeam(world.room, hatch.tile);
      group.add(frameGap(seam, buildServingHatch(outward(world.room, seam))));
    }

    const baked = mergeStatic(group);
    this.walls.push(...baked);
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
    if (world.lane) this.cars.sync(world, alpha, dt, time);
    else this.people.syncCustomers(world, alpha, dt, time);
    this.tables.sync(world, dt);
    // After the people: a bubble follows the head it is drawn over, and reading
    // a rig that has not moved yet is a bubble one frame behind its customer.
    this.orders.sync(world, dt, time);
    this.items.sync(world, time);
    this.highlights.sync(world);
    this.popups.update(dt);
    // The kitchen is turned from outside the renderer, because the controls
    // have to turn with it — see `orientation.ts`.
    this.rig.setYaw(cameraYaw());
    this.rig.update(this.followPoints(world, alpha, localIds), dt);
    // Halfway through the turn, so the lip changes hands while the wall it is
    // leaving is edge-on and hardest to catch doing it.
    if (corner(this.rig.facing) !== this.wallCorner) this.buildWalls(world);

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
        // makes a purchase land where it happened rather than as a change
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
    this.cars.dispose();
    this.tables.dispose();
    this.orders.dispose();
    this.items.dispose();
    this.highlights.dispose();
    this.popups.dispose();
    for (const part of [...this.shell, ...this.walls]) disposeSubtree(part);
    this.shell.length = 0;
    this.walls.length = 0;
    this.scene.environment?.dispose();
    this.post?.dispose();
    this.renderer.dispose();
  }
}

/** Stand a frame in a gap in the shell, turned to the wall it interrupts. */
function frameGap(seam: Seam, frame: THREE.Object3D): THREE.Object3D {
  if (seam.axis === "vertical") frame.position.set(seam.x, 0, seam.y + 0.5);
  else {
    frame.position.set(seam.x + 0.5, 0, seam.y);
    frame.rotation.y = Math.PI / 2;
  }
  return frame;
}

/**
 * Which way is *out* through this seam, in the frame's own axes.
 *
 * A frame is built facing along its local x and then turned a quarter turn for
 * a horizontal seam, which flips the sense of that axis — so the one thing a
 * frame cannot work out for itself is which side of the building it is on.
 */
function outward(room: Rect, seam: Seam): number {
  if (seam.axis === "vertical") return seam.x === room.x ? -1 : 1;
  return seam.y === room.y ? 1 : -1;
}
