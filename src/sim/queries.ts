import { applianceDef } from "../data/appliances";
import { ingredient } from "../data/ingredients";
import { isDirty } from "./items";
import { reachableFrom, seatsAround } from "./pathing";
import { EAT_TIME, LAST_ORDERS } from "./systems/customers";
import type { Appliance, Customer, Item, Player, World } from "./types";
import { applianceAtTile, inBounds, tileIndex } from "./world";

/**
 * Read-only questions about the world.
 *
 * These used to live in `sim/systems/`, which is where the *tick* functions
 * live — the ones whose job is mutating the world in `step()`. They ended up
 * there because that is where they were first needed, and the result was that
 * the render layer imported six things from four system modules, which reads
 * like a layering violation and is not one.
 *
 * It is worth being precise about why the sharing is right, because the obvious
 * "fix" is worse. `canPlace` is used by the placement rule *and* by the ghost
 * that previews it, deliberately, so the preview and the rule cannot disagree.
 * Copying the answer into a per-frame view-model would re-create exactly the
 * class of bug that sharing prevents — which is what happened when the render
 * layer computed `customer.timer / EAT_TIME` for itself, and would have stopped
 * emptying plates the day that timer changed meaning.
 *
 * So: `sim/systems/*` are things that happen, and this file is things that are
 * true. The render layer reads the second and never the first.
 */

/** How far in front of a player we look for something to interact with. */
const REACH = 0.75;

/** The tile a player is pointing at — the white square in front of the chef. */
export function targetTile(player: Player): { x: number; y: number } {
  return {
    x: Math.floor(player.pos.x + player.facing.x * REACH),
    y: Math.floor(player.pos.y + player.facing.y * REACH),
  };
}

export function targetAppliance(world: World, player: Player): Appliance | null {
  const tile = targetTile(player);
  return applianceAtTile(world, tile.x, tile.y);
}

/**
 * Can a carried appliance be set down here?
 *
 * Shared with the render layer so the placement ghost and the rule that governs
 * it can never disagree.
 */
export function canPlace(world: World, tx: number, ty: number): boolean {
  if (!inBounds(world, tx, ty)) return false;
  const index = tileIndex(world, tx, ty);
  if (world.tiles[index]?.wall) return false;
  const existing = applianceAtTile(world, tx, ty);
  return !existing || applianceDef(existing.kind).movable;
}

/** The customer sitting at this table and waiting to be fed, if there is one. */
export function customerAt(world: World, table: Appliance): Customer | null {
  return (
    world.customers.find(
      (customer) => customer.table === table.id && customer.state === "ordering",
    ) ?? null
  );
}

/** Tables a customer cannot actually reach. Used by the build phase to warn. */
export function unreachableTables(world: World): Appliance[] {
  const reachable = reachableFrom(world, world.door);
  const stranded: Appliance[] = [];
  for (const appliance of world.appliances.values()) {
    if (appliance.kind !== "table") continue;
    const seats = seatsAround(world, appliance.tile).filter((seat) =>
      reachable.has(tileIndex(world, seat.x, seat.y)),
    );
    if (seats.length === 0) stranded.push(appliance);
  }
  return stranded;
}

/**
 * How much of the meal on this table is left, 1..0.
 *
 * A function rather than an exported `EAT_TIME`, because the render layer wants
 * the *fraction* and was computing `customer.timer / EAT_TIME` itself — one
 * module's arithmetic in another module's file. `timer` is reused by four
 * states with four meanings, so the day eating stopped counting down from
 * EAT_TIME the plates would silently have stopped emptying.
 */
export function mealLeft(customer: Customer): number {
  if (customer.state !== "eating") return 1;
  return Math.max(0, Math.min(1, customer.timer / EAT_TIME));
}

/**
 * Has the kitchen stopped taking new customers?
 *
 * The HUD used to import `LAST_ORDERS` and do the comparison itself. The number
 * is the customer system's business; whether it currently applies is a question
 * about the world.
 */
export function isLastOrders(world: World): boolean {
  return world.phase === "service" && world.dayTime <= LAST_ORDERS;
}

/** Display name for the HUD, e.g. "Chopped Tomato" or "Plate: Pizza". */
export function itemLabel(item: Item): string {
  const base = ingredient(item.base).name;
  if (item.base === "plate") {
    if (isDirty(item)) return "Dirty plate";
    return item.contents.length ? `Plate: ${itemLabel(item.contents[0]!)}` : "Plate";
  }
  if (item.processes.length === 0) return base;
  if (item.processes.includes("burnt")) return `Burnt ${base}`;
  return `${base} (${item.processes.join(", ")})`;
}
