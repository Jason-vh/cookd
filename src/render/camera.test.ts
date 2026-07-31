import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { screenToWorld } from "../orientation";
import { KitchenCamera } from "./camera";

/** The Park Kitchen's bounds, as `View` builds them for a 20x9 grid. */
function rig(aspect = 16 / 9): KitchenCamera {
  const camera = new KitchenCamera(
    new THREE.Box3(new THREE.Vector3(-0.4, -1.4, -0.4), new THREE.Vector3(20.4, 2.0, 9.4)),
  );
  camera.setAspect(aspect);
  return camera;
}

/** Settle the easing, so a test asserts the framing and not the transition. */
function settle(camera: KitchenCamera, targets: { x: number; z: number }[]): void {
  for (let i = 0; i < 240; i++) camera.update(targets, 1 / 60);
}

/** Where a world direction goes on screen, in camera space. */
function project(camera: KitchenCamera, x: number, z: number): { x: number; y: number } {
  const toCamera = camera.camera.matrixWorld.clone().invert();
  const from = new THREE.Vector3(0, 0, 0).applyMatrix4(toCamera);
  const to = new THREE.Vector3(x, 0, z).applyMatrix4(toCamera);
  return { x: to.x - from.x, y: to.y - from.y };
}

const width = (camera: KitchenCamera) => camera.camera.right - camera.camera.left;
const height = (camera: KitchenCamera) => camera.camera.top - camera.camera.bottom;

describe("KitchenCamera", () => {
  test("follows a lone chef closer than the whole-kitchen framing", () => {
    const followed = rig();
    settle(followed, [{ x: 10, z: 4 }]);

    const whole = rig();
    settle(whole, []);

    expect(height(followed)).toBeLessThan(height(whole) * 0.6);
  });

  test("keeps the window's aspect ratio", () => {
    const camera = rig(16 / 9);
    settle(camera, [{ x: 10, z: 4 }]);
    expect(width(camera) / height(camera)).toBeCloseTo(16 / 9, 5);
  });

  test("zooms out to hold two local chefs at opposite ends", () => {
    const together = rig();
    settle(together, [
      { x: 10, z: 4 },
      { x: 10.5, z: 4.5 },
    ]);

    const apart = rig();
    settle(apart, [
      { x: 1, z: 1 },
      { x: 19, z: 8 },
    ]);

    expect(height(apart)).toBeGreaterThan(height(together));
  });

  test("never zooms out past the whole kitchen", () => {
    const spread = rig();
    settle(spread, [
      { x: -50, z: -50 },
      { x: 70, z: 60 },
    ]);

    const whole = rig();
    settle(whole, []);

    expect(height(spread)).toBeCloseTo(height(whole), 5);
  });

  test("stays over the kitchen when a chef hugs a wall", () => {
    const corner = rig();
    settle(corner, [{ x: 1, z: 1 }]);

    const whole = rig();
    settle(whole, []);

    // The followed frame is smaller, so it must sit strictly inside the frame
    // that holds the entire kitchen: no panning into empty park.
    expect(corner.camera.left).toBeGreaterThanOrEqual(whole.camera.left - 1e-6);
    expect(corner.camera.right).toBeLessThanOrEqual(whole.camera.right + 1e-6);
    expect(corner.camera.bottom).toBeGreaterThanOrEqual(whole.camera.bottom - 1e-6);
    expect(corner.camera.top).toBeLessThanOrEqual(whole.camera.top + 1e-6);
  });

  test("eases towards a chef rather than snapping to them", () => {
    // Both targets sit well inside the kitchen, where the view is free to pan
    // and the clamp is not the thing being measured.
    const camera = rig();
    settle(camera, [{ x: 9, z: 4 }]);
    const start = camera.camera.left;

    camera.update([{ x: 12, z: 4 }], 1 / 60);
    const stepped = camera.camera.left;
    settle(camera, [{ x: 12, z: 4 }]);

    expect(stepped).not.toBe(start);
    expect(Math.abs(stepped - start)).toBeLessThan(Math.abs(camera.camera.left - start) / 2);
  });

  test("yaw re-frames the kitchen without leaving its bounds", () => {
    const turned = rig();
    turned.setYaw(Math.PI / 3);
    settle(turned, [{ x: 10, z: 4 }]);

    const whole = rig();
    whole.setYaw(Math.PI / 3);
    settle(whole, []);

    expect(height(turned)).toBeLessThan(height(whole));
    expect(turned.camera.left).toBeGreaterThanOrEqual(whole.camera.left - 1e-6);
    expect(turned.camera.right).toBeLessThanOrEqual(whole.camera.right + 1e-6);
  });
});

/**
 * The other half of the fix in `orientation.ts`, and the only place it can be
 * proved: rotating the controls is only correct if the world direction that
 * comes out actually points up the screen. Projecting through the real camera
 * says so; the input layer's own test cannot.
 */
describe("screen-relative controls", () => {
  test("pressing up runs straight up the screen", () => {
    const move = { x: 0, y: -1 };
    screenToWorld(move);
    const screen = project(rig(), move.x, move.y);

    expect(screen.x).toBeCloseTo(0, 6);
    expect(screen.y).toBeGreaterThan(0);
  });

  test("pressing right runs across the screen, and does not rise or fall", () => {
    const move = { x: 1, y: 0 };
    screenToWorld(move);
    const screen = project(rig(), move.x, move.y);

    expect(screen.y).toBeCloseTo(0, 6);
    expect(screen.x).toBeGreaterThan(0);
  });

  test("the un-rotated control frame is the bug this replaced", () => {
    // Raw world -z, which is what "up" used to mean: up and to the right.
    const screen = project(rig(), 0, -1);

    expect(screen.x).toBeGreaterThan(0.5);
  });
});
