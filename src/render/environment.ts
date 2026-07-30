import * as THREE from "three";
import { isMesh } from "./nodes";
import { scatter, type PropSpace } from "./scatter";
import { mulberry32 } from "../sim/random";
import type { Biome, PropKind } from "../data/biomes";
import { box, cylinder, mesh, roundedBox, sphere } from "./primitives";
import { mergeStatic } from "./merge";

/**
 * Everything outside the kitchen walls: sky, sunlight, ground, the patio the
 * kitchen stands on, and the props scattered around it.
 *
 * All of it is driven by a `Biome` from `data/biomes.ts`, so a new location is
 * a data entry plus (at most) a new prop builder in `PROPS` below.
 *
 * Scatter uses a **seeded** RNG, not `Math.random()`: the park must look
 * identical on every load, and identical on every client once there is online
 * multiplayer.
 *
 * None of it moves, so it is authored as loose parts and then baked into one
 * mesh per material on the way into the scene — see `merge.ts`.
 */

export type EnvironmentBounds = {
  /** Kitchen footprint in tiles. */
  width: number;
  height: number;
};

export function createEnvironment(
  scene: THREE.Scene,
  biome: Biome,
  bounds: EnvironmentBounds,
): void {
  const cx = bounds.width / 2;
  const cz = bounds.height / 2;
  const groundY = -biome.patio.lift;

  scene.background = skyTexture(biome);
  scene.fog = new THREE.Fog(biome.fog.color, biome.fog.near, biome.fog.far);

  addLights(scene, biome, bounds, cx, cz);

  // Everything past this point is scenery: built into a scratch group, then
  // collapsed into a handful of draw calls before it reaches the scene.
  const scenery = new THREE.Group();
  addGround(scenery, biome, cx, cz, groundY);
  addPatio(scenery, biome, bounds, cx, cz, groundY);
  if (biome.path) addPath(scenery, biome, bounds, groundY);
  addScatter(scenery, biome, bounds, cx, cz, groundY);
  scene.add(...mergeStatic(scenery));
}

// --- lighting ----------------------------------------------------------------

function addLights(
  scene: THREE.Scene,
  biome: Biome,
  bounds: EnvironmentBounds,
  cx: number,
  cz: number,
): void {
  const azimuth = (biome.sun.azimuth * Math.PI) / 180;
  const elevation = (biome.sun.elevation * Math.PI) / 180;
  const distance = 18;

  const sun = new THREE.DirectionalLight(biome.sun.color, biome.sun.intensity);
  sun.position.set(
    cx + Math.cos(azimuth) * Math.cos(elevation) * distance,
    Math.sin(elevation) * distance,
    cz + Math.sin(azimuth) * Math.cos(elevation) * distance,
  );
  sun.target.position.set(cx, 0, cz);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;

  // Cover the kitchen plus a margin so nearby trees cast onto the patio, but
  // no more than that: every extra unit costs shadow-map resolution.
  const reach = Math.max(bounds.width, bounds.height) * 0.72 + 6;
  const shadowCam = sun.shadow.camera;
  shadowCam.left = -reach;
  shadowCam.right = reach;
  shadowCam.top = reach;
  shadowCam.bottom = -reach;
  shadowCam.near = 1;
  shadowCam.far = distance * 2.4;
  shadowCam.updateProjectionMatrix();
  scene.add(sun, sun.target);

  const fill = new THREE.DirectionalLight(biome.fill.color, biome.fill.intensity);
  fill.position.set(cx - 10, 7, cz - 8);
  scene.add(fill);

  scene.add(
    new THREE.HemisphereLight(biome.ambient.sky, biome.ambient.ground, biome.ambient.intensity),
  );
}

// --- ground and patio --------------------------------------------------------

