import * as THREE from "three";
import type { Biome, DaylightKey, SkyState } from "../data/biomes";
import { clamp01, ease, lerp } from "./anim";
import { disposeSubtree } from "./dispose";

/**
 * The sky, and the hour it is.
 *
 * A biome keyframes its own day (`data/biomes.ts`); this samples that curve
 * against the service clock and pushes the result at everything that cares —
 * the sun, the fill, the hemisphere wrap, the fog, the background gradient, the
 * image-based lighting and the renderer's exposure. The colour grade is the one
 * thing it does not apply itself, because that belongs to the post chain: read
 * `state.grade` and hand it to `Post.setGrade`.
 *
 * Two of those are expensive and the rest are free. Moving a light is three
 * numbers; redrawing the sky gradient is a canvas upload and rebuilding the
 * environment map is a PMREM render, so both happen on a **bucketed** clock —
 * `STEPS` times a day rather than sixty times a second. Neither carries detail:
 * the gradient is four pixels wide and the environment is blurred into a
 * handful of mip levels, so a step in either is not something the eye can
 * catch.
 */

/** Where the sun hangs, in world units. Also fixes the shadow camera's depth. */
const SUN_DISTANCE = 18;

/** How many times a day the sky texture and the environment map are rebuilt. */
const STEPS = 24;

/**
 * How fast the sky catches up with the clock, as a fraction of the gap closed
 * per second.
 *
 * It exists for one moment: the last minute of a service and the build phase
 * that follows are the same morning, so closing time hands the sky a target it
 * has to travel the whole day backwards to reach. Eased, that reads as a
 * time-lapse rewinding to opening; snapped, it reads as a bug.
 */
const CATCH_UP = 1.2;

export type DaylightBounds = {
  /** Kitchen footprint in tiles, and where its centre is. */
  width: number;
  height: number;
  cx: number;
  cz: number;
};

export type DaylightOptions = {
  /**
   * Whether the scene gets the sky behind it and the fog in front of it. The
   * model gallery wants the game's light and none of its weather: fog would
   * haze the back rows of a layout that is nothing but back rows.
   */
  atmosphere?: boolean;
};

export class Daylight {
  /** The light right now. Sampled in place, so it is never reallocated. */
  readonly state: SkyState = blankSky();

  private readonly keys: readonly DaylightKey[];
  private readonly sun = new THREE.DirectionalLight();
  private readonly fill = new THREE.DirectionalLight();
  private readonly hemisphere = new THREE.HemisphereLight();

  private readonly sky: THREE.CanvasTexture;
  private readonly skyCanvas: HTMLCanvasElement;

  private readonly pmrem: THREE.PMREMGenerator;
  private readonly probe: THREE.Scene;
  private readonly probeGround: THREE.MeshBasicMaterial;
  private readonly probeSun: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private environment: THREE.WebGLRenderTarget | null = null;

