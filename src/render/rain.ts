import * as THREE from "three";
import type { Rect } from "../sim/types";
import { clamp01, ease } from "./anim";
import { PALETTE } from "./palette";

/**
 * Rain, which is not a particle system.
 *
 * Nothing here is born and nothing dies. A drop has no state anybody asks
 * about: its height is `fract(seed + time * speed)`, its ground position is
 * fixed, and when it reaches the floor it is the same drop starting again at
 * the top. That is arithmetic, and arithmetic belongs in a vertex shader — so
 * this is **one instanced mesh and two uniforms a frame**, whatever the
 * downpour looks like.
 *
 * It is worth saying why, because the roadmap listed rain next to steam and
 * sizzle as though they were one job. They are not. A burst of steam is a few
 * dozen particles with lives, spawned by something that happened, and it wants
 * a pool and a CPU update loop. Rain is fifteen hundred drops that are always
 * there. Running the second through the first would mean writing fifteen
 * hundred matrices a frame to reproduce a `fract()`.
 *
 * ## It does not rain indoors
 *
 * The shader discards any drop standing over the building, which is the whole
 * of what makes this more than an overlay: you can see the terrace getting wet
 * and the kitchen staying dry, and that is exactly the rule the weather is
 * playing by. A picture that teaches the mechanic is worth more than a picture
 * that decorates it — see [weather.md](../../docs/weather.md).
 *
 * ## The box follows the camera; the drops do not
 *
 * Enough rain to fill a 22-tile park is mostly rain nobody is looking at, so
 * the field is a box around the ground currently in shot. The drops inside it
 * are wrapped into world space with a `mod`, rather than carried along with the
 * box: a drop that moved when the camera did would read as a windscreen, and
 * the one thing rain has to look like is weather standing still while you move
 * through it.
 */

/** Drops in the field at full downpour. Density below that drops the count. */
const MAX_DROPS = 1500;

/** How wide and deep the field is, in tiles. A little more than the camera shows. */
const EXTENT = 26;

/** How high the drops start. Above the tallest thing in the kitchen. */
const TOP = 9;

/** Tiles per second, at the bottom of the fall. */
const SPEED = 14;

/** How far a drop drifts sideways over its whole fall, in tiles. */
const SLANT = 1.6;

/** A streak, in tiles: how long it is and how thick. */
const LENGTH = 0.42;
const WIDTH = 0.015;

/** The fraction of the fall spent breaking on the ground rather than falling. */
const SPLASH = 0.055;

/** How fast the downpour arrives and leaves, as a fraction of the gap per second. */
const CHANGE = 0.5;

/** Below this there is no rain worth drawing, and the mesh is switched off. */
const NOTHING = 0.004;

const VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uAlpha;
  /** Centre of the ground in shot: the field is wrapped around this. */
  uniform vec2 uFocus;
  /** The building, which has a roof: x, z, width, depth. */
  uniform vec4 uRoom;

  /** Where in the field this drop is (0..1, 0..1) and how far through its fall. */
  attribute vec3 aDrop;

  varying float vFade;

  void main() {
    // Every drop falls at its own rate, so the field does not pulse: the phase
    // doubles as a per-drop speed, which is what stops fifteen hundred streaks
    // reaching the ground on the same frame for ever.
    float speed = ${SPEED.toFixed(1)} * (0.8 + 0.4 * aDrop.z);
    float fall = 1.0 - fract(aDrop.z + uTime * speed / ${TOP.toFixed(1)});

    // Pinned to the world rather than to the box. The field is wrapped around
    // whatever the camera is looking at, so a drop leaves one edge and arrives
    // at the other instead of sliding along with the view.
    vec2 spread = vec2(${EXTENT.toFixed(1)});
    vec2 ground = uFocus + mod(aDrop.xy * spread - uFocus + spread * 0.5, spread) - spread * 0.5;
    ground.x += (1.0 - fall) * ${SLANT.toFixed(1)};

    // Indoors is dry. The one line that makes this weather rather than a filter
    // over the lens \u2014 and the reason a terrace table is a decision you can see.
    vec2 inside = step(uRoom.xy, ground) * step(ground, uRoom.xy + uRoom.zw);
    if (inside.x * inside.y > 0.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    // A drop breaks when it lands: over the last few percent of the fall the
    // streak flattens into a tick and fades. It costs one mix and it is the
    // difference between rain that hits the ground and rain that passes
    // through it.
    float landing = smoothstep(${SPLASH.toFixed(3)}, 0.0, fall);
    vec2 size = mix(
      vec2(${WIDTH.toFixed(3)}, ${LENGTH.toFixed(2)}),
      vec2(0.11, 0.02),
      landing
    );
    vFade = uAlpha * (1.0 - landing * 0.35);

    // Built in view space, so the streak faces the camera without a billboard
    // matrix and without this file knowing which way the kitchen is turned.
    vec4 middle = modelViewMatrix * vec4(ground.x, fall * ${TOP.toFixed(1)}, ground.y, 1.0);
    middle.xy += position.xy * size;
    gl_Position = projectionMatrix * middle;
  }
`;

const FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uColor;
  varying float vFade;

  void main() {
    gl_FragColor = vec4(uColor, vFade);
  }
`;

export class Rain {
  private readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly uniforms;

  /** How hard it is raining right now, and what it is heading for. */
  private amount = 0;
  private wanted = 0;

  constructor(private readonly scene: THREE.Scene) {
    this.geometry = dropField(MAX_DROPS);
    this.uniforms = {
      uTime: { value: 0 },
      uAlpha: { value: 0 },
      uFocus: { value: new THREE.Vector2() },
      uRoom: { value: new THREE.Vector4(0, 0, 0, 0) },
      uColor: { value: new THREE.Color(PALETTE.rain).convertSRGBToLinear() },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: this.uniforms,
      transparent: true,
      // Writes no depth, which is what keeps it out of the ambient-occlusion
      // pass: that samples the depth the main render produced rather than
      // rebuilding the scene, so anything that does not write depth is
      // invisible to it. See `layers.ts`.
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // The field is wrapped around the camera in the shader, so its bounds are
    // meaningless and a frustum test on them would blink the whole downpour out
    // as the view moved.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /**
   * Which building stays dry.
   *
   * Set per kitchen rather than per frame: it belongs to the *level*, and the
   * field itself belongs to the renderer — one of the few things that survives
   * a kitchen swap intact, because a box of falling drops is the same box over
   * any floor plan.
   */
  setRoom(room: Rect): void {
    this.uniforms.uRoom.value.set(room.x, room.y, room.width, room.height);
  }

  /**
   * Rain this hard, over the ground in `footprint`.
   *
   * `amount` is the weather's, 0..1, and is eased rather than switched: the
   * weather changes once between two days and a downpour that arrived on one
   * frame would read as a glitch, exactly as a hard cut in the sky would.
   *
   * The corners are the camera's own, kept by reference and rewritten in place
   * every frame — the same array the shadow box is aimed with.
   */
  update(footprint: readonly THREE.Vector3[], amount: number, dt: number, time: number): void {
    this.wanted = clamp01(amount);
    this.amount += (this.wanted - this.amount) * ease(CHANGE, dt);

    this.mesh.visible = this.amount > NOTHING;
    if (!this.mesh.visible) return;

    let x = 0;
    let z = 0;
    for (const corner of footprint) {
      x += corner.x / footprint.length;
      z += corner.z / footprint.length;
    }
    this.uniforms.uFocus.value.set(x, z);
    this.uniforms.uTime.value = time;
    this.uniforms.uAlpha.value = ALPHA * this.amount;
    // Density and opacity together. Fading alone leaves a full downpour of
    // ghosts on a drizzle, and thinning alone makes the last few drops pop out
    // one at a time; the count carries how hard it is raining and the alpha
    // carries the fade between two days.
    this.geometry.instanceCount = Math.ceil(MAX_DROPS * this.amount);
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** How opaque a streak is at full downpour. Rain is a suggestion, not a wall. */
const ALPHA = 0.34;

/**
 * The field: one quad, and a scattering of drops to stamp it at.
 *
 * Positions are **not** on the drop. Two numbers say where in the field it
 * stands and a third is both its phase and its speed, and the shader works out
 * the rest — so a drop costs three floats rather than a matrix, and the buffer
 * is written once and never touched again.
 *
 * `Math.random` rather than the world's stream on purpose: this is the one kind
 * of randomness in the game nobody has to agree about. Two players in one
 * kitchen seeing different raindrops is not a desync, it is the weather.
 */
function dropField(count: number): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  // A unit quad, scaled in view space by the shader: a streak while it falls
  // and a tick when it lands, from the same four corners. Three components
  // rather than two, because `ShaderMaterial` declares `position` as a `vec3`
  // for us and a buffer that is narrower than its attribute is a thing WebGL
  // pads silently rather than complains about.
  // prettier-ignore
  const corner = new Float32Array([
    -0.5, -0.5, 0,
     0.5, -0.5, 0,
    -0.5,  0.5, 0,
     0.5,  0.5, 0,
  ]);
  geometry.setAttribute("position", new THREE.BufferAttribute(corner, 3));
  geometry.setIndex([0, 1, 2, 2, 1, 3]);

  const drops = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) drops[i] = Math.random();
  geometry.setAttribute("aDrop", new THREE.InstancedBufferAttribute(drops, 3));
  geometry.instanceCount = 0;
  return geometry;
}
