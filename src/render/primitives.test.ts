import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  capsule,
  cylinder,
  extruded,
  isCached,
  roundedCylinder,
  sphere,
  sweep,
  tonedMesh,
} from "./primitives";

/**
 * The primitive cache is load-bearing, and silently so.
 *
 * Sharing is what keeps a kitchen of hundreds of parts down to a handful of GPU
 * buffers, and `disposeSubtree` asks `isCached` before it frees anything —
 * so a factory that forgot to go through `cached()` would not look wrong, it
 * would leak until the first appliance was sold and then blank every object
 * built from the same shape. Neither failure is visible in a screenshot.
 */
describe("shared geometry", () => {
  test("the same shape is the same buffer", () => {
    expect(capsule(0.1, 0.4)).toBe(capsule(0.1, 0.4));
    expect(roundedCylinder(0.3, 0.5)).toBe(roundedCylinder(0.3, 0.5));
    expect(
      sweep(
        "test-a",
        [
          [0, 0, 0],
          [0, 1, 0],
        ],
        0.02,
      ),
    ).toBe(
      sweep(
        "test-a",
        [
          [0, 0, 0],
          [0, 1, 0],
        ],
        0.02,
      ),
    );
  });

  test("a different shape is a different buffer", () => {
    expect(capsule(0.1, 0.4)).not.toBe(capsule(0.1, 0.5));
    expect(roundedCylinder(0.3, 0.5)).not.toBe(roundedCylinder(0.3, 0.6));
  });

  test("everything handed out is owned by the cache", () => {
    expect(isCached(capsule(0.12, 0.3))).toBe(true);
    expect(isCached(roundedCylinder(0.2, 0.4))).toBe(true);
    expect(
      isCached(
        sweep(
          "test-b",
          [
            [0, 0, 0],
            [1, 0, 0],
          ],
          0.03,
        ),
      ),
    ).toBe(true);
    expect(isCached(new THREE.BoxGeometry(1, 1, 1))).toBe(false);
  });
});

/** Extent, because a primitive that is the wrong size is the fault that ships. */
function size(geometry: THREE.BufferGeometry): THREE.Vector3 {
  geometry.computeBoundingBox();
  return geometry.boundingBox!.getSize(new THREE.Vector3());
}

describe("the shapes are the size they claim", () => {
  test("a capsule is radius wider than it is asked for, at each end", () => {
    const extent = size(capsule(0.1, 0.4));
    expect(extent.y).toBeCloseTo(0.6, 2);
    expect(extent.x).toBeCloseTo(0.2, 2);
  });

  test("a rounded cylinder stands on zero and reaches its height", () => {
    const geometry = roundedCylinder(0.3, 0.5);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.y).toBeCloseTo(0, 3);
    expect(geometry.boundingBox!.max.y).toBeCloseTo(0.5, 3);
    // The fillet must eat into the corner, not out of the radius.
    expect(size(geometry).x).toBeCloseTo(0.6, 2);
  });

  test("a fillet larger than the shape cannot invert it", () => {
    const geometry = roundedCylinder(0.1, 0.1, 5);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.y).toBeCloseTo(0, 3);
    expect(size(geometry).x).toBeGreaterThan(0);
  });

  test("a sweep follows its curve", () => {
    const extent = size(
      sweep(
        "test-c",
        [
          [0, 0, 0],
          [0, 0.5, 0],
          [0.4, 0.5, 0],
        ],
        0.02,
      ),
    );
    expect(extent.y).toBeGreaterThan(0.5);
    expect(extent.x).toBeGreaterThan(0.4);
  });

  test("an extrusion can be pierced, and the hole survives the bevel", () => {
    const solid = extruded(
      "test-solid",
      (shape) => shape.absarc(0, 0, 0.2, 0, Math.PI * 2, false),
      0.1,
    );
    const pierced = extruded(
      "test-pierced",
      (shape) => {
        shape.absarc(0, 0, 0.2, 0, Math.PI * 2, false);
        const hole = new THREE.Path();
        hole.absarc(0, 0, 0.1, 0, Math.PI * 2, true);
        shape.holes.push(hole);
      },
      0.1,
    );
    // Same outline, more geometry: the hole has walls of its own.
    expect(size(pierced).x).toBeCloseTo(size(solid).x, 2);
    expect(pierced.attributes.position!.count).toBeGreaterThan(solid.attributes.position!.count);
  });
});

/** Cylinders are still the right answer where nothing is filleted. */
test("a plain cylinder is unchanged", () => {
  expect(size(cylinder(0.2, 0.2, 1)).y).toBeCloseTo(1, 5);
});

/**
 * Baked shading is invisible in code review and easy to get upside down, which
 * would light every tree in the park from underneath.
 */
const shade = (object: THREE.Mesh, index: number): number =>
  object.geometry.attributes.color!.getX(index);

describe("toned meshes", () => {
  test("are darker at the bottom than at the top", () => {
    const object = tonedMesh(cylinder(0.3, 0.3, 1), 0x88aa66, "cloth", 0.5);
    const color = object.geometry.attributes.color!;
    const position = object.geometry.attributes.position!;

    let lowest = 0;
    let highest = 0;
    for (let i = 1; i < position.count; i++) {
      if (position.getY(i) < position.getY(lowest)) lowest = i;
      if (position.getY(i) > position.getY(highest)) highest = i;
    }
    expect(shade(object, lowest)).toBeCloseTo(0.5, 5);
    expect(shade(object, highest)).toBeCloseTo(1, 5);
    expect(color.count).toBe(position.count);
  });

  test("leave the shape they were given alone", () => {
    const shared = cylinder(0.3, 0.3, 1);
    expect(tonedMesh(shared, 0x88aa66).geometry).not.toBe(shared);
    expect(shared.attributes.color).toBeUndefined();
  });

  test("share one buffer per shape and tone", () => {
    const first = tonedMesh(sphere(0.4, 8), 0x88aa66, "cloth", 0.8);
    const second = tonedMesh(sphere(0.4, 8), 0x223344, "cloth", 0.8);
    expect(first.geometry).toBe(second.geometry);
    expect(isCached(first.geometry)).toBe(true);
  });
});
