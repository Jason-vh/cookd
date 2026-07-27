import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { VignetteShader } from "three/examples/jsm/shaders/VignetteShader.js";
import { GradeShader } from "./grade";
import { LAYER } from "./layers";

/**
 * Post-processing chain for the diorama look.
 *
 * Order matters:
 *   render -> ambient occlusion -> bloom -> grade -> vignette -> output -> AA
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

export type Grade = { saturation: number; warmth: number; lift: number };

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
  const ao = new GTAOPass(scene, aoCamera, size.x, size.y);
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

  // The biome's single dial for overall mood.
  const gradePass = new ShaderPass(GradeShader);
  gradePass.uniforms.saturation!.value = grade.saturation;
  gradePass.uniforms.warmth!.value = grade.warmth;
  gradePass.uniforms.lift!.value = grade.lift;
  composer.addPass(gradePass);

  const vignette = new ShaderPass(VignetteShader);
  vignette.uniforms.offset!.value = 1.1;
  vignette.uniforms.darkness!.value = 1.05;
  composer.addPass(vignette);

  composer.addPass(new OutputPass());
  composer.addPass(new SMAAPass());

  const resize = (width: number, height: number): void => {
    composer.setSize(width, height);
    ao.setSize(width, height);
    bloom.setSize(width, height);
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
