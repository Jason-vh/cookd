import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { APPLIANCE_KINDS, applianceDef, type ApplianceKind } from "../data/appliances";
import { biome as lookupBiome } from "../data/biomes";
import { CUSTOMER_KINDS } from "../data/customers";
import { INGREDIENTS } from "../data/ingredients";
import { itemLabel } from "../sim/queries";
import type { Appliance, Item, ItemSpec } from "../sim/types";
import { CAMERA_OFFSET } from "../orientation";
import { buildAppliance } from "./appliance-meshes";
import { addLights } from "./environment";
import { buildItemModel, modelledStates } from "./models";
import { PALETTE } from "./palette";
import { buildChef, buildCustomer } from "./person-mesh";
import { createPost, postEnabled, type Post } from "./post";
import { makeLabel } from "./sprites";

/**
 * The model gallery: every model the game can draw, on turntables, under the
 * game's own lighting and post chain. Dev only — `?gallery`.
 *
 * It exists because there was no way to *look* at a model except to start a
 * game and walk a chef to it, which meant art work was iterated at whatever
 * angle the kitchen happened to offer, and cross-object inconsistency (five
 * browns for wood, three thicknesses of tabletop) was invisible by
 * construction: the objects to compare were never on screen together.
 *
 * Three decisions make it worth having rather than a nice idea:
 *
 *  - **The real lighting and the real post chain.** A model judged under a
 *    studio rig is a model tuned for a room the game does not have. It borrows
 *    the park's sun, fill, ambient and grade wholesale.
 *  - **A one-tile grid under everything.** Scale is the most common thing to
 *    get wrong and the hardest to see in isolation; each model stands on the
 *    same square the kitchen would give it.
 *  - **Everything, derived.** The list comes from `APPLIANCE_KINDS`,
 *    `INGREDIENTS` and the model registry, so a new appliance or a new item
 *    state appears here without anybody remembering to add it.
 */

/** Distance between turntables, in tiles. Comfortably wider than any model. */
const SPACING = 1.9;

/** How many models per row before wrapping. */
const COLUMNS = 6;

/** Radians per second. Slow enough to read a silhouette as it comes round. */
const TURN_RATE = 0.35;

type Entry = { label: string; object: THREE.Object3D };

/** A stand-in appliance, so the gallery can build one without a simulation. */
function sampleAppliance(kind: ApplianceKind, source: ItemSpec | null): Appliance {
  return {
    id: -1,
    kind,
    tile: { x: 0, y: 0 },
    item: null,
    progress: 0,
    overcook: 0,
    justFinished: false,
    motion: null,
    source,
    offer: null,
    taken: null,
    card: null,
    armedBy: null,
    armTime: 0,
    heldBy: null,
    tip: 0,
  };
}

function applianceEntries(): Entry[] {
  return APPLIANCE_KINDS.map((kind) => ({
    label: applianceDef(kind).label,
    // A crate with nothing in it is a crate mid-refit, and never what the
    // kitchen shows; give it stock so the model is judged as it is played.
    object: buildAppliance(
      sampleAppliance(kind, kind === "crate" ? { base: "tomato", processes: [] } : null),
    ).root,
  }));
}

function itemEntries(): Entry[] {
  const specs: ItemSpec[] = [
    ...Object.keys(INGREDIENTS).map((base) => ({ base, processes: [] })),
    ...modelledStates(),
    // Burning is a state every dish shares one model for, so one is enough.
    { base: "pizza", processes: ["baked", "burnt"] },
  ];
  return specs.map((spec) => {
    const item: Item = { id: -1, base: spec.base, processes: spec.processes, contents: [] };
    return { label: itemLabel(item), object: buildItemModel(item) };
  });
}

function peopleEntries(): Entry[] {
  return [
    { label: "Chef", object: buildChef(0).root },
    ...CUSTOMER_KINDS.map((kind, index) => ({
      label: kind.name,
      object: buildCustomer(kind.id, index).root,
    })),
  ];
}

/**
 * The camera, framing `rows` of models from the kitchen's own 3/4 angle.
 *
 * Orthographic and at the game's pitch on purpose: a perspective gallery
 * flatters models the game will never show that way.
 */
function createCamera(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const direction = new THREE.Vector3(CAMERA_OFFSET.x, 17, CAMERA_OFFSET.z).normalize();
  camera.position.copy(direction.multiplyScalar(40));
  camera.lookAt(0, 0, 0);
  return camera;
}

export class Gallery {
  private readonly scene = new THREE.Scene();
  private readonly camera = createCamera();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly post: Post | null;
  private readonly turntables: THREE.Object3D[] = [];
  private readonly clock = new THREE.Clock();
  private readonly pivot = new THREE.Vector3();

