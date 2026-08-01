import * as THREE from "three";
import type { EffectCue, Rect, Seam, World } from "../sim/types";
import { applianceAtTile, playerById } from "../sim/world";
import { approachTile, dayProgress } from "../sim/queries";
import { hatchOf } from "../sim/lane";
import { edgeSeam, horizontalWall, mountSeam, verticalWall } from "../sim/walls";
import { applianceDef } from "../data/appliances";
import { biome as lookupBiome, type Biome } from "../data/biomes";
import { cameraYaw } from "../orientation";
import { lerp } from "./anim";
import { ApplianceViews } from "./appliance-views";
import { CarViews } from "./car-views";
import { KitchenCamera, type FollowTarget } from "./camera";
import { Daylight, type DaylightBounds } from "./daylight";
import { disposeSubtree } from "./dispose";
import { createEnvironment } from "./environment";
import { openStudio } from "./photo";
import { HighlightViews } from "./highlight-views";
import { ItemViews } from "./item-views";
import { mergeStatic } from "./merge";
import { buildDoorway, buildServingHatch, buildWall, floorTexture } from "./shell-meshes";
import { PALETTE } from "./palette";
import { PeopleViews } from "./people-views";
import { Popups } from "./popups";
import { OrderViews } from "./order-views";
import { timed } from "./profile";
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
export class View {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;

  private readonly rig: KitchenCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private post: Post | null = null;
  private readonly daylight: Daylight;

  private entities: Entities;

  private readonly clock = new THREE.Clock();
  private lastEffectId = 0;
  /** Reused every frame so following allocates nothing. */
  private readonly followTargets: FollowTarget[] = [];
  /** The baked floor, walls and scenery: this kitchen's, and nothing else's. */
  private readonly baked: THREE.Object3D[] = [];
  private readonly onResize = (): void => this.resize();

