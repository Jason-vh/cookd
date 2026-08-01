import { DIRTY } from "../data/ingredients";
import { isDirty, isPlate, makeItem, walkItems } from "./items";
import type { Appliance, Item, World } from "./types";

/**
 * Plates, and the promise that there are always exactly as many as there were.
 *
 * Once plates are finite, **a plate that ceases to exist is a soft-locked
 * room** — and a persistent one, because the loss is written to the save. Every
 * path that could destroy one therefore goes through this file: the bin, the
 * end of a day, a player disconnecting, an appliance being lifted in the build
 * phase. `sim.test.ts` counts plates across all four.
 *
 * Conservation means *no destruction*. Creation is a different question, and
 * there is now exactly one answer to it: `mintPlate`, called when somebody buys
 * one at the stall. It is a named, exported, single-caller function precisely
 * so that "where do plates come from" stays a question with one honest answer
 * rather than a `makeItem` call somewhere in a shop.
 *
 * ## A pile of plates is a plate holding plates
 *
 * One representation, not three. `contents` already exists for the dish on a
 * plate, and a plate is never both a workspace and a pile — a dirty plate
 * refuses food, and a stack is only ever crockery. So:
 *
 *   { base: "plate", processes: ["dirty"], contents: [plate, plate] }
 *
 * is three dirty plates, one bussing run, one item to carry, one item to drop
 * in the sink. The **head** is the pile's identity: it is what `isDirty` reads,
 * what the top of the drawn stack is, and — see `applianceSystem` — the last
 * plate the sink washes, so a pile that still has dirty plates in it still
 * reads and behaves as dirty.
 */

/** How many plates one chef can carry at once. One bussing sweep, not a toll. */
export const MAX_CARRIED_PLATES = 4;

/**
 * How many plates a stack bought at the stall arrives with.
 *
 * A plate stack is the **only** way a kitchen ever gets more crockery, and it
 * comes stocked because an empty one is furniture rather than capacity. Four,
 * so that buying one is the same step up a level ships with — one more sweep of
 * the dining room between trips to the sink.
 */
export const STACK_PLATES = 4;

/**
 * A brand new plate, and the only one the game will ever make.
 *
 * The stall sells them, and this is what it hands over. Everything else that
 * looks like plate creation is really plate *restoration*: `stockPlates` puts
 * back a number somebody counted a moment earlier, which is why it takes a
 * count rather than deciding one.
 *
 * The caller is expected to be able to say why the kitchen has one more plate
 * than it did. There is currently one caller.
 */
export function mintPlate(world: World): Item {
  return makeItem(world, { base: "plate", processes: [] });
}

/**
 * The most plates a kitchen may own, and therefore the tallest a single pile
 * can be — the whole supply fits on the stack. The stall will not sell past it.
 *
 * It exists because the wire has to agree with it: a pile is an item with its
 * plates in `contents`, and a pile taller than the frame parser's `MAX_CONTENTS`
 * makes **every frame undecodable**, which looks like a client that connects to
 * nothing rather than like a limit. `wire.ts` takes its bound from here so the
 * two cannot drift, and `parseSave` refuses a file claiming more.
 */
export const MAX_PLATES = 32;

/** Crockery and nothing else — the shape a pile is allowed to have. */
function isBarePlate(item: Item | null): item is Item {
  return item !== null && isPlate(item) && item.contents.every((child) => isPlate(child));
}

/** Every plate in this item, itself included. */
export function plateCount(item: Item | null): number {
  let plates = 0;
  for (const found of walkItems(item)) {
    if (isPlate(found)) plates++;
  }
  return plates;
}

/**
 * Every plate anywhere in the kitchen: on appliances, in hands, and in front of
 * somebody eating.
 *
 * The third one is easy to forget and would be a slow leak rather than a loud
 * one: a diner takes their plate off the table for the length of a meal, so a
 * count that skipped them would under-report during service and *mint the
 * difference* the next time a day closed and counted them back on.
 */
export function platesInWorld(world: World): number {
  let plates = 0;
  for (const appliance of world.appliances.values()) plates += plateCount(appliance.item);
  for (const player of world.players) plates += plateCount(player.carried);
  for (const customer of world.customers) plates += plateCount(customer.plate);
  return plates;
}

/**
 * Add `held` to the pile `target`, or refuse.
 *
 * Only plates in the same state stack: a clean plate dropped on a dirty pile is
 * a plate nobody can pick out again, and the wash loop would be washing things
 * that were already clean. A pile part-way through the sink is the one legal
 * mixture — head still dirty, some of its contents already washed — and that is
 * fine to add more dirty plates to, because the head still says what it is.
 */
