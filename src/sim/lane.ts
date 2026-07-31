import type { Appliance, Customer, Vec2, World } from "./types";

/**
 * The drive-through: a hatch in the wall, and a lane of cars coming to it.
 *
 * Everything here is **arithmetic**, and that is a decision rather than a
 * shortcut. Cars are ghosts to each other exactly as diners are, so where the
 * third car in the lane stands is `the hatch, three steps back` and nothing else —
 * the same trick the [line at the door](../../docs/dining-room.md) plays, and
 * it needs no flood fill, no lane graph and no path that can go stale.
 *
 * It works because `validate.ts` insists the lane is **straight** and runs
 * through the tile outside the hatch. A bending lane would want the pathfinder
 * and would buy nothing: a drive-through is a queue, and a queue is a line.
 *
 * Read by the simulation and by the renderer, which is why it is here rather
 * than in the customer system: where the lane is, is a thing that is *true*,
 * not a thing that *happens*.
 */

/** How many cars will queue before the road stops sending them. */
export const LANE_QUEUE = 4;

/** Tiles per second. A car is not in the same hurry a chef is, but it drives. */
export const CAR_SPEED = 4.6;

/** How far past either end of the lane a car appears from and vanishes to. */
export const OFF_ROAD = 4;

/** The serving hatch, or null in a kitchen that has a dining room instead. */
export function hatchOf(world: World): Appliance | null {
  if (!world.lane) return null;
  for (const appliance of world.appliances.values()) {
    if (appliance.kind === "hatch") return appliance;
  }
  return null;
}

/**
 * The patio tile a car is served at: outside the hatch, on the lane.
 *
 * Derived from where the hatch stands rather than stored, because the hatch is
 * immovable furniture of the level and "the tile in front of it" is a fact
 * about the building.
 */
export function servingSpot(world: World): Vec2 | null {
  const hatch = hatchOf(world);
  if (!hatch || !world.lane) return null;
  const step = laneStep(world);
  return { x: hatch.tile.x + step.x, y: hatch.tile.y + step.y };
}

/**
 * One tile from the hatch out onto the lane: the way a car faces the hatch.
 *
 * The lane is straight and the hatch is on the shell, so the axis the lane does
 * *not* run along is the one that crosses the wall.
 */
function laneStep(world: World): Vec2 {
  const lane = world.lane;
  const hatch = hatchOf(world);
  if (!lane || !hatch) return { x: 0, y: 0 };
  if (lane.entry.y === lane.exit.y) return { x: 0, y: Math.sign(lane.entry.y - hatch.tile.y) };
  return { x: Math.sign(lane.entry.x - hatch.tile.x), y: 0 };
}

/** One tile further back down the lane: the direction cars come from. */
export function backStep(world: World): Vec2 {
  const lane = world.lane;
  if (!lane) return { x: 0, y: 0 };
  return { x: Math.sign(lane.entry.x - lane.exit.x), y: Math.sign(lane.entry.y - lane.exit.y) };
}

/**
 * Where the `rank`-th car in the lane stops, in tile centres.
 *
 * Rank 0 is at the hatch. Everybody else is that many tiles further back down
 * the road, which is what makes the queue serial: the car being served is
 * standing between every car behind it and the hatch.
 */
export function laneSpot(world: World, rank: number): Vec2 {
  const spot = servingSpot(world) ?? { x: 0, y: 0 };
  const back = backStep(world);
  return { x: spot.x + back.x * rank + 0.5, y: spot.y + back.y * rank + 0.5 };
}

/** Where a car appears from, and where it drives off to. */
export function laneEnds(world: World): { in: Vec2; out: Vec2 } {
  const lane = world.lane;
  const back = backStep(world);
  if (!lane) return { in: { x: 0, y: 0 }, out: { x: 0, y: 0 } };
  return {
    in: { x: lane.entry.x + back.x * OFF_ROAD + 0.5, y: lane.entry.y + back.y * OFF_ROAD + 0.5 },
    out: { x: lane.exit.x - back.x * OFF_ROAD + 0.5, y: lane.exit.y - back.y * OFF_ROAD + 0.5 },
  };
}

/**
 * The cars in the lane, front first.
 *
 * Arrival order is list order — customers are only ever appended — so the
 * queue needs no state of its own, and a car's rank is its index here. The
 * ones driving away are not in it: they have stopped being a queue the moment
 * they stop being served.
 */
export function laneCars(world: World): Customer[] {
  return world.customers.filter((car) => car.state !== "leaving");
}
