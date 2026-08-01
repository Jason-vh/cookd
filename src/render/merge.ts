import * as THREE from "three";
import { isSingleMesh } from "./nodes";

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
 * Nothing out here does move, so it is baked once per kitchen. Authoring is
 * untouched; only the shape of what reaches the scene changes.
 *
 * The trade is per-object frustum culling, which was worth nothing when the
 * camera framed the entire diorama and is worth little now it follows the
 * chefs: the park is a handful of batched draws either way, and a merged batch
 * spans the whole scene so it could never be culled anyway.
 *
 * ## Why this does not call `mergeGeometries`
 *
 * Because the library's answer needs every input handed to it *already* sitting
 * where it belongs, and geometry here is shared out of the cache in
 * `primitives.ts` — every blade of grass in the park is the same `BoxGeometry`.
 * So each part had to be cloned before it could be moved into place, and the
 * merge then copied all of it a second time into the output buffer: ~1,700 deep
 * copies of typed arrays to build one whose size was known in advance.
 *
 * Sizing the output up front and transforming each part straight into it does
 * the same job with one copy and no garbage — about 15ms off every kitchen,
 * against a build that costs ~35ms in total.
 */
export function mergeStatic(root: THREE.Object3D): THREE.Mesh[] {
  root.updateMatrixWorld(true);

  type Batch = {
    material: THREE.Material;
    castShadow: boolean;
    receiveShadow: boolean;
    parts: Part[];
  };
  const batches = new Map<string, Batch>();

  root.traverse((child) => {
    if (!isSingleMesh(child)) return;

    // Shadow flags are per-mesh in three.js but per-*draw* on the GPU, so they
    // have to split batches: grass casts no shadow and must not be merged into
    // something that does.
    const material = child.material;
    const key = `${material.uuid}|${child.castShadow ? 1 : 0}|${child.receiveShadow ? 1 : 0}`;

    let batch = batches.get(key);
    if (!batch) {
      batch = {
        material,
        castShadow: child.castShadow,
        receiveShadow: child.receiveShadow,
        parts: [],
      };
      batches.set(key, batch);
    }
    // The matrix is read, never kept: `weld` consumes it before anything in the
    // tree has had the chance to move.
    batch.parts.push({ geometry: child.geometry, matrix: child.matrixWorld });
  });

  const merged: THREE.Mesh[] = [];
  for (const batch of batches.values()) {
    const mesh = new THREE.Mesh(weld(batch.parts, batch.material), batch.material);
    mesh.castShadow = batch.castShadow;
    mesh.receiveShadow = batch.receiveShadow;
    merged.push(mesh);
  }
  return merged;
}

type Part = { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 };

/**
 * Attributes a merged batch carries. Anything else is dropped.
 *
 * `color` is here because scenery is where baked vertex shading is worth the
 * most and merging is compulsory out there — dropping it would have quietly
 * unshaded every tree in the park. Batches are keyed by material and only a
 * `vertexColors` material ever gets shaded geometry, so a batch cannot end up
 * half with colours and half without.
 */
const KEEP = ["position", "normal", "uv", "color"] as const;

/** Which of `KEEP` a batch carries, and how wide each one is. */
type Layout = { name: string; itemSize: number }[];

