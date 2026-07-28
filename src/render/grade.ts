import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

/**
 * The final image pass: colour grade, vignette, tone map, sRGB — in one shader.
 *
 * One place to control the overall mood, rather than nudging fifty material
 * colours:
 *
 *   saturation < 1   pulls colour out of everything
 *   warmth    > 0    pushes the image toward amber and away from blue
 *   lift      > 0    raises the blacks so shadows stay soft rather than crushing
 *   the vignette     darkens the corners, framing the diorama
 *
 * These used to be two separate `ShaderPass`es sitting in front of three's
 * `OutputPass`. A pass is not free: each one reads and writes the entire
 * framebuffer and swaps render targets, which at 3024x1544 is tens of megabytes
 * of pure bandwidth for a handful of arithmetic. Three operations that each
 * only reshape the pixel they are handed belong in one pass.
 *
 * Grading happens *before* tone mapping, on linear HDR colour, which is why it
 * has to live inside the output pass rather than after it: desaturation and
 * warmth behave predictably in linear light, and highlights still roll off
 * properly instead of clipping.
 *
 * We splice into three's shader rather than copying it, so the tone-mapping and
 * colour-space handling stay three's to maintain — `OutputPass` picks those
 * from the renderer's own settings, and a copy would quietly drift out of sync
 * on the next upgrade.
 */

export type Grade = { saturation: number; warmth: number; lift: number };

/** How far the vignette reaches in, and how dark it gets. */
const VIGNETTE_OFFSET = 1.1;
const VIGNETTE_DARKNESS = 1.05;

/** Splice points in three's `OutputShader`. Asserted below. */
const UNIFORM_ANCHOR = "uniform sampler2D tDiffuse;";
const PIXEL_ANCHOR = "gl_FragColor = texture2D( tDiffuse, vUv );";

const UNIFORMS = /* glsl */ `
  uniform float saturation;
  uniform float warmth;
  uniform float lift;
  uniform float offset;
  uniform float darkness;
`;

const GRADE = /* glsl */ `
  {
    vec3 graded = gl_FragColor.rgb;

    float luma = dot(graded, vec3(0.2126, 0.7152, 0.0722));
    graded = mix(vec3(luma), graded, saturation);

    graded *= vec3(1.0 + warmth * 0.075, 1.0 + warmth * 0.012, 1.0 - warmth * 0.06);
    graded += lift * (1.0 - graded);

    vec2 fromCenter = (vUv - 0.5) * offset;
    graded = mix(graded, vec3(1.0 - darkness), dot(fromCenter, fromCenter));

    gl_FragColor.rgb = graded;
  }
`;

export function createGradedOutputPass(grade: Grade): OutputPass {
  const pass = new OutputPass();
  const source = pass.material.fragmentShader;

  if (!source.includes(UNIFORM_ANCHOR) || !source.includes(PIXEL_ANCHOR)) {
    throw new Error(
      "createGradedOutputPass: three's OutputShader no longer has the expected " +
        "splice points — re-check it against this file.",
    );
  }

  pass.material.fragmentShader = source
    .replace(UNIFORM_ANCHOR, UNIFORM_ANCHOR + UNIFORMS)
    .replace(PIXEL_ANCHOR, PIXEL_ANCHOR + GRADE);

  // Added before the program is first compiled, so they are picked up normally.
  Object.assign(pass.uniforms, {
    saturation: { value: grade.saturation },
    warmth: { value: grade.warmth },
    lift: { value: grade.lift },
    offset: { value: VIGNETTE_OFFSET },
    darkness: { value: VIGNETTE_DARKNESS },
  });

  return pass;
}