  private time = 0;
  private step = -1;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    biome: Biome,
    bounds: DaylightBounds,
    options: DaylightOptions = {},
  ) {
    this.keys = biome.daylight;

    this.skyCanvas = document.createElement("canvas");
    this.skyCanvas.width = 4;
    this.skyCanvas.height = 256;
    this.sky = new THREE.CanvasTexture(this.skyCanvas);
    this.sky.colorSpace = THREE.SRGBColorSpace;

    this.pmrem = new THREE.PMREMGenerator(renderer);
    const { probe, ground, disc } = buildProbe(this.sky);
    this.probe = probe;
    this.probeGround = ground;
    this.probeSun = disc;

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;
    this.sun.target.position.set(bounds.cx, 0, bounds.cz);

    // Cover the kitchen plus a margin so nearby trees cast onto the patio, but
    // no more than that: every extra unit costs shadow-map resolution. The
    // margin is generous at this end of the day — a low sun lays a tree's
    // shadow out several times its own height.
    const reach = Math.max(bounds.width, bounds.height) * 0.72 + 9;
    const shadowCam = this.sun.shadow.camera;
    shadowCam.left = -reach;
    shadowCam.right = reach;
    shadowCam.top = reach;
    shadowCam.bottom = -reach;
    shadowCam.near = 1;
    shadowCam.far = SUN_DISTANCE * 2.4;
    shadowCam.updateProjectionMatrix();

    this.fill.position.set(bounds.cx - 10, 7, bounds.cz - 8);
    scene.add(this.sun, this.sun.target, this.fill, this.hemisphere);

    if (options.atmosphere !== false) {
      scene.background = this.sky;
      scene.fog = new THREE.Fog(0xffffff, 1, 2);
    }

    this.set(0);
  }

  /**
   * Move the day toward `target` (0 at opening, 1 at closing), easing rather
   * than jumping so a rollover to the next morning dissolves.
   */
  update(target: number, dt: number): void {
    this.set(lerp(this.time, clamp01(target), ease(CATCH_UP, dt)));
  }

  /** Stand the day at one hour and leave it there. */
  set(time: number): void {
    this.time = time;
    const state = sampleDaylight(this.keys, time, this.state);

    // Around the target, which is the kitchen: the shadow camera was sized for
    // a sun on that sphere and stops covering one anywhere else.
    place(this.sun.position, state.sun, SUN_DISTANCE, this.sun.target.position);
    this.sun.color.setHex(state.sun.color);
    this.sun.intensity = state.sun.intensity;

    this.fill.color.setHex(state.fill.color);
    this.fill.intensity = state.fill.intensity;

    this.hemisphere.color.setHex(state.ambient.sky);
    this.hemisphere.groundColor.setHex(state.ambient.ground);
    this.hemisphere.intensity = state.ambient.intensity;

    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.setHex(state.fog.color);
      this.scene.fog.near = state.fog.near;
      this.scene.fog.far = state.fog.far;
    }

    this.scene.environmentIntensity = state.environmentIntensity;
    this.renderer.toneMappingExposure = state.exposure;

    const step = Math.round(time * STEPS);
    if (step === this.step) return;
    this.step = step;
    this.drawSky();
    this.bakeEnvironment();
  }

  /** The background gradient, four pixels wide because it has no horizontal. */
  private drawSky(): void {
    const ctx = this.skyCanvas.getContext("2d")!;
    const gradient = ctx.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, css(this.state.sky.top));
    gradient.addColorStop(0.55, css(this.state.sky.middle));
    gradient.addColorStop(1, css(this.state.sky.horizon));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 4, 256);
    this.sky.needsUpdate = true;
  }

  /**
   * Re-light every reflective surface in the game from the sky as it is now.
   *
   * The probe scene is built once and mutated, so this is a render rather than
   * a rebuild; the old target still has to go, because `fromScene` hands back a
   * new one every time and there are two dozen of them in a day.
   */
  private bakeEnvironment(): void {
    const sun = this.state.sun;
    this.probeGround.color.setHex(this.state.ambient.ground);
    this.probeSun.material.color.setHex(sun.color).multiplyScalar(6 * sun.intensity);
    place(this.probeSun.position, sun, 10, null);

    const baked = this.pmrem.fromScene(this.probe, 0.04);
    this.environment?.dispose();
    this.environment = baked;
    this.scene.environment = baked.texture;
  }

  dispose(): void {
    this.scene.remove(this.sun, this.sun.target, this.fill, this.hemisphere);
    this.sun.dispose();
    this.fill.dispose();
    this.hemisphere.dispose();
    this.sky.dispose();
    this.environment?.dispose();
    this.scene.environment = null;
    disposeSubtree(this.probe);
    this.pmrem.dispose();
  }
}

/**
 * A stand-in for the world outside, rendered into the image-based lighting.
 *
 * Every reflective thing in the game was lit by three.js's `RoomEnvironment` —
 * a white studio with rectangular lamps in it. It gives a beautiful roughness
 * response, and it is *the same room* on a park lawn, a midday beach and a
 * roadside at dusk: the steel of a sink caught a photographer's softbox in all
 * three, and the one appliance that should have told you where it was standing
 * told you nothing. It also fought the grade, which is trying to push the whole
 * frame amber while the highlights insist on neutral studio white.
 *
 * So the environment is the biome at this hour: its own sky above, its own
 * ground below, and its own sun where its own sun is. That is why metalness is
 * capped around 0.3 in `SURFACE` — a fully metallic surface *is* its
 * reflections — and it is the cheapest way to raise the ceiling on how metallic
 * anything is allowed to be.
 *
 * Deliberately crude: it is blurred into a handful of mip levels by
 * `PMREMGenerator` about a millisecond after it is built, so shapes in it are
 * energy, not detail.
 */
