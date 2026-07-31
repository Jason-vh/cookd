import * as THREE from "three";
import { CAMERA_OFFSET, cameraYaw } from "../orientation";
import { LAYER } from "./layers";

/**
 * The kitchen camera: a 3/4 orthographic view that follows the local chefs.
 *
 * It used to frame the whole kitchen at once, which is correct and unreadable —
 * a 20x9 grid on a 16:9 screen leaves every chef about eighty pixels tall, and
 * the food they are carrying (the thing you are actually tracking) far smaller
 * than that. So the frustum is now sized to a *fixed world height* and slid to
 * keep the local players inside it.
 *
 * Three rules keep that from becoming a nuisance:
 *
 *  - **Couch co-op shares one camera.** Two local chefs at opposite ends of the
 *    kitchen cannot both be centred, so the view zooms out until it holds them
 *    both, up to the old whole-kitchen framing. Nobody is ever off-screen, and
 *    when the players are together you get the close view.
 *  - **It never pans off the diorama.** The view rect is clamped inside the
 *    kitchen's bounds, so the frame is always full of kitchen rather than
 *    drifting into empty park when somebody hugs a wall.
 *  - **It turns, a corner at a time.** Which corner is `orientation.ts`'s to
 *    say, because the controls have to turn with the picture; this eases there
 *    and keeps the same patch of floor in the middle while it does.
 *
 * Everything is computed in *camera space* by projecting world points through
 * the inverse camera matrix. That is what makes the whole thing orientation
 * agnostic: fitting, clamping and panning never mention world x/z, so the yaw
 * can move without touching any of the maths.
 */

/** Where the camera sits relative to the point it looks at. */
const ORBIT = {
  /** Horizontal distance from the pivot. */
  radius: Math.hypot(CAMERA_OFFSET.x, CAMERA_OFFSET.z),
  /** Height above the pivot, which fixes the pitch of the 3/4 angle. */
  height: 17,
  /** Chef eye-line-ish, so the kitchen sits in the middle of the frame. */
  pivotY: 0.4,
};

/**
 * How fast the kitchen turns, in e-folds per second.
 *
 * Quick enough that the room has arrived by the time you have looked at it,
 * slow enough to see *which way* it went — a snap leaves you re-reading a
 * kitchen you had memorised.
 */
const YAW_RATE = 9;

/** Close enough to the target angle to stop working at it. */
const YAW_SETTLED = 1e-4;

/**
 * Half the vertical size of the followed view, in world units.
 *
 * The whole-kitchen framing is ~10.25 by the same measure, so this is a little
 * over 2x zoom. It is the one number to turn if the game feels too near or too
 * far; everything else adapts to it.
 */
const FOLLOW_HALF_HEIGHT = 5.5;

/** Breathing room around the followed chefs, so nobody hugs the screen edge. */
const FOLLOW_PADDING = 2.6;

/** Breathing room around the kitchen when the whole thing is in frame. */
const BOUNDS_MARGIN = 2.2;

/** Torso height: following the feet makes the camera sit unhelpfully low. */
const TARGET_HEIGHT = 0.9;

/**
 * Easing rates, in "e-folds per second". The pan is quick enough to feel
 * attached to the chef; the zoom is deliberately slower, because a view size
 * that reacts as fast as the players separate and rejoin is nauseating.
 */
const PAN_RATE = 7;
const ZOOM_RATE = 3;

/** A rectangle in camera space: what the orthographic frustum is. */
type Rect = { minX: number; maxX: number; minY: number; maxY: number };

/** Scratch for the view direction, reused while the kitchen is turning. */
const FORWARD = new THREE.Vector3();

/** A point to keep in frame, in world space. */
export type FollowTarget = { x: number; z: number };

