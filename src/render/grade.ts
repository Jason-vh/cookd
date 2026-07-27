/**
 * Global colour grade.
 *
 * One place to control the overall mood, rather than nudging fifty material
 * colours. Runs after bloom and before tone mapping, so it operates on linear
 * colour: desaturation and warmth behave predictably and highlights still roll
 * off properly in the OutputPass.
 *
 *   saturation < 1  pulls colour out of everything
 *   warmth    > 0   pushes the image toward amber and away from blue
 *   lift      > 0   raises the blacks so shadows stay soft rather than crushing
 */
export const GradeShader = {
  name: "GradeShader",

  uniforms: {
    tDiffuse: { value: null },
    saturation: { value: 1 },
    warmth: { value: 0 },
    lift: { value: 0 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float saturation;
    uniform float warmth;
    uniform float lift;
    varying vec2 vUv;

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 color = texel.rgb;

      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(luma), color, saturation);

      color *= vec3(1.0 + warmth * 0.075, 1.0 + warmth * 0.012, 1.0 - warmth * 0.06);
      color += lift * (1.0 - color);

      gl_FragColor = vec4(color, texel.a);
    }
  `,
};
