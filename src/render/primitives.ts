import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { SURFACE, type SurfaceName } from "./palette";

/**
 * Shared geometry/material factories.
 *
 * Everything is cached by shape parameters, so the hundreds of little parts
 * that make up the kitchen collapse onto a handful of GPU buffers. Geometry is
 * always built at final size and never unit-scaled: scaling a rounded box
 * smears its bevel, which is the whole reason the art style works.
 */

const geometries = new Map<string, THREE.BufferGeometry>();
const materials = new Map<string, THREE.MeshStandardMaterial>();

function cached(key: string, create: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let geometry = geometries.get(key);
  if (!geometry) {
    geometry = create();
    geometries.set(key, geometry);
  }
  return geometry;
}

export function roundedBox(w: number, h: number, d: number, radius = 0.06): THREE.BufferGeometry {
  const r = Math.min(radius, Math.min(w, h, d) / 2 - 0.001);
  return cached(`box:${w},${h},${d},${r}`, () => new RoundedBoxGeometry(w, h, d, 3, r));
}

/**
 * A plain, unbevelled box — for parts too small for a bevel to survive to the
 * screen.
 *
 * `roundedBox` subdivides into a 7x7x7 grid to carry its corner radius, which
 * is 588 triangles. That is the right price for an oven door and an absurd one
 * for a blade of grass four pixels wide; 780 blades were most of the scene's
 * geometry. Rule 1 of the art style still holds where it can be seen.
 */
export function box(w: number, h: number, d: number): THREE.BufferGeometry {
  return cached(`raw:${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
}

export function sphere(radius: number, segments = 20): THREE.BufferGeometry {
  return cached(
    `sph:${radius},${segments}`,
    () => new THREE.SphereGeometry(radius, segments, Math.round(segments * 0.7)),
  );
}

export function cylinder(
  rTop: number,
  rBottom: number,
  h: number,
  sides = 24,
): THREE.BufferGeometry {
  return cached(
    `cyl:${rTop},${rBottom},${h},${sides}`,
    () => new THREE.CylinderGeometry(rTop, rBottom, h, sides),
  );
}

export function torus(radius: number, tube: number): THREE.BufferGeometry {
  return cached(`tor:${radius},${tube}`, () => new THREE.TorusGeometry(radius, tube, 10, 28));
}

export function cone(radius: number, h: number, sides = 12): THREE.BufferGeometry {
  return cached(`con:${radius},${h},${sides}`, () => new THREE.ConeGeometry(radius, h, sides));
}

/** Surface of revolution from a 2D profile — the honest way to model crockery. */
export function lathe(
  key: string,
  points: [number, number][],
  segments = 32,
): THREE.BufferGeometry {
  return cached(
    `lat:${key}`,
    () =>
      new THREE.LatheGeometry(
        points.map(([x, y]) => new THREE.Vector2(x, y)),
        segments,
      ),
  );
}

/** Extruded 2D shape with a bevel; used for wedges and other flat-sided food. */
export function extruded(
  key: string,
  build: (shape: THREE.Shape) => void,
  depth: number,
  bevel = 0.018,
): THREE.BufferGeometry {
  return cached(`ext:${key}`, () => {
    const shape = new THREE.Shape();
    build(shape);
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: depth - bevel * 2,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 2,
      curveSegments: 8,
    });
    geometry.center();
    return geometry;
  });
}

export function material(color: number, surface: SurfaceName = "wood"): THREE.MeshStandardMaterial {
  const key = `${color}:${surface}`;
  let found = materials.get(key);
  if (!found) {
    found = new THREE.MeshStandardMaterial({ color, ...SURFACE[surface] });
    materials.set(key, found);
  }
  return found;
}

/** Double-sided variant, needed for open shells like lathed plates. */
export function shellMaterial(
  color: number,
  surface: SurfaceName = "ceramic",
): THREE.MeshStandardMaterial {
  const key = `${color}:${surface}:shell`;
  let found = materials.get(key);
  if (!found) {
    found = new THREE.MeshStandardMaterial({ color, ...SURFACE[surface], side: THREE.DoubleSide });
    materials.set(key, found);
  }
  return found;
}

export function mesh(
  geometry: THREE.BufferGeometry,
  color: number,
  surface: SurfaceName = "wood",
): THREE.Mesh {
  const object = new THREE.Mesh(geometry, material(color, surface));
  object.castShadow = true;
  object.receiveShadow = true;
  return object;
}
