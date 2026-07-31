/**
 * Where the camera stands, and therefore which way "up" is.
 *
 * The kitchen is drawn from one of its corners, so world axes and screen axes
 * are about 41 degrees apart. The camera and the input layer both read this,
 * because a control frame that disagrees with the picture sends chefs sideways:
 * pressing "up" used to walk you up and to the *right*, and the stick was just
 * as wrong.
 *
 * It lives outside both layers so neither owns it — `input/` must not import
 * the renderer, and the number is not the renderer's private business anyway.
 * Now that the camera turns, it is also the one place that *remembers* which
 * corner we are looking from: the renderer eases towards it, the input layer
 * rotates by it, and neither has to tell the other.
 */

/** Horizontal offset from the kitchen's centre to the camera, in world units. */
export const CAMERA_OFFSET = { x: 13, z: 15 } as const;

/** The camera's yaw around the kitchen when nobody has turned it, in radians. */
export const CAMERA_YAW = Math.atan2(CAMERA_OFFSET.x, CAMERA_OFFSET.z);

/**
 * The kitchen turns in quarter circles and nothing else.
 *
 * A free orbit would need the art to follow it continuously — the near-wall
 * lip, the appliance detailing, the doors on the ovens — and would leave the
 * controls at an angle no key can mean. Four corners keep every one of those
 * an exact case: "up" is always one of the four ways the room actually runs.
 */
const QUARTER = Math.PI / 2;

/** How many quarter turns from the default corner we are looking from. */
let turns = 0;

/** The yaw the camera is heading for, in radians. */
export function cameraYaw(): number {
  return CAMERA_YAW + turns * QUARTER;
}

/** Turn the kitchen. `steps` is quarter circles, positive or negative. */
export function rotateCamera(steps: number): void {
  turns += Math.round(steps);
}

/** Face the default corner again. For a new game, and for tests. */
export function resetCamera(): void {
  turns = 0;
}

/**
 * Rotate a stick or key vector from screen space into world space, in place.
 *
 * `y` goes in as the screen's vertical axis and comes out as the world's z.
 * Turning by the yaw alone — rather than by the full camera basis — is what
 * makes "up" run exactly up the screen: the camera's ground-forward direction
 * has no sideways component left to project, and the pitch only foreshortens
 * what is already vertical.
 *
 * Read from the *target* yaw rather than from wherever the camera has eased to,
 * so a turn changes the controls once, cleanly, rather than sweeping them
 * through every angle in between.
 */
export function screenToWorld(move: { x: number; y: number }): void {
  const yaw = cameraYaw();
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const x = move.x * cos + move.y * sin;
  const y = move.y * cos - move.x * sin;
  move.x = x;
  move.y = y;
}
