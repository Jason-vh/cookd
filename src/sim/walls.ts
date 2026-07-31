import type { Rect, Seam, Vec2, Walls, World } from "./types";

/**
 * The walls, and the one question anybody asks of them: may I cross here?
 *
 * Walls sit on the seams between tiles, so they are never a thing a tile *is* —
 * every check is about a *step*, from one square to the neighbouring one. That
 * is the whole difference from the tile walls this replaced: `isSolid` could
 * answer for a square on its own, and this cannot, which is why pathing, the
 * seat search and movement all now say where they are coming from.
 */

export function createWalls(width: number, height: number): Walls {
  return {
    vertical: Array.from({ length: (width + 1) * height }, () => false),
    horizontal: Array.from({ length: width * (height + 1) }, () => false),
  };
}

/** The seam between tiles `(x-1,y)` and `(x,y)`. */
export function verticalWall(world: World, x: number, y: number): boolean {
  if (x < 0 || x > world.width || y < 0 || y >= world.height) return false;
  return world.walls.vertical[y * (world.width + 1) + x] ?? false;
}

/** The seam between tiles `(x,y-1)` and `(x,y)`. */
export function horizontalWall(world: World, x: number, y: number): boolean {
  if (x < 0 || x >= world.width || y < 0 || y > world.height) return false;
  return world.walls.horizontal[y * world.width + x] ?? false;
}

export function setVerticalWall(world: World, x: number, y: number, solid: boolean): void {
  if (x < 0 || x > world.width || y < 0 || y >= world.height) return;
  world.walls.vertical[y * (world.width + 1) + x] = solid;
}

export function setHorizontalWall(world: World, x: number, y: number, solid: boolean): void {
  if (x < 0 || x >= world.width || y < 0 || y > world.height) return;
  world.walls.horizontal[y * world.width + x] = solid;
}

/**
 * The one seam the shell does not have a wall on.
 *
 * Derived from the door tile rather than stated, because the two would then be
 * two facts that have to agree: a doorway is where it is *because* of the tile
 * behind it, and a room that named both could put the frame on one wall and the
 * tile customers queue for against another. Taken from the room and the tile so
 * that the level building the world and the renderer drawing its frame ask the
 * same function rather than two that look alike.
 */
export function doorSeam(room: Rect, door: Vec2): Seam {
  if (door.x === room.x) return { axis: "vertical", x: room.x, y: door.y };
  if (door.x === room.x + room.width - 1) {
    return { axis: "vertical", x: room.x + room.width, y: door.y };
  }
  if (door.y === room.y) return { axis: "horizontal", x: door.x, y: room.y };
  return { axis: "horizontal", x: door.x, y: room.y + room.height };
}

/**
 * Is there a wall between these two neighbouring tiles?
 *
 * Only ever asked of tiles that share an edge — a diagonal step is not a thing
 * anything in the simulation takes, and answering for one would mean deciding
 * which of the two corners it squeezes past.
 */
export function wallBetween(world: World, from: Vec2, to: Vec2): boolean {
  if (from.y === to.y) return verticalWall(world, Math.max(from.x, to.x), from.y);
  if (from.x === to.x) return horizontalWall(world, from.x, Math.max(from.y, to.y));
  return false;
}

/**
 * Can somebody standing on `from` touch `to`?
 *
 * The arm's-length version of `wallBetween`, and the reason it exists: a chef
 * facing a wall is facing *something*, and without this they could chop on a
 * board standing on the other side of it. Tile walls never needed the rule
 * because a wall was a tile, so the thing behind it was never the tile in
 * front.
 *
 * A **corner** counts as reachable if either way round it is clear, which is
 * the same rule the eye applies: an oven diagonally across an open doorway is
 * within reach, and one diagonally across a solid corner is not.
 */
export function canReach(world: World, from: Vec2, to: Vec2): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return true;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return true; // further than reach; not this rule's business
  if (dx === 0 || dy === 0) return !wallBetween(world, from, to);
  const viaX = { x: to.x, y: from.y };
  const viaY = { x: from.x, y: to.y };
  return (
    (!wallBetween(world, from, viaX) && !wallBetween(world, viaX, to)) ||
    (!wallBetween(world, from, viaY) && !wallBetween(world, viaY, to))
  );
}