function buildProbe(sky: THREE.Texture): {
  probe: THREE.Scene;
  ground: THREE.MeshBasicMaterial;
  disc: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
} {
  const probe = new THREE.Scene();

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(12, 20, 14),
    new THREE.MeshBasicMaterial({ map: sky, side: THREE.BackSide }),
  );
  probe.add(dome);

  // What the ground throws back up. The beach is bright sand and the park is
  // grass, and the underside of everything in the room should know which — and
  // by evening, that it is standing in shade.
  const ground = new THREE.MeshBasicMaterial();
  const floor = new THREE.Mesh(new THREE.CircleGeometry(20, 20), ground);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.6;
  probe.add(floor);

  // The sun itself, well past white, so there is a hot spot for a curved metal
  // surface to catch. Colour beyond 1 is how three.js's own room does its lamps.
  const disc = new THREE.Mesh(new THREE.SphereGeometry(2.4, 12, 10), new THREE.MeshBasicMaterial());
  probe.add(disc);

  return { probe, ground, disc };
}

/** Put something on the sun's line: azimuth around Y, elevation off the ground. */
function place(
  target: THREE.Vector3,
  sun: SkyState["sun"],
  distance: number,
  around: THREE.Vector3 | null,
): void {
  const azimuth = (sun.azimuth * Math.PI) / 180;
  const elevation = (sun.elevation * Math.PI) / 180;
  target.set(
    Math.cos(azimuth) * Math.cos(elevation) * distance,
    Math.sin(elevation) * distance,
    Math.sin(azimuth) * Math.cos(elevation) * distance,
  );
  if (around) target.add(around);
}

const FROM = new THREE.Color();
const TO = new THREE.Color();

/**
 * The biome's day, read at `time` (0 at opening, 1 at closing), into `out`.
 *
 * Colours are mixed through `THREE.Color`, so they cross in linear light rather
 * than in sRGB — the difference is whether a sun going from white to amber
 * passes through a warm gold or through a muddy khaki.
 *
 * Writes into a caller-owned state rather than returning a fresh one: this runs
 * every frame, and a dozen small objects a frame is a dozen small objects the
 * collector has to come back for mid-service.
 */
export function sampleDaylight(
  keys: readonly DaylightKey[],
  time: number,
  out: SkyState,
): SkyState {
  const at = clamp01(time);
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1]!.at <= at) i++;
  const a = keys[i]!;
  const b = keys[i + 1] ?? a;
  const span = b.at - a.at;
  const t = span > 0 ? clamp01((at - a.at) / span) : 0;

  out.sky.top = mix(a.sky.top, b.sky.top, t);
  out.sky.middle = mix(a.sky.middle, b.sky.middle, t);
  out.sky.horizon = mix(a.sky.horizon, b.sky.horizon, t);

  out.fog.color = mix(a.fog.color, b.fog.color, t);
  out.fog.near = lerp(a.fog.near, b.fog.near, t);
  out.fog.far = lerp(a.fog.far, b.fog.far, t);

  out.sun.color = mix(a.sun.color, b.sun.color, t);
  out.sun.intensity = lerp(a.sun.intensity, b.sun.intensity, t);
  out.sun.azimuth = lerp(a.sun.azimuth, b.sun.azimuth, t);
  out.sun.elevation = lerp(a.sun.elevation, b.sun.elevation, t);

  out.fill.color = mix(a.fill.color, b.fill.color, t);
  out.fill.intensity = lerp(a.fill.intensity, b.fill.intensity, t);

  out.ambient.sky = mix(a.ambient.sky, b.ambient.sky, t);
  out.ambient.ground = mix(a.ambient.ground, b.ambient.ground, t);
  out.ambient.intensity = lerp(a.ambient.intensity, b.ambient.intensity, t);

  out.environmentIntensity = lerp(a.environmentIntensity, b.environmentIntensity, t);
  out.exposure = lerp(a.exposure, b.exposure, t);

  out.grade.saturation = lerp(a.grade.saturation, b.grade.saturation, t);
  out.grade.warmth = lerp(a.grade.warmth, b.grade.warmth, t);
  out.grade.lift = lerp(a.grade.lift, b.grade.lift, t);

  return out;
}

export function blankSky(): SkyState {
  return {
    sky: { top: 0, middle: 0, horizon: 0 },
    fog: { color: 0, near: 0, far: 0 },
    sun: { color: 0, intensity: 0, azimuth: 0, elevation: 0 },
    fill: { color: 0, intensity: 0 },
    ambient: { sky: 0, ground: 0, intensity: 0 },
    environmentIntensity: 0,
    exposure: 1,
    grade: { saturation: 1, warmth: 0, lift: 0 },
  };
}

function mix(from: number, to: number, t: number): number {
  return FROM.setHex(from).lerp(TO.setHex(to), t).getHex();
}

function css(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}
