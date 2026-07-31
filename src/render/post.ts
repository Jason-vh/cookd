import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { createGradedOutputPass, type Grade } from "./grade";

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
  /** The mood dial, which moves with the hour — see `daylight.ts`. */
  setGrade: (grade: Grade) => void;
  /** Release the render targets. The chain holds several framebuffers. */
  dispose(): void;
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
  const pixelRatio = renderer.getPixelRatio();

  /**
   * A *readable* depth buffer on the composer's targets.
   *
   * `RenderPass` already draws the whole scene and produces depth, but by
   * default that depth lives in a renderbuffer nobody can sample, so `GTAOPass`
   * drew the entire scene a second time with an override material purely to get
   * its own copy. Making it a texture lets the AO pass reuse the first one:
   * 648 draw calls a frame become 335, and the CPU cost of a render drops from
   * 1.1ms to 0.7ms. Normals are reconstructed from that depth rather than
   * rendered, which shifts 0.06% of pixels by more than 24/255 — thin lines at
   * contact-shadow edges, invisible at rest.
   */
  const depthTexture = new THREE.DepthTexture(size.x * pixelRatio, size.y * pixelRatio);
  depthTexture.format = THREE.DepthStencilFormat;
  depthTexture.type = THREE.UnsignedInt248Type;

  const composer = new EffectComposer(
    renderer,
    new THREE.WebGLRenderTarget(size.x * pixelRatio, size.y * pixelRatio, {
      type: THREE.HalfFloatType,
      depthTexture,
    }),
  );
  composer.setPixelRatio(pixelRatio);
  composer.addPass(new RenderPass(scene, camera));

  /**
   * The 3D UI used to need excluding from this pass with a layer-masked camera
   * clone: GTAO's own G-buffer render drew billboarded sprites un-billboarded,
   * hanging a dark rectangle of occlusion behind every appliance label. Reading
   * the main depth buffer removes the problem at the source, because UI draws
   * with `depthWrite: false` and so never reaches the depth buffer at all.
   */
  const ao = new GTAOPass(scene, camera, size.x * EFFECT_SCALE, size.y * EFFECT_SCALE);
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
  const output = createGradedOutputPass(grade);
  composer.addPass(output.pass);

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
    // `RenderPass` draws into the composer's *read* buffer, so that is where
    // this frame's depth lands. Re-pointing every frame keeps it correct however
    // the ping-pong falls out, rather than depending on there being an even
    // number of buffer-swapping passes in the chain.
    ao.setGBuffer(composer.readBuffer.depthTexture ?? undefined);
    composer.render();
  };

  const dispose = (): void => {
    for (const pass of composer.passes) pass.dispose?.();
    composer.dispose();
  };

  return { composer, resize, render, dispose, setGrade: output.setGrade };
}

export function postEnabled(): boolean {
  return new URLSearchParams(location.search).get("fx") !== "off";
}
