import * as THREE from "three";
import { clamp01, lerp } from "./anim";
import { PALETTE } from "./palette";

/**
 * Puffs: steam off a working fryer, smoke off a burning one.
 *
 * This is the particle system the roadmap has wanted for a while, and it is
 * deliberately *not* what [rain](rain.ts) is built on. The difference is
 * lifetimes. A raindrop has none — its height is a `fract()` of the clock and
 * it is the same drop for ever — so it belongs in a vertex shader. A puff is
 * born somewhere, rises, spreads, fades and is gone, and every one of those is
 * a different age. That needs a pool and a CPU update, which is what this is.
 *
 * The shape is `popups.ts` with instancing: a fixed pool, a live list, and one
 * draw call. Popups earn a sprite each because every one carries its own text
 * texture; a puff is the same soft disc a hundred times over, so it is one
 * instanced mesh and three attribute buffers rewritten per frame.
 *
 * ## Why these two and nothing else
 *
 * **Smoke is the one that matters.** Burning is the game's failure state, and
 * until now the only thing that said so was the dial — which is small, local,
 * and competing with every other dial in the kitchen. Smoke rising off an oven
 * reads from across the room, which is the same argument that made the dial
 * *pulse* rather than merely change colour: in peripheral vision, movement
 * carries where colour does not.
 *
 * **Steam is what makes smoke legible.** A kitchen where the only thing in the
 * air is a disaster teaches you nothing until the disaster happens. A fryer
 * that steams while it works means the eye already knows what "this appliance
 * is doing something" looks like, so the day it goes dark and thick, that reads
 * as *wrong* rather than as new.
 *
 * Chop bits and screen shake are still not here on purpose. Bits are decoration
 * on an action you are already looking at, and a shake is a change to the
 * camera rather than to the kitchen.
 */

/** How a kind of puff is born, and what becomes of it. */
export type PuffSpec = {
  /** Seconds between puffs from one steady emitter. */
  every: number;
  /** How long one lives. */
  life: number;
  /** Tiles per second upward, at birth and at death: they slow as they spread. */
  rise: [number, number];
  /** How far one drifts sideways per second. Rolled per puff. */
  drift: number;
  /** Radius in tiles, at birth and at death. */
  size: [number, number];
  /** Peak opacity, reached a little after birth rather than at it. */
  alpha: number;
  color: number;
};

export const PUFFS = {
  /**
   * Working heat: thin, quick, and gone before it reaches head height.
   *
   * Small on purpose. This is *ambient* — it says an appliance is busy, and it
   * has to do that without becoming the thing you look at, because what you
   * should be looking at is the dial telling you how much longer.
   */
  steam: {
    every: 0.22,
    life: 1.3,
    rise: [0.75, 0.35],
    drift: 0.16,
    size: [0.07, 0.26],
    alpha: 0.3,
    color: PALETTE.steam,
  },
  /**
   * Something is burning: darker, bigger, slower, and it keeps coming.
   *
   * Every number here is the opposite of steam's on purpose. The two are read
   * against each other from across a kitchen, so they may not differ only in
   * colour — a player glancing over is being asked "busy or ruined", and the
   * answer has to survive being seen out of the corner of an eye.
   */
  smoke: {
    every: 0.13,
    life: 2.1,
    rise: [0.95, 0.5],
    drift: 0.3,
    size: [0.1, 0.5],
    alpha: 0.5,
    color: PALETTE.smoke,
  },
} as const satisfies Record<string, PuffSpec>;

export type PuffKind = keyof typeof PUFFS;

/** Room for every appliance in a kitchen to be on fire at once, and then some. */
const CAPACITY = 320;

/**
 * How a puff looks at a given age, 0..1 through its life.
 *
 * Pure, and separated from the pool for the reason `anim.ts` exists: this is
 * the part with the easing curves in it, it is the part that goes subtly wrong,
 * and a test can reach it without touching `window`.
 *
 * The fade in is much faster than the fade out. A puff that ramped up over the
 * same time it ramps down would spend its first third invisible, which reads as
 * a gap between the appliance and the plume rather than as something leaving
 * it.
 */
export function puffAt(spec: PuffSpec, t: number): { size: number; alpha: number; rise: number } {
  const age = clamp01(t);
  // Spreading is fastest at the start and settles, the way something that has
  // just escaped a lid does: the square root is the whole of that.
  const size = lerp(spec.size[0], spec.size[1], Math.sqrt(age));
  const fade = age < 0.12 ? age / 0.12 : 1 - (age - 0.12) / 0.88;
  return {
    size,
    alpha: spec.alpha * clamp01(fade),
    rise: lerp(spec.rise[0], spec.rise[1], age),
  };
}

type Puff = {
  spec: PuffSpec;
  age: number;
  x: number;
  y: number;
  z: number;
  driftX: number;
  driftZ: number;
};

const VERTEX = /* glsl */ `
  attribute vec3 aCentre;
  attribute float aSize;
  attribute vec4 aColor;

  varying vec2 vLocal;
  varying vec4 vColor;

  void main() {
    vLocal = position.xy;
    vColor = aColor;
    // Built in view space, so a puff faces the camera without a billboard
    // matrix and without this file knowing which corner the kitchen is being
    // watched from.
    vec4 middle = modelViewMatrix * vec4(aCentre, 1.0);
    middle.xy += position.xy * aSize * 2.0;
    gl_Position = projectionMatrix * middle;
  }
`;