  constructor(canvas: HTMLCanvasElement, world: World, biomeId: string) {
    const biome = lookupBiome(biomeId);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !postEnabled() });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // The dish photographs on the recipe boards are taken with this renderer,
    // and it has to be lent before the first board is built. `photo.ts` says
    // why the studio cannot simply own one.
    openStudio(this.renderer);

    // Orthographic at a 3/4 angle: real 3D, isometric read. It follows the
    // local chefs and never shows past these bounds — see render/camera.ts.
    this.rig = new KitchenCamera(cameraBounds(world));
    this.camera = this.rig.camera;

    // Sky, sunlight, ground and scenery all come from the biome — the first two
    // of them from wherever the service clock has got to.
    this.daylight = new Daylight(this.renderer, this.scene, biome, daylightBounds(world));
    // The shadow map is spent on the ground the camera is actually showing,
    // which is about half the kitchen. The rig rewrites those corners in place.
    // Kept by reference, so it survives every kitchen this renderer draws.
    this.daylight.follow(this.rig.footprint);

    this.entities = new Entities(this.scene, this.camera);
    this.build(world, biome);

    this.resize();
    window.addEventListener("resize", this.onResize);
  }

  /**
   * Draw a different kitchen with the same renderer.
   *
   * This used to be `new View`, and the cost of that was almost entirely
   * invisible: `WebGLRenderer.dispose` empties three's program cache and its
   * record of what has been uploaded, but it neither deletes the GL objects nor
   * drops the context — and a second renderer on the same canvas is handed that
   * same context straight back. So swapping kitchens recompiled every shader in
   * the game, re-uploaded every shared geometry and texture, threw away the
   * dish photographs, rebuilt the post chain, and leaked the previous copy of
   * all of it into a context that never went away.
   *
   * Everything that belongs to the *renderer* — the context, the post chain,
   * the shader cache, the studio, the PMREM probe — is therefore built once and
   * kept. What is replaced here is what belongs to the *kitchen*: the baked
   * shell and scenery, the camera's bounds, the biome's sky, and every view
   * keyed by a simulation id.
   */
  setLevel(world: World, biomeId: string): void {
    timed("setLevel", () => {
      const biome = lookupBiome(biomeId);
      this.entities.dispose();
      for (const part of this.baked) disposeSubtree(part);
      this.baked.length = 0;

      this.rig.setBounds(cameraBounds(world));
      this.daylight.setBiome(biome, daylightBounds(world));
      this.entities = new Entities(this.scene, this.camera);
      this.build(world, biome);
    });
  }

  // --- scene setup -----------------------------------------------------------

  /** The parts of the scene a level owns: its scenery, its floor and its walls. */
  private build(world: World, biome: Biome): void {
    const scenery = timed("environment", () =>
      createEnvironment(biome, {
        width: world.width,
        height: world.height,
        room: world.room,
        paving: world.paving,
        approach: approachTile(world),
        lane: world.lane,
      }),
    );
    this.baked.push(...scenery);
    this.scene.add(...scenery);
    timed("shell", () => this.buildKitchenShell(world));

    // Ahead of the frame that would otherwise pay for it. Linking is what costs
    // — the driver does it off-thread where it can — and on a kitchen swap this
    // is free, because the cache these programs live in is no longer thrown
    // away with the renderer.
    void this.renderer.compileAsync(this.scene, this.camera);
  }

  /**
   * The kitchen itself: its tiled floor and its walls, baked once.
   *
   * Neither moves and neither depends on where the camera is standing, which
   * was not true while half the walls were full height — see `addWalls`.
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

    this.addWalls(shell, world);

    const merged = mergeStatic(shell);
    this.baked.push(...merged);
    this.scene.add(...merged);
  }

  /**
   * The walls, and every one of them is a **lip**.
   *
   * It used to be the two edges nearest the camera, because a full-height wall
   * standing between the camera and the kitchen is the difference between
   * seeing the room and not — and the other two were left tall so the building
   * still read as a building. Turning the camera made that a fact about the
   * building *and* where you were looking from, so the walls were rebuilt on
   * every quarter turn.
   *
   * Cutting all four costs the tall far wall and buys three things:
   *
   * - **Nothing outside is hidden.** The morning's delivery stands on the
   *   paving, and from two corners in four a tall wall stood in front of it.
   *   The same was true of anything else out there — a chef walking round the
   *   building, a customer on the path.
   * - **The walls stop depending on the camera**, so they are baked once with
   *   the floor instead of being rebuilt (and re-merged) every quarter turn.
   * - **A wall is a wall from every angle.** The old rule made the room look
   *   different depending on where you stood, which is exactly the objection
   *   that kept an interior divider full height; with one height everywhere,
   *   that objection has nothing left to be about.
   *
   * The exception is a seam something *hangs* on. A sign screwed to a lip and a
   * poster pasted on one would both be floating in mid-air, so those pieces
   * stay full height and read as what they are: the bit of wall the thing is
   * on.
   */
  private addWalls(group: THREE.Object3D, world: World): void {
    const room = world.room;
    const mounted = new Set<string>();
    for (const appliance of world.appliances.values()) {
      if (!applianceDef(appliance.kind).mounted) continue;
      const seam = mountSeam(room, appliance.tile);
      mounted.add(`${seam.axis},${seam.x},${seam.y}`);
    }
    const height = (axis: "vertical" | "horizontal", x: number, y: number): number =>
      mounted.has(`${axis},${x},${y}`) ? 1.1 : 0.26;

    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x <= world.width; x++) {
        if (!verticalWall(world, x, y)) continue;
        const wall = buildWall(height("vertical", x, y), "vertical");
        wall.position.set(x, 0, y + 0.5);
        group.add(wall);
      }
    }
    for (let y = 0; y <= world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        if (!horizontalWall(world, x, y)) continue;
        const wall = buildWall(height("horizontal", x, y), "horizontal");
        wall.position.set(x + 0.5, 0, y);
        group.add(wall);
      }
    }

    // The gaps in the shell. A frame around one is what stops it reading as a
    // hole somebody forgot to wall up — and a drive-through's hatch is a hole
    // in exactly the same sense, framed differently so that it reads as one.
    // Both stand full height on purpose: a doorway is the one part of a lipped
    // wall that has to say *here*, from across the park.
    group.add(frameGap(edgeSeam(world.room, world.door), buildDoorway()));
    const hatch = hatchOf(world);
    if (hatch) {
      const seam = edgeSeam(world.room, hatch.tile);
      group.add(frameGap(seam, buildServingHatch(outward(world.room, seam))));
    }
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.rig.setAspect(w / h);

    if (postEnabled() && !this.post) {
      this.post = createPost(this.renderer, this.scene, this.camera, this.daylight.state.grade);
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
    this.entities.sync(world, alpha, dt, time);
    // The kitchen is turned from outside the renderer, because the controls
    // have to turn with it — see `orientation.ts`.
    this.rig.setYaw(cameraYaw());
    this.rig.update(this.followPoints(world, alpha, localIds), dt);

    // After the camera, which decides where the shadow map is spent; before the
    // post chain, whose grade is part of what the hour means.
    this.daylight.update(dayProgress(world), dt);
    this.post?.setGrade(this.daylight.state.grade);

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
          this.entities.popups.spawn(
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
          this.entities.popups.spawn(
            `+$${cue.amount}`,
            PALETTE.rewardTip,
            player.pos.x,
            1.5,
            player.pos.y,
          );
        }
        return;
      }
      case "paid":
        this.entities.popups.spawn(
          `+$${cue.amount}`,
          PALETTE.rewardServe,
          cue.tile.x + 0.5,
          1.5,
          cue.tile.y + 0.5,
        );
        return;
      case "walkout":
        this.entities.popups.spawn(
          "walked out",
          PALETTE.lossWalkout,
          cue.tile.x + 0.5,
          1.3,
          cue.tile.y + 0.5,
        );
        return;
      case "binned": {
        const appliance = applianceAtTile(world, cue.tile.x, cue.tile.y);
        if (appliance) this.entities.appliances.openBin(appliance.id);
        return;
      }
      case "spent":
        // Money going *out*, in its own colour. The same popup machinery as a
        // reward, deliberately: a purchase and a delivery are both "the number
        // in the corner just moved", and reading them the same way is what
        // makes a purchase land where it happened rather than as a change
        // discovered later in the HUD.
        this.entities.popups.spawn(
          `-$${cue.amount}`,
          PALETTE.spend,
          cue.tile.x + 0.5,
          1.5,
          cue.tile.y + 0.5,
        );
        return;
      case "refused": {
        const appliance = applianceAtTile(world, cue.tile.x, cue.tile.y);
        if (appliance) this.entities.appliances.refuse(appliance.id);
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
    this.entities.dispose();
    for (const part of this.baked) disposeSubtree(part);
    this.baked.length = 0;
    this.daylight.dispose();
    this.post?.dispose();
    this.renderer.dispose();
  }
}

