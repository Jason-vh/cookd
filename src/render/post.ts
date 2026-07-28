import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { createGradedOutputPass, type Grade } from "./grade";
import { LAYER } from "./layers";

/**
 * Post-processing chain for the diorama look.
 *
 * Order matters:
 *   render -> ambient occlusion -> bloom -> grade+vignette+output -> AA
 *
 * The effect doing the heavy lifting is **GTAO**: contact shadows in every
 * crevice are what make objects feel like they're actually resting on the
 * counter rather than floating near it.
 *
 * There is deliberately **no depth of field / tilt-shift**. It is the classic
 * "miniature" trick, but the entire kitchen is playable space and blurring any
 * of it costs readability for no gameplay benefit.
 *
 * Disable with `?fx=off` in the URL when profiling or on a weak GPU.
 */

export type Post = {
  composer: EffectComposer;
  resize(width: number, height: number): void;
  render(): void;
};

/**
 * Ambient occlusion and bloom render at half the framebuffer's resolution.
 *
 * Both are low-frequency by nature — AO is a soft contact darkening that the
 * pass immediately runs a denoise blur over, and bloom *is* a blur — so neither
 * carries detail that survives to the eye at full resolution. Both are close to
 * pure memory bandwidth, and at 3024x1544 the AO pass alone measures 59% more
 * expensive at full resolution for no visible difference.
 *
 * This has to be re-applied after every `composer.setSize`, which resets each
 * pass to the full framebuffer.
 *
 * It used to happen by accident: these two lines passed *CSS* pixels where the
 * composer had just passed *device* pixels, so the effects ran at half
 * resolution on a retina display and full resolution on a 1x one. Same game,
 * different look and a 59% swing in cost depending on the monitor. Scaling from
 * the real framebuffer size makes it the same everywhere.
 */
const EFFECT_SCALE = 0.5;

export function createPost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.OrthographicCamera,
  grade: Grade,
): Post {
  const size = renderer.getSize(new THREE.Vector2());
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.addPass(new RenderPass(scene, camera));

  /**
   * Ambient occlusion runs through a *copy* of the camera that cannot see the
   * UI layer.
   *
   * GTAO rebuilds the scene into a depth/normal buffer using an override
   * material, and 3D UI lies to that buffer: it ignores depth testing, sits in
   * front of the world, and sprites are billboarded inside their vertex shader,
   * so an override material draws them un-billboarded as phantom geometry.
   * `GTAOPass` skips Points and Lines for exactly this reason but not Sprites,
   * which put a large dark rectangle of occlusion behind every appliance label.
   *
   * Excluding the layer here (rather than rendering UI in a separate pass after
   * the composer) keeps the whole frame in one `renderer.render` call, so
   * lights, shadows and clear state are only ever set up once.
   */
  const aoCamera = camera.clone();
  aoCamera.layers.set(LAYER.WORLD);
  const ao = new GTAOPass(scene, aoCamera, size.x * EFFECT_SCALE, size.y * EFFECT_SCALE);
  ao.blendIntensity = 0.85;
  ao.updateGtaoMaterial({
    radius: 0.4,
    distanceExponent: 1.2,
    thickness: 0.6,
    scale: 1.1,
    samples: 16,
    screenSpaceRadius: false,
  });
  ao.updatePdMaterial({ lumaPhi: 8, depthPhi: 2.5, normalPhi: 4, radius: 4, rings: 2, samples: 8 });
  composer.addPass(ao);

  // A whisper of bloom. Enamel is soft, not glowing.
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.13, 0.75, 0.86);
  composer.addPass(bloom);

  // The biome's mood dial, the vignette, tone mapping and the sRGB conversion,
  // all in the one shader that finishes the image — see grade.ts.
  composer.addPass(createGradedOutputPass(grade));

  // After the output pass on purpose: SMAA needs sRGB input to find edges.
  composer.addPass(new SMAAPass());

  const resize = (width: number, height: number): void => {
    composer.setSize(width, height);
    // Device pixels, not CSS pixels: `composer.setSize` scales by the pixel
    // ratio internally and these must be measured against the same framebuffer.
    const scale = renderer.getPixelRatio() * EFFECT_SCALE;
    ao.setSize(Math.ceil(width * scale), Math.ceil(height * scale));
    bloom.setSize(Math.ceil(width * scale), Math.ceil(height * scale));
  };
  resize(size.x, size.y);

  const render = (): void => {
    aoCamera.copy(camera);
    aoCamera.layers.set(LAYER.WORLD);
    composer.render();
  };

  return { composer, resize, render };
}

export function postEnabled(): boolean {
  return new URLSearchParams(location.search).get("fx") !== "off";
}
