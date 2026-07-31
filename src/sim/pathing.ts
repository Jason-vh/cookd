import type { Vec2, World } from "./types";
import { wallBetween } from "./walls";
import { inBounds, isSolid, tileIndex } from "./world";

/**
 * Grid pathfinding for customers, and the reachability check the build phase
 * uses to warn about a walled-off dining room.
 *
 * Both are the same breadth-first flood fill over steps somebody could take,
 * which is why they live together: the rule that decides where a customer *can*
 * go and the warning that tells a player they have blocked it must never
 * disagree.
 *
 * A **step**, not a tile: walls live on the seams between squares, so "can I be
 * there" and "can I get there from here" are different questions and only the
 * second one is the one worth asking.
 *
 * BFS rather than A*: the grid is a couple of hundred tiles and a search costs
 * microseconds. A* would be faster per search and a great deal more code to be
 * wrong in.
 *
 * A path is computed once, when a customer sets off, and then walked without
 * rechecking. That is safe because **appliances only move during the build
 * phase** — nothing can appear in front of a walking customer mid-service.
 */

/** Every tile reachable from `origin`, as a set of tile indices. */
export function reachableFrom(world: World, origin: Vec2): Set<number> {
  const seen = new Set<number>();
  if (!inBounds(world, origin.x, origin.y) || isSolid(world, origin.x, origin.y)) return seen;

  const queue: Vec2[] = [{ x: origin.x, y: origin.y }];
  seen.add(tileIndex(world, origin.x, origin.y));
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    for (const step of NEIGHBOURS) {
      const x = at.x + step.x;
      const y = at.y + step.y;
      if (!canStep(world, at, x, y)) continue;
      const index = tileIndex(world, x, y);
      if (seen.has(index)) continue;
      seen.add(index);
      queue.push({ x, y });
    }
  }
  return seen;
}

/**
 * Shortest tile path from `from` to `to`, exclusive of `from` and inclusive of
 * `to`, or null when there is no way through.
 *
 * Four-way movement only: a diagonal step between two solid tiles would have a
 * customer clip the corner of a counter, and the dining room is not tight
 * enough for the extra smoothness to be worth that.
 */
export function pathTo(world: World, from: Vec2, to: Vec2): Vec2[] | null {
  const start = tileIndex(world, from.x, from.y);
  const goal = tileIndex(world, to.x, to.y);
  if (!inBounds(world, to.x, to.y) || isSolid(world, to.x, to.y)) return null;
  if (start === goal) return [];

  const cameFrom = new Map<number, number>();
  const queue: Vec2[] = [{ x: from.x, y: from.y }];
  cameFrom.set(start, -1);

  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    for (const step of NEIGHBOURS) {
      const x = at.x + step.x;
      const y = at.y + step.y;
      if (!canStep(world, at, x, y)) continue;
      const index = tileIndex(world, x, y);
      if (cameFrom.has(index)) continue;
      cameFrom.set(index, tileIndex(world, at.x, at.y));
      if (index === goal) return unwind(world, cameFrom, goal);
      queue.push({ x, y });
    }
  }
  return null;
}

function unwind(world: World, cameFrom: Map<number, number>, goal: number): Vec2[] {
  const path: Vec2[] = [];
  let at = goal;
  while (at !== -1) {
    path.push({ x: at % world.width, y: Math.floor(at / world.width) });
    at = cameFrom.get(at) ?? -1;
  }
  path.pop(); // the tile we are already standing on
  return path.reverse();
}

/**
 * Walkable tiles beside an appliance — the chairs somebody could sit in.
 *
 * Always built in the same order, which matters even though the choice between
 * them is random: the caller picks with `random(world)`, and a shuffled
 * candidate list would make that pick depend on iteration order rather than on
 * the seeded stream. Two clients disagreeing about which chair is taken would
 * show one player a customer sitting where another sees an empty seat.
 */
export function seatsAround(world: World, tile: Vec2): Vec2[] {
  const seats: Vec2[] = [];
  for (const step of NEIGHBOURS) {
    const x = tile.x + step.x;
    const y = tile.y + step.y;
    // The wall check is what stops a counter against the shell being "reachable"
    // from the patio on the other side of it, which is a chair nobody can sit
    // in and a warning the build phase would never give.
    if (!canStep(world, tile, x, y)) continue;
    seats.push({ x, y });
  }
  return seats;
}

/** May somebody standing on `from` walk onto `(x,y)`? */
function canStep(world: World, from: Vec2, x: number, y: number): boolean {
  if (!inBounds(world, x, y) || isSolid(world, x, y)) return false;
  return !wallBetween(world, from, { x, y });
}

const NEIGHBOURS: Vec2[] = [
  { x: 0, y: -1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
];