/**
 * Everything drawn from a simulation id, and therefore everything a new kitchen
 * invalidates.
 *
 * Grouped because they share a lifetime rather than because they share an
 * interface: ids are reused between worlds, so a counter that was appliance 3
 * in the park would go on being drawn as a counter in a beach kitchen whose
 * appliance 3 is a fryer. Each view drops meshes for ids that have *gone*,
 * which is the right answer for a reset and the wrong one for a rebuild.
 */
class Entities {
  readonly appliances: ApplianceViews;
  private readonly people: PeopleViews;
  private readonly cars: CarViews;
  private readonly tables: TableViews;
  private readonly orders: OrderViews;
  private readonly items: ItemViews;
  private readonly highlights: HighlightViews;
  readonly popups: Popups;

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.appliances = new ApplianceViews(scene, camera);
    this.people = new PeopleViews(scene);
    this.cars = new CarViews(scene);
    this.tables = new TableViews(this.appliances);
    // A customer is drawn as a person or as a car, never both, so the bubble
    // over their head asks for whichever of the two this kitchen has.
    this.orders = new OrderViews(
      scene,
      camera,
      (id) => this.people.customerRoot(id) ?? this.cars.carRoot(id),
    );
    this.items = new ItemViews(scene, this.people);
    this.highlights = new HighlightViews(scene, this.appliances, this.people);
    this.popups = new Popups(scene);
  }

  sync(world: World, alpha: number, dt: number, time: number): void {
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
  }

  dispose(): void {
    this.appliances.dispose();
    this.people.dispose();
    this.cars.dispose();
    this.tables.dispose();
    this.orders.dispose();
    this.items.dispose();
    this.highlights.dispose();
    this.popups.dispose();
  }
}

/** The box the camera may never show past: the whole grid, with a lip. */
function cameraBounds(world: World): THREE.Box3 {
  return new THREE.Box3(
    new THREE.Vector3(-0.4, -1.4, -0.4),
    new THREE.Vector3(world.width + 0.4, 2.0, world.height + 0.4),
  );
}

/**
 * What the sun aims at: the building, not the middle of the grid. A level whose
 * grid runs on past its paving has not moved its kitchen.
 */
function daylightBounds(world: World): DaylightBounds {
  return {
    width: world.width,
    height: world.height,
    cx: world.room.x + world.room.width / 2,
    cz: world.room.y + world.room.height / 2,
  };
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
