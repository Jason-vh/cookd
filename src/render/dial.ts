import * as THREE from "three";
import { markUI } from "./layers";
import { PALETTE } from "./palette";

/**
 * The work gauge that floats over a busy appliance.
 *
 * It replaces a flat fill bar, which had three problems:
 *
 *  1. **It looked the same whether you were cooking or burning.** Only its
 *     colour changed, and colour alone is a weak signal in peripheral vision
 *     during service — exactly when it matters. The dial also *pulses* when
 *     food is burning, so the thing that needs attention is the thing moving.
 *  2. **It popped in and out.** Appearing and vanishing instantly reads as a
 *     glitch; easing in and out reads as a state.
 *  3. **It was wide.** A 1-tile-wide bar overlapped its neighbours' bars and
 *     the appliance labels. A dial is compact and unambiguous about what it
 *     belongs to.
 *
 * Drawn as a shader on a quad rather than as geometry, because the fill is a
 * single uniform — no geometry rebuild per frame, one draw call per appliance.
 * The quad is turned to face the camera every frame it is visible: that is one
 * quaternion copy per busy appliance, and it means the dial survives the camera
 * gaining a yaw control later without silently going edge-on.
 */

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision mediump float;
  varying vec2 vUv;

  uniform float uProgress;   // 0..1 fill
  uniform vec3  uColor;      // fill colour (linear)
  uniform vec3  uTrack;      // unfilled track colour (linear)
  uniform float uAlpha;      // master fade, drives ease in/out
  uniform float uFlash;      // 0..1 white completion flash

  const float TAU = 6.28318530718;

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);

    // Ring band, feathered on both edges so it stays smooth at any zoom.
    float outer = 0.90;
    float inner = 0.56;
    float feather = 0.07 + uFlash * 0.06;
    float band = smoothstep(outer, outer - feather, r) * smoothstep(inner - feather, inner, r);
    if (band <= 0.001) discard;

    // Angle from straight up, running clockwise: how a clock fills.
    float ang = atan(p.x, p.y);
    float t = ang < 0.0 ? (ang + TAU) / TAU : ang / TAU;

    // Soft leading edge so the head of the arc doesn't crawl in hard steps.
    float filled = smoothstep(uProgress + 0.012, uProgress - 0.012, t);

    vec3 color = mix(uTrack, uColor, filled);
    color = mix(color, vec3(1.0), uFlash);

    float alpha = band * uAlpha * mix(0.45, 1.0, filled);
    alpha = max(alpha, band * uFlash * uAlpha);
    gl_FragColor = vec4(color, alpha);
  }
`;

/** sRGB hex -> linear, which is what a raw shader uniform must carry. */
function linear(hex: number): THREE.Color {
  return new THREE.Color(hex).convertSRGBToLinear();
}

export type DialState = {
  progress: number;
  /** Fill colour, sRGB hex. */
  color: number;
  /** 0..1 master fade. */
  alpha: number;
  /** 0..1 white flash on completion. */
  flash: number;
  /** Extra scale, used to pulse when something is burning. */
  scale: number;
};

/** Scratch for undoing a rotated parent, reused every frame. */
const FACING = new THREE.Quaternion();

export class Dial {
  readonly object: THREE.Mesh;
  private readonly uniforms;
  private readonly camera: THREE.Camera;

  constructor(camera: THREE.Camera, radius = 0.3) {
    this.camera = camera;
    this.uniforms = {
      uProgress: { value: 0 },
      // Defaults, immediately overwritten by the first `apply`. Named from the
      // palette rather than repeated as literals, which is how the old
      // `0x8fd694` here quietly became a second definition of `progressGood`.
      uColor: { value: linear(PALETTE.progressGood) },
      uTrack: { value: linear(PALETTE.dialTrack) },
      uAlpha: { value: 0 },
      uFlash: { value: 0 },
    };
    this.object = new THREE.Mesh(
      new THREE.PlaneGeometry(radius * 2, radius * 2),
      new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: this.uniforms,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        fog: false,
      }),
    );
    this.object.renderOrder = 12;
    markUI(this.object);
  }

  /**
   * Give back the geometry and shader. Every appliance owns one of these, and
   * a reset rebuilds every appliance — so without this, resetting the kitchen
   * leaked a plane and a ShaderMaterial per counter, every time.
   */
  dispose(): void {
    this.object.geometry.dispose();
    if (Array.isArray(this.object.material)) {
      for (const entry of this.object.material) entry.dispose();
    } else {
      this.object.material.dispose();
    }
    this.object.removeFromParent();
  }

  apply(state: DialState): void {
    this.object.visible = state.alpha > 0.002;
    if (!this.object.visible) return;
    // Face the camera in *world* terms, which is not the same as copying its
    // orientation: the card stand's easel turns to face the viewer, so a dial
    // under it would inherit that turn on top of this one.
    this.object.quaternion.copy(this.camera.quaternion);
    const parent = this.object.parent;
    if (parent) {
      this.object.quaternion.premultiply(parent.getWorldQuaternion(FACING).invert());
    }
    this.uniforms.uProgress.value = state.progress;
    this.uniforms.uColor.value.copy(linear(state.color));
    this.uniforms.uAlpha.value = state.alpha;
    this.uniforms.uFlash.value = state.flash;
    this.object.scale.setScalar(state.scale);
  }
}
