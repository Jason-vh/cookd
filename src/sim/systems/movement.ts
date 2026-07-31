import type { Inputs, Player, World } from "../types";
import { horizontalWall, verticalWall } from "../walls";
import { PLAYER_RADIUS, PLAYER_SPEED, isSolid } from "../world";

const DEADZONE = 0.18;

/**
 * Free movement on a tile-aligned grid: the player is a circle, every solid
 * tile is a unit AABB, and every wall is a line between two of them. Axes are
 * resolved separately so sliding along counters feels smooth (the
 * Overcooked/PlateUp feel).
 *
 * **Chefs do not collide with each other**, and that is a netcode decision
 * rather than a design one. Your own chef is simulated *now*; everybody else
 * is drawn on the playout clock, a broadcast and half a round trip in the
 * past. A shove resolved against a body that is not where we think it is is a
 * guess that is wrong every single frame, so pressing against a team-mate used
 * to drag your own chef around by their ping — half a tile of correction on a
 * 180ms link, a fifth of one on a perfect link (`latency.test.ts`).
 * Two chefs standing in the same spot is only a *looking* problem, and it is
 * solved where looking happens: `render/people-views.ts` slides the drawn
 * bodies apart.
 */
export function movementSystem(world: World, inputs: Inputs, dt: number): void {
  for (const player of world.players) {
    const input = inputs[player.id];
    player.prevPos.x = player.pos.x;
    player.prevPos.y = player.pos.y;
    if (!input) continue;

    let mx = input.move.x;
    let my = input.move.y;
    const mag = Math.hypot(mx, my);
    if (mag < DEADZONE) {
      mx = 0;
      my = 0;
    } else {
      if (mag > 1) {
        mx /= mag;
        my /= mag;
      }
      // Facing only updates while actually moving, so you keep aiming at an
      // appliance while standing still.
      const fl = Math.hypot(mx, my);
      player.facing.x = mx / fl;
      player.facing.y = my / fl;
    }

    // Carrying an appliance in the build phase slows you down.
    // Carrying an appliance does NOT slow you down. Design rule: friction is
    // only worth it when it creates a decision. A slower walk during the build
    // phase creates none — there is no clock and no competing pressure — so it
    // is pure delay between the player and the layout they already pictured.
    moveAxis(world, player, mx * PLAYER_SPEED * dt, 0);
    moveAxis(world, player, 0, my * PLAYER_SPEED * dt);
  }

  // Insurance: a save, a spawn or a shoved appliance could put someone out.
  for (const player of world.players) {
    player.pos.x = clamp(player.pos.x, PLAYER_RADIUS, world.width - PLAYER_RADIUS);
    player.pos.y = clamp(player.pos.y, PLAYER_RADIUS, world.height - PLAYER_RADIUS);
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Resolve one axis of motion against the tile grid.
 *
 * The player is treated as a square of half-extent PLAYER_RADIUS. Only the
 * leading edge on the axis of motion is tested, against the tiles the *other*
 * axis actually overlaps. The EPSILON shrink on the perpendicular axis is
 * essential: without it, floating-point results like `2.32 - 0.32 = 1.9999...`
 * make a player standing flush against a counter appear to overlap the tile
 * above it, and the resolution then teleports them sideways.
 *
 * Two things stop the leading edge, and they stop it in the same place: an
 * appliance standing in the square it has entered, and a **wall on the seam it
 * has just crossed**. The seam is the boundary of that same square — the one
 * behind the edge in the direction of travel — so a wall between `tx-1` and
 * `tx` and a counter standing on `tx` are both resolved to `tx - r`. That is
 * why walls needed no new resolution maths when they stopped being tiles: they
 * are the same line, with nothing behind it.
 */
const EPSILON = 1e-6;

function moveAxis(world: World, player: Player, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  player.pos.x += dx;
  player.pos.y += dy;

  const r = PLAYER_RADIUS;

  if (dx !== 0) {
    const tx = Math.floor(dx > 0 ? player.pos.x + r - EPSILON : player.pos.x - r + EPSILON);
    const seam = dx > 0 ? tx : tx + 1;
    const minY = Math.floor(player.pos.y - r + EPSILON);
    const maxY = Math.floor(player.pos.y + r - EPSILON);
    for (let ty = minY; ty <= maxY; ty++) {
      if (!isSolid(world, tx, ty) && !verticalWall(world, seam, ty)) continue;
      player.pos.x = dx > 0 ? tx - r : tx + 1 + r;
      return;
    }
    return;
  }

  const ty = Math.floor(dy > 0 ? player.pos.y + r - EPSILON : player.pos.y - r + EPSILON);
  const seam = dy > 0 ? ty : ty + 1;
  const minX = Math.floor(player.pos.x - r + EPSILON);
  const maxX = Math.floor(player.pos.x + r - EPSILON);
  for (let tx = minX; tx <= maxX; tx++) {
    if (!isSolid(world, tx, ty) && !horizontalWall(world, tx, seam)) continue;
    player.pos.y = dy > 0 ? ty - r : ty + 1 + r;
    return;
  }
}
