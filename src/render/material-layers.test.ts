import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { setGhost, setGhostOpacity } from "./ghost";
import { setGlow } from "./glow";
import { disposeLayers } from "./material-layers";
import type { SingleMesh } from "./nodes";

/**
 * Ghosting and glowing sharing one material slot.
 *
 * The failure written against here is not a wrong shade: it is an appliance
 * that stays lit after the chef has walked away, because one effect recorded
 * the other's clone as the material to put back. Nothing throws, and the only
 * way out for the player was to walk back and hover it again.
 */

const RED = 0xff0000;

/** A counter-ish object: a body and a part bolted to it. */
function appliance(): { root: THREE.Object3D; meshes: SingleMesh[] } {
  const root = new THREE.Object3D();
  const meshes = [0, 1].map(() => {
    const mesh: SingleMesh = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
    );
    root.add(mesh);
    return mesh;
  });
  return { root, meshes };
}

function materials(meshes: SingleMesh[]): THREE.Material[] {
  return meshes.map((mesh) => mesh.material);
}

describe("an appliance that is pointed at", () => {
  test("puts its own materials back when nobody is pointing", () => {
    const { root, meshes } = appliance();
    const original = materials(meshes);

    setGlow(root, RED);
    expect(materials(meshes)).not.toEqual(original);
    setGlow(root, null);

    expect(materials(meshes)).toEqual(original);
  });

  test("is not left lit by being picked up mid-hover", () => {
    const { root, meshes } = appliance();
    const original = materials(meshes);

    setGlow(root, RED);
    setGhost(root, true);
    setGlow(root, null);
    setGhost(root, false);

    expect(materials(meshes)).toEqual(original);
  });

  test("stays a ghost while it is carried, whatever the highlight does", () => {
    const { root, meshes } = appliance();

    setGhost(root, true);
    const ghosted = materials(meshes);
    setGlow(root, RED);
    expect(materials(meshes)).toEqual(ghosted);

    setGlow(root, null);
    expect(materials(meshes)).toEqual(ghosted);
  });

  test("lights a part fitted after it was last lit", () => {
    const { root } = appliance();
    setGlow(root, RED);
    setGlow(root, null);

    const board: SingleMesh = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
    );
    const original = board.material;
    root.add(board);
    setGlow(root, RED);

    expect(board.material).not.toBe(original);
  });

  test("fades out through the ghost it is actually wearing", () => {
    const { root, meshes } = appliance();

    setGhost(root, true);
    setGhostOpacity(root, 0.5);

    for (const mesh of meshes) expect(mesh.material.opacity).toBeCloseTo(0.21, 5);
  });

  test("frees its clones when the appliance goes away", () => {
    const { root, meshes } = appliance();
    setGlow(root, RED);
    let freed = 0;
    for (const mesh of meshes) mesh.material.addEventListener("dispose", () => freed++);

    disposeLayers(root);

    expect(freed).toBe(meshes.length);
  });
});