export class KitchenCamera {
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 120);

  private readonly bounds: THREE.Box3;
  private readonly pivot = new THREE.Vector3();
  /** World -> camera space. Rebuilt only when the camera itself moves. */
  private readonly toCamera = new THREE.Matrix4();
  /** The kitchen's bounds in camera space, plus margin: the panning limit. */
  private limit: Rect = { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  /**
   * Built already facing whichever corner the player last turned to, rather
   * than spinning there from the default: a new `View` (a different kitchen,
   * or going online) should look like the same room, not like a camera move.
   */
  private yaw = cameraYaw();
  /** Where the yaw is heading. See `setYaw`. */
  private wantedYaw = this.yaw;
  private aspect = 1;
  /** Smoothed frustum: centre and half-height in camera space. Null until the
   * first update, which snaps rather than easing in from nowhere. */
  private view: { x: number; y: number; halfH: number } | null = null;
  private readonly scratch = new THREE.Vector3();
  /**
   * The four corners of the ground currently in shot, rewritten in place every
   * update. Handed to the shadow camera, which has no other way of knowing that
   * a 22x11 kitchen is being viewed eleven metres at a time — see `daylight.ts`.
   */
  readonly footprint: readonly THREE.Vector3[] = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];

  /** @param bounds world-space box the camera must never show past. */
  constructor(bounds: THREE.Box3) {
    this.bounds = bounds;
    this.pivot.set(
      (bounds.min.x + bounds.max.x) / 2,
      ORBIT.pivotY,
      (bounds.min.z + bounds.max.z) / 2,
    );
    // The main camera sees everything; only the ambient-occlusion pass gets a
    // restricted view (see render/post.ts).
    this.camera.layers.enable(LAYER.UI);
    this.place();
  }

  /**
   * Turn the camera around the kitchen, easing there rather than cutting.
   *
   * Called every frame with whatever `orientation.ts` currently says, so it has
   * to be free when nothing has changed.
   */
  setYaw(yaw: number): void {
    this.wantedYaw = yaw;
  }

  /** The angle the kitchen is being drawn from right now. */
  get facing(): number {
    return this.yaw;
  }

  /** Ease the yaw towards its target, carrying the framing with it. */
  private turn(dt: number): void {
    const gap = this.wantedYaw - this.yaw;
    if (Math.abs(gap) < YAW_SETTLED) {
      if (gap !== 0) this.applyYaw(this.wantedYaw);
      return;
    }
    this.applyYaw(this.yaw + gap * ease(YAW_RATE, dt));
  }

  /**
   * Stand somewhere new, keeping the view pointed at the same patch of floor.
   *
   * Camera-space coordinates mean something different at every angle, so the
   * smoothed rect cannot simply be carried over — it would send the view
   * sliding across the kitchen. What *is* the same at both angles is the point
   * on the ground the frame is centred on, so that is what is carried across.
   */
  private applyYaw(yaw: number): void {
    const centre = this.view ? this.ground(this.view.x, this.view.y) : null;
    this.yaw = yaw;
    this.place();
    if (this.view && centre) {
      const moved = centre.applyMatrix4(this.toCamera);
      this.view.x = moved.x;
      this.view.y = moved.y;
    }
  }

  /**
   * Where a point in camera space meets the ground the chefs stand on.
   *
   * The frustum is orthographic, so every camera-space point is a ray along the
   * view direction; `TARGET_HEIGHT` is the plane the follow targets live on,
   * which makes it the honest answer to "what is the middle of the frame".
   */
  private ground(x: number, y: number): THREE.Vector3 {
    const point = this.scratch.set(x, y, 0).applyMatrix4(this.camera.matrixWorld);
    const forward = FORWARD.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const travel = (TARGET_HEIGHT - point.y) / forward.y;
    return point.addScaledVector(forward, travel);
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
  }

  /**
   * Frame `targets`, easing from wherever the view was. With no targets — the
   * join screen, or a spectator — it falls back to the whole kitchen.
   */
  update(targets: readonly FollowTarget[], dt: number): void {
    this.turn(dt);
    const wanted = this.fit(targets.length ? this.project(targets) : this.limit);

    if (!this.view) this.view = wanted;
    else {
      this.view.x += (wanted.x - this.view.x) * ease(PAN_RATE, dt);
      this.view.y += (wanted.y - this.view.y) * ease(PAN_RATE, dt);
      this.view.halfH += (wanted.halfH - this.view.halfH) * ease(ZOOM_RATE, dt);
    }

    // Clamped *after* easing, not before: the eased half-height decides how far
    // the centre may travel, so a view still zooming out would otherwise be
    // allowed to overshoot the kitchen for a few frames.
    const halfH = this.view.halfH;
    const halfW = halfH * this.aspect;
    const x = clampSpan(this.view.x, halfW, this.limit.minX, this.limit.maxX);
    const y = clampSpan(this.view.y, halfH, this.limit.minY, this.limit.maxY);

    this.camera.left = x - halfW;
    this.camera.right = x + halfW;
    this.camera.top = y + halfH;
    this.camera.bottom = y - halfH;
    this.camera.updateProjectionMatrix();

    // Where those four frustum corners land on the floor. Cheap, and only the
    // shadows read it — but they read it every frame, so it is written into the
    // vectors it already owns.
    for (let i = 0; i < 4; i++) {
      this.footprint[i]!.copy(
        this.ground(i & 1 ? x + halfW : x - halfW, i & 2 ? y + halfH : y - halfH),
      );
    }
  }

  /** Position the camera on its orbit and cache what depends on where it is. */
  private place(): void {
    this.camera.position.set(
      this.pivot.x + Math.sin(this.yaw) * ORBIT.radius,
      this.pivot.y + ORBIT.height,
      this.pivot.z + Math.cos(this.yaw) * ORBIT.radius,
    );
    this.camera.lookAt(this.pivot);
    this.camera.updateMatrixWorld();
    this.toCamera.copy(this.camera.matrixWorld).invert();

    // The kitchen's eight bounding-box corners, projected. Doing it this way
    // (rather than a hand-tuned view size) keeps the framing correct for any
    // kitchen shape and any camera angle.
    const corner = new THREE.Vector3();
    const box: Rect = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (let i = 0; i < 8; i++) {
      corner
        .set(
          i & 1 ? this.bounds.max.x : this.bounds.min.x,
          i & 2 ? this.bounds.max.y : this.bounds.min.y,
          i & 4 ? this.bounds.max.z : this.bounds.min.z,
        )
        .applyMatrix4(this.toCamera);
      grow(box, corner.x, corner.y);
    }
    this.limit = {
      minX: box.minX - BOUNDS_MARGIN,
      maxX: box.maxX + BOUNDS_MARGIN,
      minY: box.minY - BOUNDS_MARGIN,
      maxY: box.maxY + BOUNDS_MARGIN,
    };
  }

  /** Bounding rect of the follow targets, in camera space. */
  private project(targets: readonly FollowTarget[]): Rect {
    const box: Rect = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const target of targets) {
      this.scratch.set(target.x, TARGET_HEIGHT, target.z).applyMatrix4(this.toCamera);
      grow(box, this.scratch.x, this.scratch.y);
    }
    return box;
  }

  /**
   * Size a frustum around `box`: never tighter than the follow zoom, never
   * wider than the whole kitchen, and always the right shape for the window.
   */
  private fit(box: Rect): { x: number; y: number; halfH: number } {
    const needed = Math.max(
      (box.maxY - box.minY) / 2 + FOLLOW_PADDING,
      ((box.maxX - box.minX) / 2 + FOLLOW_PADDING) / this.aspect,
    );
    const widest = Math.max(
      (this.limit.maxY - this.limit.minY) / 2,
      (this.limit.maxX - this.limit.minX) / 2 / this.aspect,
    );
    return {
      x: (box.minX + box.maxX) / 2,
      y: (box.minY + box.maxY) / 2,
      halfH: Math.min(Math.max(FOLLOW_HALF_HEIGHT, needed), widest),
    };
  }
}

/** Frame-rate independent easing: the fraction to move this frame. */
function ease(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/**
 * Keep a span of `half` either side of `centre` inside [`min`, `max`], or
 * centre it when it simply does not fit.
 */
function clampSpan(centre: number, half: number, min: number, max: number): number {
  if (half * 2 >= max - min) return (min + max) / 2;
  return Math.min(Math.max(centre, min + half), max - half);
}

function grow(box: Rect, x: number, y: number): void {
  box.minX = Math.min(box.minX, x);
  box.maxX = Math.max(box.maxX, x);
  box.minY = Math.min(box.minY, y);
  box.maxY = Math.max(box.maxY, y);
}
