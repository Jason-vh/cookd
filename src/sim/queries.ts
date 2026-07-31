import { applianceDef, type ApplianceKind } from "../data/appliances";
import { ingredient } from "../data/ingredients";
import { COMBINES, TRANSFORMS } from "../data/recipes";
import { unlockedRecipes } from "./cards";
import { isDirty, isPlate, specKey } from "./items";
import { plateCount } from "./plates";
import { reachableFrom, seatsAround } from "./pathing";
import { customerSpeed, eatTime, LAST_ORDERS } from "./systems/customers";
import type { Appliance, Customer, Item, Player, Station, Vec2, World } from "./types";
import { canReach } from "./walls";
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
export function targetTile(player: Player): Vec2 {
  return {
    x: Math.floor(player.pos.x + player.facing.x * REACH),
    y: Math.floor(player.pos.y + player.facing.y * REACH),
  };
}

/**
 * The tile a player is pointing at *and can touch*, or null for neither.
 *
 * The two came apart when walls moved onto the seams: the square in front of a
 * chef standing against the shell is out on the patio, and reaching an oven
 * through the back wall of the kitchen is not a thing arms do. Every rule that
 * acts on what is faced goes through here; `targetTile` stays as it was, for
 * the highlight and the placement ghost, which want to know where the square
 * *is* before deciding whether to draw it.
 */
export function reachedTile(world: World, player: Player): Vec2 | null {
  const tile = targetTile(player);
  const from = { x: Math.floor(player.pos.x), y: Math.floor(player.pos.y) };
  return canReach(world, from, tile) ? tile : null;
}

export function targetAppliance(world: World, player: Player): Appliance | null {
  const tile = reachedTile(world, player);
  return tile ? applianceAtTile(world, tile.x, tile.y) : null;
}

/**
 * Can a carried appliance be set down here?
 *
 * Shared with the render layer so the placement ghost and the rule that governs
 * it can never disagree.
 *
 * Asks the *tile* whether it is placeable rather than asking whether it is a
 * wall. That is what keeps the patio ring out of the kitchen without
 * `canPlace` growing a concept of "outside": the ring is walkable and it is not
 * placeable, and those are two independent facts about a tile. Outdoor seating,
 * if it ever happens, is some tiles changing their minds about the second one.
 */
export function canPlace(world: World, tx: number, ty: number): boolean {
  if (!inBounds(world, tx, ty)) return false;
  const index = tileIndex(world, tx, ty);
  if (!world.tiles[index]?.placeable) return false;
  const existing = applianceAtTile(world, tx, ty);
  return !existing || applianceDef(existing.kind).movable;
}

/**
 * Everybody sitting at this table and still waiting to be fed.
 *
 * Plural since parties: one table can be three orders, and "the customer here"
 * stopped being a question with one answer. Which of them a plate is for is a
 * rule rather than a query — see `serveTable`.
 */
export function customersAt(world: World, table: Appliance): Customer[] {
  return world.customers.filter(
    (customer) => customer.table === table.id && customer.state === "ordering",
  );
}

/**
 * Everything this kitchen could actually produce, as a set of spec keys.
 *
 * A fixed point over the content: start from what the crates dispense, then
 * keep applying every transform whose station is standing somewhere and every
 * combine whose two halves are already reachable, until nothing new appears.
 *
 * Derived rather than listed, for the same reason `RAW_INGREDIENTS` is. "Which
 * appliances does a pizza need" is a fact about the recipes, and any hand-kept
 * copy of it is a second opinion that goes stale the day somebody adds a dish.
 */
function makeableHere(world: World): Set<string> {
  const stations = new Set<Station>();
  const have = new Set<string>();
  for (const appliance of world.appliances.values()) {
    for (const station of applianceDef(appliance.kind).stations) stations.add(station);
    if (appliance.source) have.add(specKey(appliance.source));
  }

  // Bounded by construction: a pass only repeats if it *added* a key, and the
  // content names finitely many.
  //
  // `learn` exists because the obvious spelling of it does not work. `if
  // (!have.add(key)) continue;` reads like a set insertion reporting whether it
  // was new — `Set.add` returns the **set**, which is always truthy, so the
  // guard never fired, `grew` was never cleared, and this loop ran until the
  // process was killed. It hung every test that opens a day.
  const learn = (key: string): boolean => {
    if (have.has(key)) return false;
    have.add(key);
    return true;
  };

  for (let grew = true; grew;) {
    grew = false;
    for (const transform of TRANSFORMS) {
      if (!stations.has(transform.station)) continue;
      if (!have.has(specKey(transform.input))) continue;
      if (learn(specKey(transform.output))) grew = true;
    }
    for (const combine of COMBINES) {
      if (!have.has(specKey(combine.a)) || !have.has(specKey(combine.b))) continue;
      if (learn(specKey(combine.output))) grew = true;
    }
  }
  return have;
}

/** How many of a kind are standing in this kitchen, held ones included. */
function countKind(world: World, kind: ApplianceKind): number {
  let count = 0;
  for (const appliance of world.appliances.values()) {
    if (appliance.kind === kind) count++;
  }
  return count;
}

