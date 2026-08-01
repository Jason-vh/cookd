import type { Appliance, World } from "../sim/types";
import type { LevelDef } from "./level";
import { pathTo, seatsAround } from "../sim/pathing";
import { createWorld } from "../sim/world";

/**
 * How much walking a kitchen costs, in steps.
 *
 * `data/validate.ts` answers whether a kitchen *works* — everything reachable,
 * a sign to open the day, plates enough for the tables. It says nothing about
 * whether the room is any good, and it should not: a badly laid out kitchen is
 * a thing a player is allowed to build, and the morning is when they fix it.
 *
 * That tolerance stops applying the moment nobody chose the layout. So a
 * [generated kitchen](./generate.ts) is measured instead, against the two
 * hand-drawn ones as the reference, and this is the ruler. It lives here rather
 * than in the test that asserts on it because the [preview](../ui/kitchens.ts)
 * prints the same numbers, and a ruler kept in two places is two rulers.
 *
 * Measured **seat to seat**, the way a chef actually goes: an appliance is
 * solid, so the walk is between the squares you can stand on to use them.
 */
export type Walks = {
  /** Crate to chopping board. Walked for every ingredient of every dish. */
  gather: number;
  /** Board to the plate stack. */
  plate: number;
  /** Plate stack to the furthest table. */
  serve: number;
  /** The furthest table back to the sink. */
  bus: number;
  /** Sink to the plate stack: washing up, then putting away. */
  away: number;
  /** The whole loop, once, at its worst. */
  total: number;
};

export function kitchenWalks(level: LevelDef): Walks {
  const world = createWorld(level, 0);
  const board = of(world, "board")[0];
  const plates = of(world, "plates")[0];
  const sink = of(world, "sink")[0];
  const tables = of(world, "table");
  const crates = of(world, "crate");
  // A drive-through has no tables and a kitchen mid-edit may have no board.
  // Nothing here is load-bearing enough to throw over.
  if (!board || !plates || !sink || tables.length === 0 || crates.length === 0) {
    return { gather: 0, plate: 0, serve: 0, bus: 0, away: 0, total: 0 };
  }

  const gather = Math.max(...crates.map((crate) => walk(world, crate, board)));
  const plate = walk(world, board, plates);
  const serve = Math.max(...tables.map((table) => walk(world, plates, table)));
  const bus = Math.max(...tables.map((table) => walk(world, table, sink)));
  const away = walk(world, sink, plates);
  return { gather, plate, serve, bus, away, total: gather + plate + serve + bus + away };
}

/** The shortest walk between two appliances, standing beside each in turn. */
function walk(world: World, from: Appliance, to: Appliance): number {
  let best = Infinity;
  for (const here of seatsAround(world, from.tile)) {
    for (const there of seatsAround(world, to.tile)) {
      const path = pathTo(world, here, there);
      if (path) best = Math.min(best, path.length);
    }
  }
  return best;
}

function of(world: World, kind: string): Appliance[] {
  return [...world.appliances.values()].filter((appliance) => appliance.kind === kind);
}
