import { applianceDef } from "../../data/appliances";
import { COMBINE_INDEX, pairKey } from "../../data/recipes";
import { isBurnt, isDirty, isPlate, makeItem, specKey } from "../items";
import type { Appliance, Inputs, Item, Player, World } from "../types";
import {
  PLAYER_RADIUS,
  applianceAtTile,
  effect,
  inBounds,
  log,
  tileIndex,
  touchLayout,
} from "../world";
import { acceptDelivery } from "./customers";
import { canPlace, customerAt, itemLabel, targetAppliance, targetTile } from "../queries";

export function interactionSystem(world: World, inputs: Inputs): void {
  for (const player of world.players) {
    const input = inputs[player.id];
    if (!input) continue;
    const grabPressed = input.grab && !player.prev.grab;

    if (world.phase === "build") {
      if (grabPressed) buildGrab(world, player);
      player.workingOn = null;
      continue;
    }

    if (grabPressed) serviceGrab(world, player);

    // Hold-to-use: the appliance system reads `workingOn` each tick.
    const target = targetAppliance(world, player);
    player.workingOn = input.use && target ? target.id : null;
  }
}

// --- service phase -----------------------------------------------------------

function serviceGrab(world: World, player: Player): void {
  const appliance = targetAppliance(world, player);
  if (!appliance) return;
  const def = applianceDef(appliance.kind);

  if (player.carried) {
    // --- putting something down ---
    if (appliance.kind === "bin") {
      player.carried = null;
      effect(world, { kind: "binned", tile: appliance.tile });
      log(world, "Binned");
      return;
    }
    // Note there is no "serve" case here any more. The pass is a counter, not a
    // chute: a plate put down on it stays there for someone to run out. Food is
    // delivered at a table, in front of the person who ordered it.
    //
    // A source takes back exactly what it hands out: the untouched tomato goes
    // back in the crate, the clean plate back on the stack. Anything you've
    // changed — chopped, cooked, loaded — is your problem, and the bin's.
    // Comparing spec keys means this stays true for any source added later.
    if (
      appliance.source &&
      specKey(player.carried) === specKey(appliance.source) &&
      player.carried.contents.length === 0
    ) {
      log(world, `Put back: ${itemLabel(player.carried)}`);
      player.carried = null;
      return;
    }
    // The plate stack also takes dirty plates back and hands them out clean.
    // A hand-wave for one release: the sink is the next patch, and it slots in
    // here without anything else about bussing having to change.
    if (appliance.kind === "plates" && isDirty(player.carried)) {
      log(world, "Washed up");
      player.carried = null;
      return;
    }
    // ...or hands one straight into what you're carrying, when the two go
    // together: walk chopped lettuce to the plate stack and you leave with a
    // plated salad, no round trip to a counter. Same rule gets a tomato
    // straight onto a held plate.
    if (appliance.source) {
      const dispensed = makeItem(world, appliance.source);
      const merged = merge(dispensed, player.carried) ?? merge(player.carried, dispensed);
      if (merged) {
        player.carried = merged;
        return;
      }
    }
    if (!def.acceptsItems) return;

    if (!appliance.item) {
      appliance.item = player.carried;
      player.carried = null;
      appliance.progress = 0;
      appliance.overcook = 0;
      if (appliance.kind === "table") tryDeliver(world, player, appliance);
      return;
    }

    const merged = merge(player.carried, appliance.item);
    if (merged) {
      appliance.item = merged;
      player.carried = null;
      appliance.progress = 0;
      appliance.overcook = 0;
    }
    return;
  }

  // --- picking something up ---
  if (appliance.source) {
    player.carried = makeItem(world, appliance.source);
    return;
  }
  if (appliance.item) {
    player.carried = appliance.item;
    appliance.item = null;
    appliance.progress = 0;
    appliance.overcook = 0;
    collectTip(world, player, appliance);
  }
}

/**
 * Money left on a table comes up with whatever is on it.
 *
 * This is what makes clearing tables a decision rather than a chore: the tip is
 * the pull, the dirty plate is what you have to carry to get it, and both are
 * on the way back from delivering the next dish.
 */
function collectTip(world: World, player: Player, appliance: Appliance): void {
  if (appliance.tip <= 0) return;
  world.money += appliance.tip;
  effect(world, { kind: "tipped", playerId: player.id, amount: appliance.tip });
  appliance.tip = 0;
}

/**
 * A plate just landed on a table. If the customer sitting there ordered it,
 * they start eating and the chef who ran the food is paid for it.
 *
 * The rule itself lives with the customers (`acceptDelivery`), because a
 * customer can also find their dish already waiting when they finish deciding.
 * Only the credit differs: there, nobody is standing at the table.
 */
function tryDeliver(world: World, player: Player, table: Appliance): void {
  const customer = customerAt(world, table);
  if (!customer) return;
  const reward = acceptDelivery(world, table, customer);
  if (reward !== null) effect(world, { kind: "served", playerId: player.id, amount: reward });
}

/**
 * Merge `held` into `target`. Two rules:
 *  1. any food item goes onto an empty plate, in either direction — carrying a
 *     plate onto a dish plates it just as carrying the dish onto a plate does;
 *  2. otherwise look for a combine rule.
 * Returns the resulting item, or null when the pair means nothing.
 */