  /** Half the vertical world height in frame. Wheel changes it. */
  private zoom = 6;
  private spinning = true;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const biome = lookupBiome("park");
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !postEnabled() });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = biome.exposure;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = biome.environmentIntensity;
    pmrem.dispose();
    this.scene.background = new THREE.Color(PALETTE.wallLow);

    const entries = [...applianceEntries(), ...itemEntries(), ...peopleEntries()];
    const rows = Math.ceil(entries.length / COLUMNS);
    const width = COLUMNS * SPACING;
    const depth = rows * SPACING;
    this.pivot.set(0, 0.4, 0);
    this.zoom = Math.max(width, depth) * 0.42;

    addLights(this.scene, biome, { width, height: depth }, 0, 0);
    this.addFloor(width, depth);
    this.layout(entries, rows);

    this.post = postEnabled()
      ? createPost(this.renderer, this.scene, this.camera, biome.grade)
      : null;
    this.resize();

    window.addEventListener("resize", this.onResize);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("keydown", this.onKeyDown);
  }

  /** A tiled floor and a one-tile grid: the size reference the whole thing is for. */
  private addFloor(width: number, depth: number): void {
    const span = Math.ceil(Math.max(width, depth) + SPACING * 4);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(span, span),
      new THREE.MeshStandardMaterial({ color: PALETTE.floorLight, roughness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(span, span, PALETTE.floorGrout, PALETTE.floorGrout);
    grid.position.y = 0.002;
    this.scene.add(grid);
  }

  private layout(entries: Entry[], rows: number): void {
    entries.forEach((entry, index) => {
      const column = index % COLUMNS;
      const row = Math.floor(index / COLUMNS);
      const x = (column - (COLUMNS - 1) / 2) * SPACING;
      const z = (row - (rows - 1) / 2) * SPACING;

      // The turntable spins; the label does not, or it would swing in and out
      // of legibility once a revolution.
      const turntable = new THREE.Group();
      turntable.position.set(x, 0, z);
      turntable.add(entry.object);
      this.scene.add(turntable);
      this.turntables.push(turntable);

      const label = makeLabel(entry.label);
      label.position.set(x, 0.14, z + SPACING * 0.46);
      this.scene.add(label);
    });
  }

  // --- controls --------------------------------------------------------------

  private readonly onResize = (): void => this.resize();

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.zoom = THREE.MathUtils.clamp(this.zoom * (1 + event.deltaY * 0.0015), 0.5, 40);
    this.resize();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "r") this.spinning = !this.spinning;
  };

  /**
   * Drag to pan, in the camera's own plane rather than in world x/z — dragging
   * right must move the picture right, whatever angle the kitchen is seen from.
   */
  private readonly onPointerDown = (event: PointerEvent): void => {
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    let [lastX, lastY] = [event.clientX, event.clientY];

    const move = (moved: PointerEvent): void => {
      const scale = (this.zoom * 2) / this.canvas.clientHeight;
      this.pivot
        .addScaledVector(right, -(moved.clientX - lastX) * scale)
        .addScaledVector(up, (moved.clientY - lastY) * scale);
      [lastX, lastY] = [moved.clientX, moved.clientY];
      this.aim();
    };
    const release = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
  };

  private aim(): void {
    const direction = new THREE.Vector3(CAMERA_OFFSET.x, 17, CAMERA_OFFSET.z).normalize();
    this.camera.position.copy(this.pivot).addScaledVector(direction, 40);
    this.camera.lookAt(this.pivot);
    this.camera.updateMatrixWorld();
  }

  private resize(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const aspect = width / Math.max(1, height);
    this.camera.top = this.zoom;
    this.camera.bottom = -this.zoom;
    this.camera.left = -this.zoom * aspect;
    this.camera.right = this.zoom * aspect;
    this.camera.updateProjectionMatrix();
    this.aim();
    this.renderer.setSize(width, height, false);
    this.post?.resize(width, height);
  }

  render(): void {
    const elapsed = this.clock.getDelta();
    if (this.spinning) {
      for (const turntable of this.turntables) turntable.rotation.y += elapsed * TURN_RATE;
    }
    if (this.post) this.post.render();
    else this.renderer.render(this.scene, this.camera);
  }
}

/** Run the gallery instead of the game, forever. */
export function startGallery(canvas: HTMLCanvasElement): void {
  const gallery = new Gallery(canvas);
  const frame = (): void => {
    requestAnimationFrame(frame);
    gallery.render();
  };
  requestAnimationFrame(frame);
}