const FRAGMENT = /* glsl */ `
  precision mediump float;
  varying vec2 vLocal;
  varying vec4 vColor;

  void main() {
    // A soft disc out of the quad's own coordinates rather than out of a
    // texture: it is one length() and a smoothstep, and it saves generating,
    // uploading and owning a 64x64 blob whose only content is a gradient.
    float edge = smoothstep(0.5, 0.12, length(vLocal));
    if (edge <= 0.001) discard;
    gl_FragColor = vec4(vColor.rgb, vColor.a * edge);
  }
`;

export class Particles {
  private readonly live: Puff[] = [];
  private readonly pool: Puff[] = [];

  private readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly centres: THREE.InstancedBufferAttribute;
  private readonly sizes: THREE.InstancedBufferAttribute;
  private readonly colors: THREE.InstancedBufferAttribute;

  constructor(private readonly scene: THREE.Scene) {
    this.geometry = new THREE.InstancedBufferGeometry();
    // prettier-ignore
    const corner = new Float32Array([
      -0.5, -0.5, 0,
       0.5, -0.5, 0,
      -0.5,  0.5, 0,
       0.5,  0.5, 0,
    ]);
    this.geometry.setAttribute("position", new THREE.BufferAttribute(corner, 3));
    this.geometry.setIndex([0, 1, 2, 2, 1, 3]);

    this.centres = instanced(CAPACITY, 3);
    this.sizes = instanced(CAPACITY, 1);
    this.colors = instanced(CAPACITY, 4);
    this.geometry.setAttribute("aCentre", this.centres);
    this.geometry.setAttribute("aSize", this.sizes);
    this.geometry.setAttribute("aColor", this.colors);
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      // Occluded by anything in front of it — a plume behind the dividing wall
      // belongs behind it — but writing no depth of its own, which is also what
      // keeps it out of the ambient-occlusion pass. See `layers.ts`.
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // The pool is written in world space and the bounds would have to be
    // recomputed every frame to mean anything.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 9;
    scene.add(this.mesh);
  }

  /**
   * One puff, leaving `(x, y, z)`.
   *
   * Silently does nothing when the pool is empty. A dropped puff is invisible
   * — there are already a hundred on screen — and the alternative is growing a
   * buffer during a rush, which is the one moment that cannot afford it.
   */
  emit(kind: PuffKind, x: number, y: number, z: number): void {
    if (this.live.length >= CAPACITY) return;
    const spec = PUFFS[kind];
    const puff = this.pool.pop() ?? blank();
    puff.spec = spec;
    puff.age = 0;
    // Born a little off-centre, so a steady emitter makes a plume rather than a
    // column of identical discs.
    puff.x = x + (Math.random() - 0.5) * spec.size[0];
    puff.y = y;
    puff.z = z + (Math.random() - 0.5) * spec.size[0];
    const angle = Math.random() * Math.PI * 2;
    puff.driftX = Math.cos(angle) * spec.drift;
    puff.driftZ = Math.sin(angle) * spec.drift;
    this.live.push(puff);
  }

  update(dt: number): void {
    let n = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const puff = this.live[i]!;
      puff.age += dt;
      const t = puff.age / puff.spec.life;
      if (t >= 1) {
        this.pool.push(puff);
        this.live.splice(i, 1);
        continue;
      }
      const look = puffAt(puff.spec, t);
      puff.x += puff.driftX * dt;
      puff.y += look.rise * dt;
      puff.z += puff.driftZ * dt;

      this.centres.setXYZ(n, puff.x, puff.y, puff.z);
      this.sizes.setX(n, look.size);
      COLOR.setHex(puff.spec.color).convertSRGBToLinear();
      this.colors.setXYZW(n, COLOR.r, COLOR.g, COLOR.b, look.alpha);
      n++;
    }

    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    // Only the slots actually written are uploaded: a kitchen with two puffs in
    // it would otherwise re-send three hundred stale ones sixty times a second.
    // Ranges are counted in array elements, and three clears them itself once
    // the buffer has gone up.
    upload(this.centres, n * 3);
    upload(this.sizes, n);
    upload(this.colors, n * 4);
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.live.length = 0;
    this.pool.length = 0;
  }
}

/** Scratch for the sRGB -> linear conversion, so a puff a frame allocates nothing. */
const COLOR = new THREE.Color();

/** Send the first `count` elements of an attribute and nothing else. */
function upload(attribute: THREE.InstancedBufferAttribute, count: number): void {
  attribute.addUpdateRange(0, count);
  attribute.needsUpdate = true;
}

function instanced(count: number, size: number): THREE.InstancedBufferAttribute {
  const attribute = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size);
  attribute.setUsage(THREE.DynamicDrawUsage);
  return attribute;
}

function blank(): Puff {
  return { spec: PUFFS.steam, age: 0, x: 0, y: 0, z: 0, driftX: 0, driftZ: 0 };
}
