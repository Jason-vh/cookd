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
 */

/** Horizontal offset from the kitchen's centre to the camera, in world units. */
export const CAMERA_OFFSET = { x: 13, z: 15 } as const;

/** The camera's yaw around the kitchen, in radians. */
export const CAMERA_YAW = Math.atan2(CAMERA_OFFSET.x, CAMERA_OFFSET.z);

/**
 * Rotate a stick or key vector from screen space into world space, in place.
 *
 * `y` goes in as the screen's vertical axis and comes out as the world's z.
 * Turning by the yaw alone — rather than by the full camera basis — is what
 * makes "up" run exactly up the screen: the camera's ground-forward direction
 * has no sideways component left to project, and the pitch only foreshortens
 * what is already vertical.
 */
export function screenToWorld(move: { x: number; y: number }): void {
  const sin = Math.sin(CAMERA_YAW);
  const cos = Math.cos(CAMERA_YAW);
  const x = move.x * cos + move.y * sin;
  const y = move.y * cos - move.x * sin;
  move.x = x;
  move.y = y;
}
