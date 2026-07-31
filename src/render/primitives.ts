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

/**
 * Everything this module has handed out, for `disposeSubtree` to *not* free.
 *
 * Shared resources are the reason the kitchen is a handful of GPU buffers
 * rather than hundreds, and they are also the reason naive teardown is
 * dangerous: disposing the box geometry when one counter is removed would blank
 * every other counter in the room. Ownership has to be answerable, so it is.
 *
 * A Set of the objects themselves rather than a flag on each: `dispose()` is
 * three.js's API and we are not going to be the ones deciding what a stray
 * `userData.cached` means.
 */
const owned = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();

/** Did this come from the shared cache? If so, nobody else may dispose it. */
export function isCached(resource: THREE.BufferGeometry | THREE.Material | THREE.Texture): boolean {
  return owned.has(resource);
}

function cached(key: string, create: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let geometry = geometries.get(key);
  if (!geometry) {
    geometry = create();
    geometries.set(key, geometry);
    owned.add(geometry);
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

/**
 * A capsule: a cylinder with hemispherical ends, `length` between the centres.
 *
 * The honest shape for anything hand-sized and held — limbs, grips, bottles,
 * rolling pins. A cylinder of the same size reads as cut pipe, because the one
 * thing real handles never have is a sharp circular edge at each end.
 */
export function capsule(radius: number, length: number, sides = 16): THREE.BufferGeometry {
  return cached(
    `cap:${radius},${length},${sides}`,
    () => new THREE.CapsuleGeometry(radius, length, 6, sides),
  );
}

/**
 * A cylinder whose top and bottom edges are filleted, standing on y=0.
 *
 * Rule 1 of the art style — everything is rounded — had no cylindrical form to
 * apply itself to: `roundedBox` bevels a box and `cylinder` leaves two hard
 * circular edges, which is why every leg, foot, rim and tin in the kitchen
 * ended its silhouette with a hairline. This is a lathe, so the fillet is real
 * geometry that catches the key light rather than a shading trick.
 */
export function roundedCylinder(
  radius: number,
  h: number,
  fillet = Math.min(radius, h / 2) * 0.25,
  sides = 24,
): THREE.BufferGeometry {
  const r = Math.min(fillet, radius - 0.001, h / 2 - 0.001);
  const points: [number, number][] = [[0, 0]];
  // Quarter arcs at each end, sampled coarsely: a fillet is a highlight, not a
  // feature, and four segments is where more stop being visible.
  for (let i = 0; i <= 4; i++) {
    const a = (i / 4) * (Math.PI / 2);
    points.push([radius - r + Math.sin(a) * r, r - Math.cos(a) * r]);
  }
  for (let i = 0; i <= 4; i++) {
    const a = (i / 4) * (Math.PI / 2);
    points.push([radius - r + Math.cos(a) * r, h - r + Math.sin(a) * r]);
  }
  points.push([0, h]);
  return lathe(`rcyl:${radius},${h},${r},${sides}`, points, sides);
}

/**
 * A tube swept along a smooth curve through `points`.
 *
 * The shape the kit had no way to make. Taps, kettle spouts, oven handles,
 * fryer baskets, cables, bag straps and awning scallops were all being
 * approximated by a cylinder plus a bent cylinder plus a sphere at the elbow —
 * three draw calls and a visible joint each. A sweep is one geometry and the
 * curve is the drawing: the points are read as a Catmull-Rom spline, so a
 * handle is the three or four places it passes through.
 */
export function sweep(
  key: string,
  points: [number, number, number][],
  radius: number,
  segments = 20,
  sides = 8,
): THREE.BufferGeometry {
  return cached(
    `swp:${key}`,
    () =>
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z))),
        segments,
        radius,
        sides,
        false,
      ),
  );
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

/**
 * Extruded 2D shape with a bevel; used for wedges and other flat-sided food.
 *
 * `build` may pierce the shape by pushing a `THREE.Path` onto `shape.holes`,
 * and the bevel follows the hole as it follows the outline — which is how a
 * slotted, fretted or handled panel gets made in one geometry instead of being
 * faked with four boxes around a gap.
 */
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
    owned.add(found);
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
    owned.add(found);
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