function addGround(
  scene: THREE.Object3D,
  biome: Biome,
  cx: number,
  cz: number,
  groundY: number,
): void {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(180, 180),
    new THREE.MeshStandardMaterial({
      map: groundTexture(biome),
      roughness: 0.95,
      metalness: 0,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, groundY, cz);
  ground.receiveShadow = true;
  scene.add(ground);
}

/** The raised paved platform the kitchen is built on. */
function addPatio(
  scene: THREE.Object3D,
  biome: Biome,
  bounds: EnvironmentBounds,
  cx: number,
  cz: number,
  groundY: number,
): void {
  const over = biome.patio.overhang;
  const w = bounds.width + over * 2;
  const d = bounds.height + over * 2;
  const thickness = biome.patio.lift + 0.3;

  const slab = mesh(roundedBox(w, thickness, d, 0.14), biome.patio.edge, "stone");
  slab.position.set(cx, groundY + thickness / 2 - 0.3, cz);
  scene.add(slab);

  // A trim course just under the lip reads as coping stones and stops the
  // patio from looking like one extruded block.
  const trim = mesh(roundedBox(w + 0.12, 0.1, d + 0.12, 0.04), biome.patio.trim, "stone");
  trim.position.set(cx, -0.06, cz);
  scene.add(trim);
}

/** Paving slabs leading away from the serving side — where customers arrive. */
function addPath(
  scene: THREE.Object3D,
  biome: Biome,
  bounds: EnvironmentBounds,
  groundY: number,
): void {
  const path = biome.path!;
  const random = mulberry32(0x9a7d);
  for (let i = 0; i < path.count; i++) {
    const slab = mesh(roundedBox(0.9, 0.09, 0.8, 0.05), path.color, "stone");
    slab.position.set(
      -1.4 - i * 1.25,
      groundY + 0.05,
      bounds.height / 2 + (random() - 0.5) * 1.6 + i * 0.35,
    );
    slab.rotation.y = (random() - 0.5) * 0.5;
    scene.add(slab);
  }
}

// --- props -------------------------------------------------------------------

type PropBuilder = (biome: Biome, random: () => number) => THREE.Object3D;

const PROP_BUILDERS: Record<PropKind, PropBuilder> = {
  tree: (biome, random) => tree(biome, random, biome.foliage),
  blossom: (biome, random) => tree(biome, random, biome.blossom),
  bush: (biome, random) => {
    const group = new THREE.Group();
    const color = pick(biome.foliage, random);
    for (let i = 0; i < 3; i++) {
      const blob = mesh(sphere(0.34 + random() * 0.16, 12), color, "cloth");
      blob.position.set((random() - 0.5) * 0.5, 0.26 + random() * 0.12, (random() - 0.5) * 0.5);
      blob.scale.set(1, 0.82, 1);
      group.add(blob);
    }
    return group;
  },
  rock: (biome, random) => {
    const group = new THREE.Group();
    const stone = mesh(sphere(0.26 + random() * 0.1, 10), biome.rock, "stone");
    stone.scale.set(1.2, 0.62 + random() * 0.25, 1);
    stone.rotation.y = random() * Math.PI;
    stone.position.y = 0.12;
    group.add(stone);
    return group;
  },
  flowers: (biome, random) => {
    const group = new THREE.Group();
    const color = pick(biome.flowers, random);
    for (let i = 0; i < 3 + Math.floor(random() * 3); i++) {
      const stem = mesh(cylinder(0.012, 0.012, 0.16, 5), 0x4f8f3a, "cloth");
      const x = (random() - 0.5) * 0.4;
      const z = (random() - 0.5) * 0.4;
      stem.position.set(x, 0.08, z);
      group.add(stem);
      const head = mesh(sphere(0.05, 8), color, "cloth");
      head.position.set(x, 0.18, z);
      head.scale.set(1, 0.7, 1);
      group.add(head);
    }
    return group;
  },
  tuft: (biome, random) => {
    const group = new THREE.Group();
    const color = pick(biome.foliage, random);
    for (let i = 0; i < 3; i++) {
      // Unbevelled: a blade is a few pixels wide, so the rounding is invisible
      // and there are 780 of them.
      const blade = mesh(box(0.05, 0.2, 0.05), color, "cloth");
      blade.position.set((random() - 0.5) * 0.2, 0.1, (random() - 0.5) * 0.2);
      blade.rotation.set((random() - 0.5) * 0.5, random() * 3, (random() - 0.5) * 0.5);
      group.add(blade);
    }
    return group;
  },
  /**
   * A palm: a leaning trunk in rings, and fronds hanging off the top.
   *
   * The lean is the whole character of it. A vertical palm reads as a mistake
   * next to a park tree; one bent away from the sea reads as weather.
   */
  palm: (biome, random) => {
    const group = new THREE.Group();
    const height = 2.2 + random() * 1.1;
    const lean = (random() - 0.5) * 0.5;
    const segments = 5;
    for (let i = 0; i < segments; i++) {
      const t = i / segments;
      const ring = mesh(
        cylinder(0.1 - t * 0.03, 0.13 - t * 0.03, height / segments, 7),
        biome.trunk,
        "wood",
      );
      ring.position.set(lean * t * t * height * 0.35, (t + 0.5 / segments) * height, 0);
      ring.rotation.z = -lean * t;
      group.add(ring);
    }

    const top = new THREE.Vector3(lean * height * 0.35, height, 0);
    const color = pick(biome.foliage, random);
    const fronds = 6 + Math.floor(random() * 3);
    for (let i = 0; i < fronds; i++) {
      const angle = (i / fronds) * Math.PI * 2 + random() * 0.3;
      const frond = mesh(box(1.15, 0.06, 0.3), color, "cloth");
      // Anchored at the trunk and swung outward, so the blade hangs from the
      // crown rather than passing through it.
      frond.position.set(
        top.x + Math.cos(angle) * 0.55,
        top.y - 0.1 - random() * 0.12,
        Math.sin(angle) * 0.55,
      );
      frond.rotation.set(0, -angle, -0.35 - random() * 0.25);
      group.add(frond);
    }

    const nuts = Math.floor(random() * 3);
    for (let i = 0; i < nuts; i++) {
      const nut = mesh(sphere(0.09, 8), 0x7a5a3a, "cloth");
      nut.position.set(top.x + (random() - 0.5) * 0.2, top.y - 0.16, (random() - 0.5) * 0.2);
      group.add(nut);
    }
    return group;
  },
  /** A parasol on the sand: the beach's picnic table, and its splash of colour. */
  parasol: (biome, random) => {
    const group = new THREE.Group();
    const height = 1.5 + random() * 0.3;

    const pole = mesh(cylinder(0.035, 0.035, height, 7), biome.timber, "wood");
    pole.position.y = height / 2;
    pole.rotation.z = 0.12;
    group.add(pole);

    const canopy = mesh(cylinder(0.05, 0.95, 0.34, 12), pick(biome.blossom, random), "cloth");
    canopy.position.set(-height * 0.06, height, 0);
    canopy.rotation.z = 0.12;
    group.add(canopy);
    return group;
  },
  /** Driftwood: bleached, half-buried, and the reason the sand is not empty. */
  driftwood: (biome, random) => {
    const group = new THREE.Group();
    const logs = 1 + Math.floor(random() * 2);
    for (let i = 0; i < logs; i++) {
      const log = mesh(cylinder(0.09, 0.12, 0.9 + random() * 0.7, 6), biome.rock, "wood");
      log.rotation.set(0, random() * Math.PI, Math.PI / 2 + (random() - 0.5) * 0.3);
      log.position.set((random() - 0.5) * 0.4, 0.1, (random() - 0.5) * 0.4);
      group.add(log);
    }
    return group;
  },
  // Foreshadows the dining room: these are where customers will eventually sit.
  picnic: (biome, random) => {
    const group = new THREE.Group();
    const timber = biome.timber;

    const top = mesh(roundedBox(1.6, 0.1, 0.82, 0.04), timber, "wood");
    top.position.y = 0.72;
    group.add(top);

    for (const x of [-0.62, 0.62]) {
      for (const z of [-0.3, 0.3]) {
        const leg = mesh(roundedBox(0.1, 0.72, 0.1, 0.035), timber, "wood");
        leg.position.set(x, 0.36, z);
        group.add(leg);
      }
    }

    for (const side of [-1, 1]) {
      const bench = mesh(roundedBox(1.6, 0.08, 0.34, 0.035), timber, "wood");
      bench.position.set(0, 0.42, side * 0.72);
      group.add(bench);
      for (const x of [-0.62, 0.62]) {
        const leg = mesh(roundedBox(0.08, 0.42, 0.08, 0.03), timber, "wood");
        leg.position.set(x, 0.21, side * 0.72);
        group.add(leg);
      }
    }

    group.rotation.y = random() * Math.PI * 2;
    return group;
  },
};

function tree(biome: Biome, random: () => number, palette: number[]): THREE.Object3D {
  const group = new THREE.Group();
  const height = 1.3 + random() * 0.9;

  const trunk = mesh(cylinder(0.11, 0.17, height, 8), biome.trunk, "wood");
  trunk.position.y = height / 2;
  group.add(trunk);

  const color = pick(palette, random);
  const crown = 3 + Math.floor(random() * 2);
  for (let i = 0; i < crown; i++) {
    const radius = 0.5 + random() * 0.35;
    const blob = mesh(sphere(radius, 14), color, "cloth");
    blob.position.set(
      (random() - 0.5) * 0.7,
      height + 0.15 + (random() - 0.3) * 0.5,
      (random() - 0.5) * 0.7,
    );
    blob.scale.set(1, 0.88, 1);
    group.add(blob);
  }
  return group;
}

/**
 * Everything the placement algorithm needs about a prop kind, in one table.
 *
 * There were four of these in four shapes: a builder map, a footprint map, an
 * inline `entry.kind !== "tuft"` for shadows, and an inline
 * `kind === "tuft" || kind === "flowers"` for patio clearance. Adding a prop
 * failed the build in two of them and silently took a default in the other two
 * — which is exactly the situation `APPLIANCE_LOOK` was written to end one
 * directory over.
 */
type PropSpec = PropSpace & {
  build: PropBuilder;
  /**
   * Grass tufts are dozens of tiny meshes whose shadows are invisible at this
   * camera angle; a shadow-map pass each is not worth paying for.
   */
  castsShadow: boolean;
};

const PROPS: Record<PropKind, PropSpec> = {
  tree: { build: PROP_BUILDERS.tree, radius: 0.55, clearance: 1.4, castsShadow: true },
  blossom: { build: PROP_BUILDERS.blossom, radius: 0.5, clearance: 1.4, castsShadow: true },
  bush: { build: PROP_BUILDERS.bush, radius: 0.6, clearance: 1.4, castsShadow: true },
  rock: { build: PROP_BUILDERS.rock, radius: 0.45, clearance: 1.4, castsShadow: true },
  picnic: { build: PROP_BUILDERS.picnic, radius: 1.35, clearance: 1.4, castsShadow: true },
  palm: { build: PROP_BUILDERS.palm, radius: 0.5, clearance: 1.4, castsShadow: true },
  parasol: { build: PROP_BUILDERS.parasol, radius: 1, clearance: 1.4, castsShadow: true },
  driftwood: { build: PROP_BUILDERS.driftwood, radius: 0.55, clearance: 1, castsShadow: true },
  flowers: { build: PROP_BUILDERS.flowers, radius: 0.28, clearance: 0.6, castsShadow: true },
  tuft: { build: PROP_BUILDERS.tuft, radius: 0.14, clearance: 0.6, castsShadow: false },
};

function addScatter(
  scene: THREE.Object3D,
  biome: Biome,
  bounds: EnvironmentBounds,
  cx: number,
  cz: number,
  groundY: number,
): void {
  const random = mulberry32(0x5eed);
  // Keep props off the patio and out of the immediate approach to it.
  const halfW = bounds.width / 2 + biome.patio.overhang;
  const halfD = bounds.height / 2 + biome.patio.overhang;

  for (const { entry, x, z } of scatter(biome.scatter, PROPS, halfW, halfD, random)) {
    const spec = PROPS[entry.kind];
    const prop = spec.build(biome, random);
    prop.position.set(cx + x, groundY, cz + z);
    prop.rotation.y += random() * Math.PI * 2;
    const scale = entry.scale[0] + random() * (entry.scale[1] - entry.scale[0]);
    prop.scale.multiplyScalar(scale);
    prop.traverse((child) => {
      if (isMesh(child)) {
        child.castShadow = spec.castsShadow;
        child.receiveShadow = true;
      }
    });
    scene.add(prop);
  }
}

// --- generated textures ------------------------------------------------------

function skyTexture(biome: Biome): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, biome.sky.top);
  gradient.addColorStop(0.55, biome.sky.middle);
  gradient.addColorStop(1, biome.sky.horizon);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 4, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Blotchy grass: flat colour would read as plastic under this much sunlight. */
function groundTexture(biome: Biome): THREE.Texture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const random = mulberry32(0x6ea55);

  ctx.fillStyle = hex(biome.ground.base);
  ctx.fillRect(0, 0, size, size);

  for (const [color, count, radius] of [
    [biome.ground.patch, 46, 22],
    [biome.ground.accent, 38, 15],
  ] as const) {
    ctx.fillStyle = hex(color);
    ctx.globalAlpha = 0.32;
    for (let i = 0; i < count; i++) {
      ctx.beginPath();
      ctx.ellipse(
        random() * size,
        random() * size,
        radius * (0.4 + random()),
        radius * (0.4 + random()),
        random() * Math.PI,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }

  ctx.globalAlpha = 0.06;
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = i % 2 ? "#ffffff" : "#000000";
    ctx.fillRect(random() * size, random() * size, 2, 2);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(45, 45);
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// --- helpers -----------------------------------------------------------------

function pick<T>(values: readonly T[], random: () => number): T {
  return values[Math.floor(random() * values.length)]!;
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** Same PRNG as the simulation, so scattered scenery is reproducible. */
