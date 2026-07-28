import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Collapse a tree of static meshes into one mesh per material.
 *
 * Scenery is authored as hundreds of small parts because that is the readable
 * way to write it: a tree is a trunk and four blobs, a picnic table is a top
 * and eight legs, a tuft of grass is three blades. The GPU does not care about
 * any of that, but three.js charges a fixed CPU toll per mesh per pass — a
 * matrix upload, a material state check, a draw call — and this scene renders
 * three passes (shadow map, ambient-occlusion depth/normal, main). At ~1,700
 * meshes that was 3,800 draw calls a frame to draw a park that never moves.
 *
 * Nothing out here does move, so it is baked once at startup. Authoring is
 * untouched; only the shape of what reaches the scene changes.
 *
 * The trade is per-object frustum culling, which this game does not want
 * anyway: the camera is fixed and orthographic and frames the entire diorama,
 * so nothing is ever off-screen to cull.
 */
export function mergeStatic(root: THREE.Object3D): THREE.Mesh[] {
  root.updateMatrixWorld(true);

  type Batch = {
    material: THREE.Material;
    castShadow: boolean;
    receiveShadow: boolean;
    geometries: THREE.BufferGeometry[];
  };
  const batches = new Map<string, Batch>();

  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;

    // Shadow flags are per-mesh in three.js but per-*draw* on the GPU, so they
    // have to split batches: grass casts no shadow and must not be merged into
    // something that does.
    const material = mesh.material as THREE.Material;
    const key = `${material.uuid}|${mesh.castShadow ? 1 : 0}|${mesh.receiveShadow ? 1 : 0}`;

    let batch = batches.get(key);
    if (!batch) {
      batch = {
        material,
        castShadow: mesh.castShadow,
        receiveShadow: mesh.receiveShadow,
        geometries: [],
      };
      batches.set(key, batch);
    }

    const geometry = mergeable(mesh.geometry);
    geometry.applyMatrix4(mesh.matrixWorld);
    batch.geometries.push(geometry);
  });

  const merged: THREE.Mesh[] = [];
  for (const batch of batches.values()) {
    const geometry = mergeGeometries(batch.geometries);
    if (!geometry) {
      throw new Error(
        `mergeStatic: could not merge ${batch.geometries.length} geometries sharing ` +
          `material "${batch.material.name || batch.material.uuid}" — they must agree on ` +
          `their vertex attributes.`,
      );
    }
    // The per-part copies were scratch; only the merged buffer goes to the GPU.
    for (const source of batch.geometries) source.dispose();

    const mesh = new THREE.Mesh(geometry, batch.material);
    mesh.castShadow = batch.castShadow;
    mesh.receiveShadow = batch.receiveShadow;
    merged.push(mesh);
  }
  return merged;
}

/** Attributes a merged batch carries. Anything else is dropped. */
const KEEP = new Set(["position", "normal", "uv"]);

/**
 * `mergeGeometries` requires every input to agree on indexing and on which
 * attributes it carries, so normalise to indexed position/normal/uv.
 *
 * Indexed rather than flattened on purpose: merging duplicates every instance's
 * vertices, and keeping the index buffer is the difference between a few
 * megabytes and a few tens of them.
 *
 * Always works on a copy — the source geometry is shared, via the cache in
 * `primitives.ts`, with appliances and chefs that are still drawn individually.
 */
function mergeable(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const copy = geometry.clone();
  for (const name of Object.keys(copy.attributes)) {
    if (!KEEP.has(name)) copy.deleteAttribute(name);
  }
  copy.morphAttributes = {};
  copy.clearGroups();

  if (!copy.index) {
    const count = copy.attributes.position!.count;
    const index = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    for (let i = 0; i < count; i++) index[i] = i;
    copy.setIndex(new THREE.BufferAttribute(index, 1));
  }
  return copy;
}