/** One batch, transformed into a single indexed geometry. */
function weld(parts: readonly Part[], material: THREE.Material): THREE.BufferGeometry {
  const layout = layoutOf(parts[0]!.geometry, material);

  let vertices = 0;
  let indices = 0;
  for (const part of parts) {
    const count = vertexCount(part.geometry, layout, material);
    vertices += count;
    indices += part.geometry.index?.count ?? count;
  }

  const arrays = layout.map((entry) => new Float32Array(vertices * entry.itemSize));
  const positions = arrays[0]!;
  const normals = arrays[layout.findIndex((entry) => entry.name === "normal")] ?? null;
  /**
   * Indexed rather than flattened on purpose: merging duplicates every
   * instance's vertices, and keeping the index buffer is the difference between
   * a few megabytes and a few tens of them.
   */
  const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);

  let vertex = 0;
  let slot = 0;
  for (const part of parts) {
    const geometry = part.geometry;
    const count = vertexCount(geometry, layout, material);

    layout.forEach((entry, i) => {
      arrays[i]!.set(attribute(geometry, entry, material).array, vertex * entry.itemSize);
    });
    place(positions, normals, part.matrix, vertex, count);

    const source = geometry.index;
    if (source) for (let i = 0; i < source.count; i++) index[slot++] = vertex + source.getX(i);
    else for (let i = 0; i < count; i++) index[slot++] = vertex + i;

    vertex += count;
  }

  const geometry = new THREE.BufferGeometry();
  layout.forEach((entry, i) => {
    geometry.setAttribute(entry.name, new THREE.BufferAttribute(arrays[i]!, entry.itemSize));
  });
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return geometry;
}

/**
 * Move one part's vertices into the world: positions through the matrix,
 * normals through its normal matrix.
 *
 * Written over the output buffer rather than over a copy of the source, which
 * is the whole point — the source is shared with every other part built from
 * the same shape, including the appliances and chefs still drawn individually.
 */
function place(
  positions: Float32Array,
  normals: Float32Array | null,
  matrix: THREE.Matrix4,
  from: number,
  count: number,
): void {
  for (let i = from; i < from + count; i++) {
    VERTEX.fromArray(positions, i * 3)
      .applyMatrix4(matrix)
      .toArray(positions, i * 3);
  }
  if (!normals) return;

  NORMALS.getNormalMatrix(matrix);
  for (let i = from; i < from + count; i++) {
    VERTEX.fromArray(normals, i * 3)
      .applyNormalMatrix(NORMALS)
      .toArray(normals, i * 3);
  }
}

const VERTEX = new THREE.Vector3();
const NORMALS = new THREE.Matrix3();

/** What the batch carries, decided by whichever part turned up first. */
function layoutOf(geometry: THREE.BufferGeometry, material: THREE.Material): Layout {
  const layout: Layout = [];
  for (const name of KEEP) {
    const found = geometry.getAttribute(name);
    if (found) layout.push({ name, itemSize: found.itemSize });
  }
  if (layout[0]?.name !== "position") {
    throw new Error(`mergeStatic: a part drawn with "${describe(material)}" has no position`);
  }
  return layout;
}

/**
 * How many vertices this part contributes, having agreed it belongs here.
 *
 * `mergeGeometries` used to make this complaint and it is worth keeping: a
 * batch is keyed by material, so parts that disagree about their attributes are
 * two shapes that were never meant to be drawn the same way. Counting is where
 * the check lives because every part is counted, twice — once to size the
 * buffers and once to fill them.
 */
function vertexCount(
  geometry: THREE.BufferGeometry,
  layout: Layout,
  material: THREE.Material,
): number {
  let carried = 0;
  for (const name of KEEP) if (geometry.getAttribute(name)) carried++;
  if (carried !== layout.length) fail(material, "carry different attributes");
  return attribute(geometry, layout[0]!, material).count;
}

/** One part's copy of one attribute, in the plain float form a merge can copy. */
function attribute(
  geometry: THREE.BufferGeometry,
  entry: Layout[number],
  material: THREE.Material,
): THREE.BufferAttribute {
  const found = geometry.getAttribute(entry.name);
  if (!(found instanceof THREE.BufferAttribute) || found.normalized) {
    fail(material, `store "${entry.name}" in an interleaved or normalized buffer`);
  }
  if (found.itemSize !== entry.itemSize)
    fail(material, `disagree about the width of "${entry.name}"`);
  return found;
}

function fail(material: THREE.Material, complaint: string): never {
  throw new Error(
    `mergeStatic: parts sharing material "${describe(material)}" ${complaint}. ` +
      `A batch is one draw call, so every part in it has to have the same shape of vertex.`,
  );
}

function describe(material: THREE.Material): string {
  return material.name || material.uuid;
}