function merge(held: Item, target: Item): Item | null {
  if (isBurnt(held) || isBurnt(target)) return null;

  const plated = tryPlate(held, target) ?? tryPlate(target, held);
  if (plated) return plated;

  return tryCombine(held, target);
}

/**
 * A plate takes any food item, not just finished dishes. Restricting it to
 * recipe outputs made the interaction unpredictable ("why won't this go on the
 * plate?"); plating the wrong thing is obvious, harmless and undone with the
 * bin. Serving still checks the contents against a recipe.
 *
 * A plate is also a **workspace**: food that combines with something already on
 * it becomes the combined dish in place. Assembling a salad directly on the
 * plate is the move players reach for first, and refusing it taught them
 * nothing. Food that combines with nothing simply sits alongside — which is
 * exactly what stops it being served, since a dish is one item.
 */
function tryPlate(plate: Item, food: Item): Item | null {
  if (!isPlate(plate) || isPlate(food)) return null;
  // A dirty plate is not a workspace. It goes to the sink, or back on the stack.
  if (isDirty(plate)) return null;
  for (const existing of plate.contents) {
    if (tryCombine(food, existing)) return plate;
  }
  plate.contents.push(food);
  return plate;
}

/** Apply a COMBINE rule, rewriting `target` into the result. */
function tryCombine(held: Item, target: Item): Item | null {
  const output = COMBINE_INDEX.get(pairKey(specKey(held), specKey(target)));
  if (!output) return null;
  // Reuse the target's id so the render layer can animate rather than pop.
  target.base = output.base;
  target.processes = [...output.processes];
  target.contents = [];
  return target;
}

// --- build phase -------------------------------------------------------------

function buildGrab(world: World, player: Player): void {
  const tile = targetTile(player);
  if (!inBounds(world, tile.x, tile.y)) return;
  const idx = tileIndex(world, tile.x, tile.y);

  if (player.carriedAppliance !== null) {
    const appliance = world.appliances.get(player.carriedAppliance);
    if (!appliance) {
      player.carriedAppliance = null;
      return;
    }
    if (!canPlace(world, tile.x, tile.y)) return;
    // The placing player usually clips into the tile they're facing (reach is
    // larger than their radius), so they are excluded here and shoved clear
    // afterwards instead.
    if (tileOccupiedByPlayer(world, tile.x, tile.y, player.id)) {
      log(world, "Someone is standing there");
      return;
    }

    // Dropping onto an occupied tile **swaps**: theirs comes up as yours goes
    // down. Rearranging a kitchen is mostly exchanging two appliances, and
    // making that a single action beats hunting for a free tile to park one on.
    // Swapping rather than destroying also keeps it reversible — there is no
    // way to buy an appliance back yet.
    const existing = applianceAtTile(world, tile.x, tile.y);
    if (existing) {
      existing.heldBy = player.id;
      existing.item = null;
      existing.progress = 0;
      existing.overcook = 0;
      player.carriedAppliance = existing.id;
    } else {
      player.carriedAppliance = null;
      pushOutOfTile(player, tile.x, tile.y);
    }

    appliance.tile = { x: tile.x, y: tile.y };
    appliance.heldBy = null;
    world.applianceAt[idx] = appliance.id;
    touchLayout(world);
    return;
  }

  const appliance = applianceAtTile(world, tile.x, tile.y);
  if (!appliance || !applianceDef(appliance.kind).movable) return;
  appliance.heldBy = player.id;
  appliance.item = null;
  appliance.progress = 0;
  appliance.overcook = 0;
  world.applianceAt[idx] = 0;
  touchLayout(world);
  player.carriedAppliance = appliance.id;
}

function tileOccupiedByPlayer(world: World, tx: number, ty: number, ignore: number): boolean {
  const r = PLAYER_RADIUS;
  for (const player of world.players) {
    if (player.id === ignore) continue;
    const nearestX = Math.max(tx, Math.min(player.pos.x, tx + 1));
    const nearestY = Math.max(ty, Math.min(player.pos.y, ty + 1));
    const dx = player.pos.x - nearestX;
    const dy = player.pos.y - nearestY;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

/** Shove a player out of a tile that just became solid, via the shortest exit. */
function pushOutOfTile(player: Player, tx: number, ty: number): void {
  const r = PLAYER_RADIUS;
  const fromLeft = player.pos.x + r - tx;
  const fromRight = tx + 1 - (player.pos.x - r);
  const fromTop = player.pos.y + r - ty;
  const fromBottom = ty + 1 - (player.pos.y - r);
  if (fromLeft <= 0 || fromRight <= 0 || fromTop <= 0 || fromBottom <= 0) return;

  const smallest = Math.min(fromLeft, fromRight, fromTop, fromBottom);
  if (smallest === fromLeft) player.pos.x = tx - r;
  else if (smallest === fromRight) player.pos.x = tx + 1 + r;
  else if (smallest === fromTop) player.pos.y = ty - r;
  else player.pos.y = ty + 1 + r;
}