/**
 * What is wrong with this kitchen, in words, or nothing at all.
 *
 * **Said out loud, never prevented.** That is the house rule, and it predates
 * this function: a dining room walled off from the door has always been
 * reported at day open rather than made impossible, because the build phase's
 * promise is that you may rearrange your own restaurant into something silly.
 * The stall widened the ways to do it — you can now sell your last table, your
 * last crate, or every surface capable of holding a knife — and each of those
 * is the same sentence, so they get the same treatment rather than a growing
 * list of things the shop refuses to buy.
 *
 * The menu warnings are the ones that earn their place. Customers order from
 * what the *room* has unlocked, not from what the kitchen can cook, so a room
 * that has sold the oven a card gave it takes pizza orders it can never fill
 * and watches them walk out with no explanation. Naming the dish turns a
 * mystery into a shopping list.
 */
export function kitchenWarnings(world: World): string[] {
  const warnings: string[] = [];

  // A drive-through has no tables and is not missing any: its dining room is a
  // lane, and the hatch that serves it is furniture of the level that cannot be
  // sold, moved or built over. Being unable to *reach* it is a real mistake and
  // is already covered below, by the rule that covers every other appliance.
  if (world.lane === null) {
    if (countKind(world, "table") === 0) {
      warnings.push("No tables — nobody can sit down");
    } else {
      const stranded = unreachableTables(world);
      if (stranded.length > 0) {
        warnings.push(`${stranded.length} table(s) can't be reached from the door`);
      }
    }
  }

  const stranded = unreachableAppliances(world);
  if (stranded.length > 0) {
    // Naming them turns a mystery into a shopping list, the same way the menu
    // warnings do. Past a few names it stops being a list of mistakes and
    // starts being one: a chef shut in a cupboard cannot reach their own
    // kitchen, and the fault is the wall they are behind, not the sink.
    const labels = [...new Set(stranded.map((appliance) => applianceDef(appliance.kind).label))];
    warnings.push(
      labels.length > 3
        ? `${stranded.length} appliances can't be walked up to`
        : `Can't be walked up to: ${labels.join(", ")}`,
    );
  }

  const menu = unlockedRecipes(world);
  if (countKind(world, "plates") === 0) {
    warnings.push("No plate stack — nothing can be served");
  } else {
    const here = makeableHere(world);
    const off = menu.filter((recipe) => !here.has(specKey(recipe.dish)));
    // All of it gone is one sentence, not three: a room that can cook nothing
    // has one problem, and listing its symptoms buries it.
    if (off.length === menu.length && menu.length > 0) {
      warnings.push("Nothing on the menu can be made here");
    } else {
      for (const recipe of off) warnings.push(`${recipe.name} can't be made here`);
    }
  }

  // Not about making a dish — about undoing one. Worth a line because the cost
  // is invisible until the plate you need is under a burnt pizza.
  if (countKind(world, "bin") === 0) {
    warnings.push("No bin — a ruined dish has nowhere to go");
  }

  return warnings;
}

/**
 * Appliances no chef can walk up to. Used by the build phase to warn.
 *
 * The other half of the same question `unreachableTables` asks, from the other
 * side of the pass: that one starts at the door and looks for chairs, this one
 * starts at the chefs and looks for anything they have to face. A kitchen can
 * fail either way round, and a counter wall built across the room fails both.
 *
 * Origin is **where the chefs are standing**, not a spawn point: by the time
 * this is asked they have spent a morning walking around, and the spawn tile is
 * a fact about the level rather than about the room as it is now. With nobody
 * in it there is no answer to give, so an empty kitchen reports nothing.
 *
 * A held appliance is skipped — its tile is only where it would go home to.
 */
export function unreachableAppliances(world: World): Appliance[] {
  if (world.players.length === 0) return [];

  const reachable = new Set<number>();
  for (const player of world.players) {
    const x = Math.floor(player.pos.x);
    const y = Math.floor(player.pos.y);
    if (reachable.has(tileIndex(world, x, y))) continue; // already covered
    for (const index of reachableFrom(world, { x, y })) reachable.add(index);
  }

  const stranded: Appliance[] = [];
  for (const appliance of world.appliances.values()) {
    if (appliance.heldBy !== null) continue;
    const sides = seatsAround(world, appliance.tile);
    if (!sides.some((side) => reachable.has(tileIndex(world, side.x, side.y)))) {
      stranded.push(appliance);
    }
  }
  return stranded;
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
 *
 * It stopped counting down from EAT_TIME the day appetite became a property of
 * the person, and this is why nothing broke: the divisor is theirs too.
 */
export function mealLeft(customer: Customer): number {
  if (customer.state !== "eating") return 1;
  return Math.max(0, Math.min(1, customer.timer / eatTime(customer)));
}

/**
 * Top walking speed for this customer, in tiles per second.
 *
 * Re-exported here rather than imported from the system, so the render layer
 * keeps reading things that are *true* and never things that *happen*. It
 * drives the walk cycle: pace is a dial on the kind, and a hurried diner
 * animated against the average speed would skate.
 */
export { customerSpeed };

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
    // A pile says how big it is: "3 dirty plates" is the difference between a
    // trip to the sink being worth making and being a chore.
    const count = plateCount(item);
    if (isDirty(item)) return count > 1 ? `${count} dirty plates` : "Dirty plate";
    const food = item.contents.find((child) => !isPlate(child));
    if (food) return `Plate: ${itemLabel(food)}`;
    return count > 1 ? `${count} plates` : "Plate";
  }
  if (item.processes.length === 0) return base;
  if (item.processes.includes("burnt")) return `Burnt ${base}`;
  return `${base} (${item.processes.join(", ")})`;
}