export function stackPlates(held: Item, target: Item, limit = MAX_CARRIED_PLATES): Item | null {
  if (!isBarePlate(held) || !isBarePlate(target)) return null;
  if (isDirty(held) !== isDirty(target)) return null;
  if (plateCount(held) + plateCount(target) > limit) return null;

  // The pile is flat: `held` joins the stack alongside whatever it was carrying
  // rather than under it, so nesting never deepens (the wire has a depth limit,
  // and a pile of four is not four plates inside each other).
  const carried = held.contents;
  held.contents = [];
  target.contents.push(held, ...carried);
  return target;
}

/**
 * Take one plate off the pile an appliance is holding, or `null` if it has none.
 *
 * Appliance-aware because taking the last plate means the appliance is now
 * empty, and every caller would otherwise have to remember that.
 */
export function unshelvePlate(home: Appliance): Item | null {
  const stack = home.item;
  if (!isBarePlate(stack)) return null;
  const index = stack.contents.findIndex((child) => isPlate(child));
  if (index === -1) {
    home.item = null;
    return stack;
  }
  return stack.contents.splice(index, 1)[0] ?? null;
}

/**
 * Put a plate (or a pile) onto an appliance. Never fails — this is where plates
 * live, and "there was no room" is not an answer a plate stack gets to give.
 *
 * Deliberately does **not** go through `stackPlates`: that refuses a mismatched
 * state, and a refusal here would mean a plate that is neither on the appliance
 * nor in anyone's hands. A function whose contract is "cannot lose a plate"
 * must not be built out of one that can say no.
 *
 * Only ever called with a home that holds plates or nothing (a plate stack), so
 * the not-a-pile branch has nothing to overwrite.
 */
export function shelvePlate(home: Appliance, plate: Item): void {
  const stack = home.item;
  if (!isBarePlate(stack)) {
    home.item = plate;
    return;
  }
  const carried = plate.contents;
  plate.contents = [];
  stack.contents.push(plate, ...carried);
}

/**
 * Where a stray plate goes.
 *
 * A stack standing in the kitchen first; one somebody is **holding** if that is
 * all there is, because the alternative is deleting the plates; and only then
 * the caller's fallback. Returning nothing has to be reserved for a kitchen
 * with no plate stack at all — an earlier version skipped held stacks and
 * stopped there, so closing up while carrying the plate stack around the build
 * phase silently emptied the kitchen of crockery for good.
 */
function plateHome(world: World, fallback?: Appliance): Appliance | null {
  let held: Appliance | null = null;
  for (const appliance of world.appliances.values()) {
    if (appliance.kind !== "plates") continue;
    if (appliance.heldBy === null) return appliance;
    held ??= appliance;
  }
  return held ?? fallback ?? null;
}

/**
 * Put `count` clean plates back where they belong.
 *
 * Used by everything that tidies up: the end of a day, a player disconnecting
 * with a plate in their hands, an appliance lifted in the build phase, a save
 * being restored. They come back **clean**, which is a small gift and a
 * deliberate one — the alternative is a dirty plate with nowhere legal to go,
 * and the only worse outcome than a free wash is a plate that no longer exists.
 *
 * `fallback` is the last resort, for a kitchen with no plate stack in it at
 * all — in practice the appliance being emptied, so its plates travel with it.
 */
export function stockPlates(world: World, count: number, fallback?: Appliance): void {
  if (count <= 0) return;
  const home = plateHome(world, fallback);
  if (!home) return;
  for (let i = 0; i < count; i++)
    shelvePlate(home, makeItem(world, { base: "plate", processes: [] }));
}

/**
 * Empty an appliance, sending any plates home rather than into nothing.
 *
 * The build phase clears an appliance the moment it is lifted, and the plate
 * stack is an appliance like any other — so without this, rearranging the
 * kitchen is how a room loses its plates.
 */
export function emptyAppliance(world: World, appliance: Appliance): void {
  const plates = plateCount(appliance.item);
  appliance.item = null;
  appliance.progress = 0;
  appliance.overcook = 0;
  stockPlates(world, plates, appliance);
}

/**
 * The bin, applied to one item: the food goes, the crockery does not.
 *
 * Returns what stays in the chef's hands, or `null` when there was nothing but
 * food. A plate that held something comes back **dirty** — scraping a plate is
 * exactly how a plate gets dirty without a customer, which keeps the bin from
 * being a way to launder a mistake *and* feeds the sink the same way bussing
 * does. Plates that were only stacked keep whatever state they were in.
 */
export function scrape(item: Item): Item | null {
  if (!isPlate(item)) return null;
  const plates = item.contents.filter((child) => isPlate(child));
  const hadFood = plates.length !== item.contents.length;
  item.contents = plates;
  if (hadFood && !isDirty(item)) item.processes = [...item.processes, DIRTY];
  return item;
}
