import * as THREE from "three";

/**
 * Typed narrowing for scene-graph nodes.
 *
 * `child instanceof THREE.Mesh` does narrow, but it narrows to
 * `Mesh<any, any, any>` — @types/three declares the class with three generic
 * parameters and `instanceof` cannot infer them, so `.material` and `.geometry`
 * come back as `any` and everything downstream of them is unchecked. The old
 * `(child as THREE.Mesh).isMesh` pattern was worse in the same direction: it
 * asserted first and tested afterwards.
 *
 * These predicates pin the parameters once so the rest of the render layer gets
 * real types out of a traverse.
 */

export type SceneMesh = THREE.Mesh;

export function isMesh(node: THREE.Object3D): node is SceneMesh {
  return node instanceof THREE.Mesh;
}

/** A mesh with exactly one material — which is everything this game builds. */
export type SingleMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material>;

export function isSingleMesh(node: THREE.Object3D): node is SingleMesh {
  return node instanceof THREE.Mesh && !Array.isArray(node.material);
}
