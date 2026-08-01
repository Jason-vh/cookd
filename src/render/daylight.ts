import * as THREE from "three";
import type { Biome, DaylightKey, SkyState } from "../data/biomes";
import { FAIR, type SkyShift } from "../data/weather";
import { clamp01, ease, lerp } from "./anim";
import { disposeSubtree } from "./dispose";

/**
 * The sky, the hour it is, and the weather it is in.
 *
 * A biome keyframes its own day (`data/biomes.ts`); this samples that curve
 * against the service clock, bends the result by the day's
 * [weather](../../docs/weather.md), and pushes it at everything that cares —
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

/** Where the sun hangs, in world units. */
const SUN_DISTANCE = 25;

/**
 * How far along the sun's own line the shadow camera looks, either side of it.
 *
 * This is the axis that has to be generous rather than tight: a caster whose
 * shadow reaches the kitchen from off-screen is *up-sun* of it, which is depth
 * here and costs nothing but precision — unlike the two axes across it, where
 * every extra metre is shadow-map resolution spent on grass nobody is looking
 * at.
 */
const SHADOW_DEPTH = 24;

/**
 * How far past the edge of the frame the shadow camera reaches, in tiles.
 *
 * Only for casters standing just out of shot: their shadows fall *along* the
 * sun's line, which the depth range above covers, so this only has to hold the
 * bodies themselves.
 */
const SHADOW_MARGIN = 2.5;

/** Half-extents the shadow box never shrinks below, in tiles. */
const SHADOW_MIN = 6;

/**
 * Shadow map resolution.
 *
 * The other half of the sharpness, and affordable because shadows measured 4%
 * of a frame when the whole map was being spent on the wrong place (see
 * `docs/performance.md`) — the pass draws a handful of merged meshes, so this
 * buys resolution rather than draw calls.
 */
const SHADOW_MAP = 4096;

/**
 * The step the shadow box's size and centre are quantised to, in tiles.
 *
 * The box has to move with the camera, and a box that slides smoothly makes
 * every shadow edge in the kitchen crawl as it resamples — the classic reason
 * to snap a shadow camera to whole texels. The size is quantised for the same
 * reason at one remove: it decides how big a texel *is*, so a box that resized
 * every frame would move the grid the centre is snapped to.
 */
const SHADOW_QUANTUM = 0.5;

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

/**
 * How fast the sky changes its mind about the weather, per second.
 *
 * Slower than the clock's catch-up, and for the opposite reason. The hour eases
 * because closing time hands it a whole day to travel backwards; the weather
 * eases because it changes *once*, between two days, and a hard cut from a
 * bright afternoon to a grey one is the one moment in the game that would look
 * like a bug rather than like weather.
 */
const WEATHER_CHANGE = 0.7;

