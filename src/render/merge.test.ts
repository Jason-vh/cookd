import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { mergeStatic } from "./merge";

/**
 * Baking the scenery is the one place in the renderer where a bug is silent.
 *
 * A merge that drops an attribute unshades every tree in the park; one that
 * forgets a matrix piles the whole park on the origin; one that splits a batch
 * it should not gives back the draw calls it was written to save. None of that
 * throws, and all of it is invisible in a test that only counts meshes — so
 * these check the vertices themselves.
 */

function part(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  place?: (mesh: THREE.Mesh) => void,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  place?.(mesh);
  return mesh;
}

/** Every vertex of a merged batch, in world space. */
function points(mesh: THREE.Mesh): THREE.Vector3[] {
  const position = mesh.geometry.attributes.position!;
  return Array.from({ length: position.count }, (_, i) =>
    new THREE.Vector3().fromBufferAttribute(position, i),
  );
}

describe("baking the scenery into a handful of draw calls", () => {
  test("one mesh per material, however many parts went in", () => {
    const grass = new THREE.MeshStandardMaterial({ name: "grass" });
    const bark = new THREE.MeshStandardMaterial({ name: "bark" });
    const root = new THREE.Group();
    root.add(
      part(new THREE.BoxGeometry(1, 1, 1), grass),
      part(new THREE.BoxGeometry(1, 1, 1), grass),
      part(new THREE.BoxGeometry(1, 1, 1), bark),
    );

    const merged = mergeStatic(root);

    expect(merged).toHaveLength(2);
    expect(merged.map((mesh) => mesh.material)).toEqual([grass, bark]);
  });

  test("a part is welded where it stood, not where it was authored", () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    root.position.set(10, 0, 0);
    root.add(part(new THREE.BoxGeometry(2, 2, 2), material, (mesh) => mesh.position.set(0, 5, 0)));

    const [merged] = mergeStatic(root);

    // The box is 2 across, so its corners sit a unit either side of (10, 5, 0).
    const box = new THREE.Box3().setFromPoints(points(merged!));
    expect(box.min.toArray()).toEqual([9, 4, -1]);
    expect(box.max.toArray()).toEqual([11, 6, 1]);
  });

  test("a rotated part carries its normals round with it", () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    // A quarter turn about X sends the plane's +Z normal to +Y: the difference
    // between a paving slab lit from above and one lit from the side.
    root.add(
      part(new THREE.PlaneGeometry(1, 1), material, (mesh) => {
        mesh.rotation.x = -Math.PI / 2;
      }),
    );

    const [merged] = mergeStatic(root);

    const normals = merged!.geometry.attributes.normal!;
    for (let i = 0; i < normals.count; i++) {
      const normal = new THREE.Vector3().fromBufferAttribute(normals, i);
      expect(normal.x).toBeCloseTo(0, 6);
      expect(normal.y).toBeCloseTo(1, 6);
      expect(normal.z).toBeCloseTo(0, 6);
    }
  });

  test("scaling smaller does not leave the normals short", () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    root.add(part(new THREE.BoxGeometry(1, 1, 1), material, (mesh) => mesh.scale.set(0.1, 2, 0.1)));

    const [merged] = mergeStatic(root);

    const normals = merged!.geometry.attributes.normal!;
    for (let i = 0; i < normals.count; i++) {
      const normal = new THREE.Vector3().fromBufferAttribute(normals, i);
      expect(normal.length()).toBeCloseTo(1, 6);
    }
  });

  test("shadow flags split a batch, because they are per draw call", () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    root.add(
      part(new THREE.BoxGeometry(1, 1, 1), material, (mesh) => {
        mesh.castShadow = true;
      }),
      part(new THREE.BoxGeometry(1, 1, 1), material),
    );

    const merged = mergeStatic(root);

    expect(merged).toHaveLength(2);
    expect(merged.map((mesh) => mesh.castShadow)).toEqual([true, false]);
  });

  test("baked vertex shading survives the merge", () => {
    const material = new THREE.MeshStandardMaterial({ vertexColors: true });
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const count = geometry.attributes.position!.count;
    geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(count * 3).fill(0.5), 3),
    );
    const root = new THREE.Group();
    root.add(part(geometry, material), part(geometry, material));

    const [merged] = mergeStatic(root);

    const colors = merged!.geometry.attributes.color!;
    expect(colors.count).toBe(count * 2);
    expect(colors.array.every((value) => value === 0.5)).toBe(true);
  });

  test("the index is widened once a batch outgrows 16 bits", () => {
    const material = new THREE.MeshStandardMaterial();
    // 60 segments each way is 3,721 vertices a plane, so twenty of them pass
    // the 65,535 a Uint16 index can name.
    const geometry = new THREE.PlaneGeometry(1, 1, 60, 60);
    const root = new THREE.Group();
    for (let i = 0; i < 20; i++) root.add(part(geometry, material));

    const [merged] = mergeStatic(root);

    expect(merged!.geometry.attributes.position!.count).toBeGreaterThan(65535);
    expect(merged!.geometry.index!.array).toBeInstanceOf(Uint32Array);
  });

  test("an unindexed part is given an index rather than dropped", () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    root.add(part(new THREE.PlaneGeometry(1, 1).toNonIndexed(), material));

    const [merged] = mergeStatic(root);

    const index = merged!.geometry.index!;
    expect(index.count).toBe(merged!.geometry.attributes.position!.count);
    expect(Array.from(index.array)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("attributes nothing draws with are dropped on the way in", () => {
    const material = new THREE.MeshStandardMaterial();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.setAttribute(
      "tangent",
      new THREE.BufferAttribute(new Float32Array(geometry.attributes.position!.count * 4), 4),
    );
    const root = new THREE.Group();
    root.add(part(geometry, material));

    const [merged] = mergeStatic(root);

    expect(Object.keys(merged!.geometry.attributes).sort()).toEqual(["normal", "position", "uv"]);
  });

  test("parts that disagree about their vertices say so, by name", () => {
    const material = new THREE.MeshStandardMaterial({ name: "enamel" });
    const bare = new THREE.BufferGeometry();
    bare.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    const root = new THREE.Group();
    root.add(part(new THREE.BoxGeometry(1, 1, 1), material), part(bare, material));

    expect(() => mergeStatic(root)).toThrow(/enamel/);
  });
});