/** Close enough to the target that the crossfade can stop costing a re-bake. */
const SETTLED = 0.002;

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

  private keys: readonly DaylightKey[] = [];
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

  /** The weather being drawn, and the one being drawn *toward*. See `setWeather`. */
  private readonly shift: SkyShift = { ...FAIR.sky };
  private target: SkyShift = FAIR.sky;
  private settling = false;

  /** Live corners of the ground in shot, or null for a fixed box. See `follow`. */
  private followed: readonly THREE.Vector3[] | null = null;
  /** Half-extents of the shadow box, across the sun's line and along it. */
  private readonly shadowBox = { right: 0, up: 0 };

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    biome: Biome,
    bounds: DaylightBounds,
    options: DaylightOptions = {},
  ) {
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
    this.sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;

    const shadowCam = this.sun.shadow.camera;
    shadowCam.near = SUN_DISTANCE - SHADOW_DEPTH;
    shadowCam.far = SUN_DISTANCE + SHADOW_DEPTH;

    scene.add(this.sun, this.sun.target, this.fill, this.hemisphere);

    if (options.atmosphere !== false) {
      scene.background = this.sky;
      scene.fog = new THREE.Fog(0xffffff, 1, 2);
    }

    this.setBiome(biome, bounds);
  }

  /**
   * Put this sky over a different kitchen, at opening time.
   *
   * Everything expensive here — the canvas, the PMREM generator, the probe
   * scene — belongs to the renderer rather than to the place, so swapping
   * biomes is re-aiming three lights and redrawing a four-pixel gradient.
   */
  setBiome(biome: Biome, bounds: DaylightBounds): void {
    this.keys = biome.daylight;
    this.sun.target.position.set(bounds.cx, 0, bounds.cz);
    this.fill.position.set(bounds.cx - 10, 7, bounds.cz - 8);

    // Until somebody says otherwise, cover the whole kitchen: that is what the
    // gallery wants, and it is what the game gets on the frame before its
    // camera has decided where it is looking.
    this.fitShadows(Math.max(bounds.width, bounds.height) * 0.72 + SHADOW_MARGIN);

    // A new biome at the same hour is a different sky, so the bucket the last
    // one was drawn in says nothing about this one.
    this.step = -1;
    this.set(0);
  }

  /**
   * Spend the shadow map on the ground actually in shot.
   *
   * `corners` is kept by reference and re-read every frame, because the camera
   * rewrites its own in place (`camera.ts`) and this is not worth an allocation
   * a frame to restate.
   *
   * The kitchen is 22 tiles wide and the camera frames about eleven of them, so
   * a shadow box drawn around the *building* spends three quarters of its
   * resolution on lawn nobody is looking at. That is most of the difference
   * between a shadow edge that steps in visible chunks and one that does not —
   * the rest is the sun's height, which stretches every shadow texel across the
   * ground by `1 / sin(elevation)` and is why the keys have a floor under them.
   */
  follow(corners: readonly THREE.Vector3[]): void {
    this.followed = corners;
  }

  /**
   * What the weather is doing to the light, from today's row in
   * `data/weather.ts`.
   *
   * Takes the **shift** rather than the weather, because a light does not need
   * to know what rain is called. Compared by identity: the rows are module
   * constants, so a frame that hands over the same weather again costs a
   * pointer comparison.
   */
  setWeather(shift: SkyShift): void {
    if (shift === this.target) return;
    this.target = shift;
    this.settling = true;
  }

  /**
   * Move the day toward `target` (0 at opening, 1 at closing), easing rather
   * than jumping so a rollover to the next morning dissolves.
   */
  update(target: number, dt: number): void {
    if (this.settling) this.settling = !approach(this.shift, this.target, ease(WEATHER_CHANGE, dt));
    this.set(lerp(this.time, clamp01(target), ease(CATCH_UP, dt)));
  }

  /** Stand the day at one hour and leave it there. */
  set(time: number): void {
    this.time = time;
    const state = applyWeather(sampleDaylight(this.keys, time, this.state), this.shift);

    // Aim first, then stand the sun on the line: the shadow box is centred on
    // wherever the light is looking, and moving that afterwards would leave the
    // light pointing a frame behind its own frustum.
    this.aimShadows(state);
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

    // The gradient and the environment map are bucketed against the clock, and
    // a weather crossfade moves neither — so while one is running they have to
    // be redrawn on their own account, or the sky behind a kitchen would stay
    // yesterday's colour until the hour happened to tick over.
    const step = Math.round(time * STEPS);
    if (step === this.step && !this.settling) return;
    this.step = step;
    this.drawSky();
    this.bakeEnvironment();
  }

  /**
   * Point the shadow camera at the ground in shot, snapped to whole texels.
   *
   * Everything happens in the light's own axes, which are the ones three builds
   * for the shadow camera: `right` across the sun's line and `up` along it,
   * both perpendicular to the light. The corners of the visible floor are
   * measured in those axes, the box is sized to hold them, and its centre is
   * then rounded to a multiple of one shadow texel — without which the whole
   * shadow map resamples every time the camera pans by a fraction of a texel,
   * and every edge in the kitchen crawls.
   */
  private aimShadows(state: SkyState): void {
    if (!this.followed) return;

    direction(DIR, state.sun);
    RIGHT.set(0, 1, 0).cross(DIR).normalize();
    UP.copy(DIR).cross(RIGHT);

    let minR = Infinity;
    let maxR = -Infinity;
    let minU = Infinity;
    let maxU = -Infinity;
    let depth = 0;
    for (const corner of this.followed) {
      minR = Math.min(minR, corner.dot(RIGHT));
      maxR = Math.max(maxR, corner.dot(RIGHT));
      minU = Math.min(minU, corner.dot(UP));
      maxU = Math.max(maxU, corner.dot(UP));
      depth += corner.dot(DIR) / this.followed.length;
    }

    const box = this.fitShadows(
      (maxR - minR) / 2 + SHADOW_MARGIN,
      (maxU - minU) / 2 + SHADOW_MARGIN,
    );
    this.sun.target.position
      .copy(RIGHT)
      .multiplyScalar(snap((minR + maxR) / 2, (2 * box.right) / SHADOW_MAP))
      .addScaledVector(UP, snap((minU + maxU) / 2, (2 * box.up) / SHADOW_MAP))
      .addScaledVector(DIR, depth);
  }

  /**
   * Size the shadow box, in quantised steps so that the texel grid the centre
   * is snapped to holds still while the camera zooms.
   */
  private fitShadows(halfRight: number, halfUp = halfRight): { right: number; up: number } {
    const box = this.shadowBox;
    const right = Math.max(SHADOW_MIN, Math.ceil(halfRight / SHADOW_QUANTUM) * SHADOW_QUANTUM);
    const up = Math.max(SHADOW_MIN, Math.ceil(halfUp / SHADOW_QUANTUM) * SHADOW_QUANTUM);
    if (right !== box.right || up !== box.up) {
      box.right = right;
      box.up = up;
      const shadowCam = this.sun.shadow.camera;
      shadowCam.left = -right;
      shadowCam.right = right;
      shadowCam.top = up;
      shadowCam.bottom = -up;
      shadowCam.updateProjectionMatrix();
    }
    return box;
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

/** The light's own axes: toward the sun, and the two across it. */
const DIR = new THREE.Vector3();
const RIGHT = new THREE.Vector3();
const UP = new THREE.Vector3();

/** Which way the sun is, as a unit vector: azimuth around Y, elevation off the ground. */
function direction(target: THREE.Vector3, sun: SkyState["sun"]): THREE.Vector3 {
  const azimuth = (sun.azimuth * Math.PI) / 180;
  const elevation = (sun.elevation * Math.PI) / 180;
  return target.set(
    Math.cos(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    Math.sin(azimuth) * Math.cos(elevation),
  );
}

/** Put something on the sun's line, `distance` out from `around`. */
function place(
  target: THREE.Vector3,
  sun: SkyState["sun"],
  distance: number,
  around: THREE.Vector3 | null,
): void {
  direction(target, sun).multiplyScalar(distance);
  if (around) target.add(around);
}

/** Round to a multiple of `step`, which is how a shadow box stops crawling. */
function snap(value: number, step: number): number {
  return Math.round(value / step) * step;
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

/**
 * Bend a sampled sky by the weather, in place.
 *
 * Everything cloud does to a day is one of three moves: take the sun out, put
 * the difference back into the flat light so the frame does not simply go dark,
 * and pull every colour in it toward one grey. So that is what this is — three
 * moves over ten numbers, rather than a second set of keyframes per biome per
 * weather, which would be nine days to keep in step to say the same thing three
 * times.
 *
 * The sun's **direction** is deliberately untouched. It is still up there, the
 * shadows still fall the way the hour says, and the shadow camera is still
 * aimed at a light it can find. An overcast sky with no shadows at all reads as
 * a renderer that has stopped working rather than as weather.
 */
export function applyWeather(out: SkyState, shift: SkyShift): SkyState {
  const haze = shift.haze;
  if (haze > 0) {
    out.sky.top = mix(out.sky.top, shift.tint, haze);
    out.sky.middle = mix(out.sky.middle, shift.tint, haze);
    out.sky.horizon = mix(out.sky.horizon, shift.tint, haze);
    out.fog.color = mix(out.fog.color, shift.tint, haze);
    out.fill.color = mix(out.fill.color, shift.tint, haze);
    out.ambient.sky = mix(out.ambient.sky, shift.tint, haze);
    // The sun keeps more of its own colour than the sky does: what is left of a
    // low sun through cloud is still warmer than the cloud.
    out.sun.color = mix(out.sun.color, shift.tint, haze * 0.75);
  }

  out.fog.near *= shift.fog;
  out.fog.far *= shift.fog;
  out.sun.intensity *= shift.sun;
  out.fill.intensity *= shift.fill;
  out.ambient.intensity *= shift.ambient;
  out.environmentIntensity *= shift.ambient;
  out.exposure *= shift.exposure;

  out.grade.saturation *= shift.saturation;
  // Warmth is a push toward amber and cannot be a pull away from it, so a grey
  // day takes the biome's warmth off rather than going cold: the clamp is the
  // difference between an overcast park and a blue one.
  out.grade.warmth = Math.max(0, out.grade.warmth + shift.warmth);
  out.grade.lift += shift.lift;
  return out;
}

/**
 * Ease one shift toward another, in place. True once it has arrived.
 *
 * Every field is a plain number except the tint, which is a colour and is mixed
 * as one — the same rule `sampleDaylight` follows, and for the same reason.
 *
 * Arrival is measured across the three fields that carry the change rather than
 * on one of them, because two weathers are allowed to agree about any single
 * number: an overcast day and a rainy one could share a haze and differ in
 * everything else, and a crossfade that called itself finished there would snap
 * the rest.
 */
function approach(out: SkyShift, to: SkyShift, t: number): boolean {
  out.sun = lerp(out.sun, to.sun, t);
  out.fill = lerp(out.fill, to.fill, t);
  out.ambient = lerp(out.ambient, to.ambient, t);
  out.fog = lerp(out.fog, to.fog, t);
  out.tint = mix(out.tint, to.tint, t);
  out.haze = lerp(out.haze, to.haze, t);
  out.saturation = lerp(out.saturation, to.saturation, t);
  out.warmth = lerp(out.warmth, to.warmth, t);
  out.lift = lerp(out.lift, to.lift, t);
  out.exposure = lerp(out.exposure, to.exposure, t);
  const moved = Math.max(
    Math.abs(out.haze - to.haze),
    Math.abs(out.sun - to.sun),
    Math.abs(out.saturation - to.saturation),
  );
  if (moved > SETTLED) return false;
  // Snapped once it is close, so a crossfade that is over stops asking for the
  // environment map to be baked again on every frame for ever.
  Object.assign(out, to);
  return true;
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
