import { applianceDef } from "../../data/appliances";
import { COMBINE_INDEX, pairKey } from "../../data/recipes";
import { isBurnt, isDirty, isPlate, makeItem, specKey } from "../items";
import {
  MAX_CARRIED_PLATES,
  MAX_PLATES,
  emptyAppliance,
  mintPlate,
  plateCount,
  platesInWorld,
  scrape,
  shelvePlate,
  stackPlates,
  unshelvePlate,
} from "../plates";
import { countKind, isEssential, offerLabel, offerPrice, sellPrice } from "../shop";
import type { Appliance, Inputs, Item, Offer, Player, World } from "../types";
import {
  PLAYER_RADIUS,
  applianceAtTile,
  effect,
  inBounds,
  log,
  nearestFreeTile,
  spawnAppliance,
  tileIndex,
  touchLayout,
} from "../world";
import { acceptDelivery } from "./customers";
import { useCardStand } from "./cards";
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

  // The plate stack answers a grab entirely on its own terms, in both
  // directions, so it is handled before anything else can get a word in. That
  // ordering is also what makes a pre-sink save safe: those stored a `source`
  // on the plate stack, back when it conjured plates out of nothing, and the
  // source branches below would happily honour it.
  if (appliance.kind === "plates") {
    usePlateStack(world, player, appliance);
    return;
  }

  if (player.carried) {
    // --- putting something down ---
    if (appliance.kind === "bin") {
      useBin(world, player, appliance);
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
    // ...or hands one straight into what you're carrying, when the two go
    // together: carry a plate past the tomato crate and you leave with a plated
    // tomato, no round trip to a counter.
    if (appliance.source) {
      const dispensed = makeItem(world, appliance.source);
      const merged = merge(dispensed, player.carried) ?? merge(player.carried, dispensed);
      if (merged) {
        player.carried = merged;
        return;
      }
    }
    // Plates come **up** into your hands, everywhere except the two places
    // plates belong. Bussing is a sweep — table, table, table, sink — and a
    // rule that put your pile down on the second table instead of adding to it
    // would make carrying four plates impossible to actually do.
    if (appliance.kind === "sink") {
      if (useSink(world, player, appliance)) return;
    } else if (takePlatesUp(world, player, appliance)) {
      return;
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
 * The bin scrapes; it does not swallow.
 *
 * Plates are finite and conserved, so the bin — the one appliance whose whole
 * job is destroying things — is the most dangerous place in the kitchen for
 * one. It takes the food and hands the crockery back **dirty**, which is what a
 * real kitchen does with a ruined plate of food, and which quietly feeds the
 * sink from the same direction bussing does.
 */
function useBin(world: World, player: Player, appliance: Appliance): void {
  const carried = player.carried;
  if (!carried) return;
  const hasFood = !isPlate(carried) || carried.contents.some((child) => !isPlate(child));
  player.carried = scrape(carried);
  if (!hasFood) {
    log(world, "Plates don't go in the bin");
    return;
  }
  effect(world, { kind: "binned", tile: appliance.tile });
  log(world, player.carried ? "Scraped" : "Binned");
}

/**
 * Add the plates resting here to the pile in your hands. Returns false when
 * they are not plates, are not in the same state, or would not fit.
 *
 * The tip comes up with them, exactly as it does when a single dirty plate is
 * picked up — the money is the reason to walk over, and a sweep of four tables
 * must not pay less than four separate trips.
 */
function takePlatesUp(world: World, player: Player, appliance: Appliance): boolean {
  const held = player.carried;
  const resting = appliance.item;
  if (!held || !resting) return false;
  if (!stackPlates(resting, held, MAX_CARRIED_PLATES)) return false;
  appliance.item = null;
  appliance.progress = 0;
  appliance.overcook = 0;
  collectTip(world, player, appliance);
  return true;
}

/**
 * The sink takes plates down, and takes as many as you have.
 *
 * Capacity here is not the hands' four: a sink is where the washing-up goes,
 * and "the sink is full" is a sentence about a kitchen that has already gone
 * wrong in a more interesting way. What it will not do is pile dirty plates
 * onto the clean ones somebody has just finished washing — the head of a pile
 * is what the sink reads to decide there is work to do, so a clean-headed pile
 * with dirty plates hidden in it is washing-up nobody can ever get at.
 *
 * Returns false for anything that is not crockery, which falls through to the
 * ordinary put-it-down rules: the sink is still a surface.
 */
function useSink(world: World, player: Player, sink: Appliance): boolean {
  const carried = player.carried;
  if (!carried || !isPlate(carried)) return false;
  if (carried.contents.some((child) => !isPlate(child))) return false;

  if (!sink.item) {
    sink.item = carried;
    player.carried = null;
    return true;
  }
  if (!stackPlates(carried, sink.item, MAX_PLATES)) {
    // Plates onto plates that will not have them: say why. Anything else in
    // the basin is not this rule's business, so it falls through to the
    // ordinary put-it-down path.
    if (!isPlate(sink.item)) return false;
    log(world, "Take the clean ones out first");
    return true;
  }
  player.carried = null;
  sink.progress = 0;
  return true;
}

/**
 * The plate stack: the kitchen's supply, and a finite one.
 *
 * It used to be a `source` — an infinite spring that also washed up for free,
 * which meant the dirty plate a customer left behind cost nothing but the walk.
 * Now it holds a real pile of real plates:
 *
 *  - empty-handed, you take **one**;
 *  - carrying clean plates, you put them all back, however many you washed;
 *  - carrying food, a plate comes out to meet it — the move that lets you walk
 *    chopped lettuce here and leave with a plated salad;
 *  - carrying a dirty plate, nothing happens. That is the sink's job now, and
 *    the whole point of the sink existing.
 */
function usePlateStack(world: World, player: Player, home: Appliance): void {
  const carried = player.carried;

  if (!carried) {
    const plate = unshelvePlate(home);
    if (!plate) {
      log(world, "No clean plates — wash some up");
      return;
    }
    player.carried = plate;
    return;
  }

  if (isDirty(carried)) {
    log(world, "Dirty — that goes in the sink");
    return;
  }

  if (isPlate(carried)) {
    // Clean plates go home. Anything loaded is refused: a plated dish is not
    // put away, it is served.
    if (carried.contents.some((child) => !isPlate(child))) {
      log(world, "Take the food off first");
      return;
    }
    shelvePlate(home, carried);
    player.carried = null;
    return;
  }

  if (isBurnt(carried)) return;
  const plate = unshelvePlate(home);
  if (!plate) {
    log(world, "No clean plates — wash some up");
    return;
  }
  const merged = merge(plate, carried) ?? merge(carried, plate);
  if (merged) {
    player.carried = merged;
    return;
  }
  // Nothing came of it, so the plate goes straight back: a plate that leaves
  // the stack and reaches nobody's hands is a plate the kitchen has lost.
  shelvePlate(home, plate);
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
  world.today.tips += appliance.tip;
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

  // Plates pile up rather than refusing each other, so one trip clears a
  // dining room. Only same-state piles stack — see `sim/plates.ts`.
  const stacked = stackPlates(held, target);
  if (stacked) return stacked;

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
  // A dirty plate is not a workspace. It goes to the sink.
  //
  // This looks like it breaks the rule above, and it is the one refusal worth
  // keeping: plating onto a dirty plate is a mistake you would not discover
  // until the delivery bounced, by which time it is too late to be information.
  // It is legible because the plate *looks* dirty from across the room.
  if (isDirty(plate)) return null;
  // Neither is a pile. Take one off it first — which is exactly what the plate
  // stack does for you when you carry food to it.
  if (plate.contents.some((child) => isPlate(child))) return null;
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

  // The stall answers a grab entirely on its own terms, in both directions, so
  // it goes first. Everything below would otherwise refuse it silently: a stall
  // slot is immovable, so it cannot be lifted and cannot be placed onto.
  const faced = applianceAtTile(world, tile.x, tile.y);
  if (faced?.kind === "stall") {
    useStall(world, player, faced);
    return;
  }
  // The card stand, for the same reason and on the same terms: immovable, so
  // every rule below would refuse it silently.
  if (faced?.kind === "cards") {
    useCardStand(world, player, faced);
    return;
  }

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
      emptyAppliance(world, existing);
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
  // `heldBy` first: `emptyAppliance` sends any plates to a stack that is still
  // standing on the grid, and this one no longer is. Lift the only plate stack
  // in the kitchen and its plates travel with it rather than evaporating.
  appliance.heldBy = player.id;
  emptyAppliance(world, appliance);
  world.applianceAt[idx] = 0;
  touchLayout(world);
  player.carriedAppliance = appliance.id;
}

// --- the stall ---------------------------------------------------------------

/**
 * Face a slot, press `Grab`. That is the whole shop.
 *
 * **Zero new verbs.** Empty-handed at a stocked slot buys; carrying an
 * appliance at an empty one sells; carrying the thing you just bought back to
 * the slot you bought it from is an undo. Every branch ends in a log line that
 * names the player, because money is one shared number and the only honest
 * account of who spent it is the log.
 */
function useStall(world: World, player: Player, slot: Appliance): void {
  if (world.phase !== "build") return; // shuttered; the morning is the decision

  const carried = player.carriedAppliance;
  if (carried !== null) {
    const appliance = world.appliances.get(carried);
    if (appliance) sellToStall(world, player, slot, appliance);
    else player.carriedAppliance = null;
    return;
  }

  // A slot that has already handed something out today is empty, whatever it
  // still remembers being worth.
  const offer = slot.taken === null ? slot.offer : null;
  if (!offer) return;

  const price = offerPrice(offer);
  if (world.money < price) {
    // Never a silent no. The log says the number, the slot flashes, and the
    // player is left knowing exactly what they are short of.
    refuse(world, slot, `Need $${price} — ${offerLabel(offer)}`);
    return;
  }

  if (offer.good === "plate") buyPlate(world, player, slot, offer, price);
  else buyAppliance(world, player, slot, offer, price);
}

/**
 * An appliance leaves the stall as a **held ghost**, exactly as if it had been
 * lifted off the kitchen floor.
 *
 * That is the entire point of routing a purchase through the build phase's
 * existing verb: the thing you have just bought is already answering "where
 * would this go", with `canPlace` deciding and the highlight underneath saying
 * yes or no. A shop that handed you an appliance and then asked you to find it
 * would be two interactions where one will do.
 *
 * It is born held, so it never touches the grid on its way out — see
 * `spawnAppliance`. Its home tile is the nearest **free** one, which by
 * construction is neither the door nor the patio: an appliance whose buyer
 * disconnects has to land somewhere the game is allowed to put it.
 */
function buyAppliance(
  world: World,
  player: Player,
  slot: Appliance,
  offer: Extract<Offer, { good: "appliance" }>,
  price: number,
): void {
  const home = nearestFreeTile(world, slot.tile);
  if (!home) {
    refuse(world, slot, "Nowhere to put it");
    return;
  }

  const bought = spawnAppliance(world, offer.kind, home, offer.source, player.id);
  world.money -= price;
  slot.taken = bought.id;
  player.carriedAppliance = bought.id;
  spend(world, slot, price);
  log(world, `${who(player)} bought a ${offerLabel(offer)}  -$${price}`);
  touchLayout(world);
}

/**
 * A plate is bought into your hands, and is the one thing in the game that did
 * not exist a moment ago.
 *
 * It goes through `mintPlate` so that the kitchen's plate count has exactly one
 * place it can grow, and so the conservation tests can follow it. There is no
 * refund: giving the money back would mean destroying the plate, and there are
 * no destruction paths.
 */
function buyPlate(
  world: World,
  player: Player,
  slot: Appliance,
  offer: Offer,
  price: number,
): void {
  if (player.carried && !isPlate(player.carried)) {
    refuse(world, slot, "Hands full");
    return;
  }
  if (platesInWorld(world) >= MAX_PLATES) {
    refuse(world, slot, "That is all the plates a kitchen can hold");
    return;
  }

  const plate = mintPlate(world);
  if (player.carried) {
    // Onto the pile, if it will go. A chef already holding four is holding four.
    const stacked = stackPlates(plate, player.carried, MAX_CARRIED_PLATES);
    if (!stacked) {
      refuse(world, slot, "Hands full");
      return;
    }
  } else {
    player.carried = plate;
  }

  world.money -= price;
  // No `taken`: a plate cannot be handed back, so the slot is simply empty.
  slot.offer = null;
  spend(world, slot, price);
  log(world, `${who(player)} bought a ${offerLabel(offer)}  -$${price}`);
  touchLayout(world);
}

/**
 * Putting an appliance down on an empty slot sells it — unless it is the one
 * that came out of that slot this morning, in which case it is an undo.
 *
 * Full price back before the day opens, half afterwards. Remorse inside the
 * morning you bought in is not commerce, and charging for it would make the
 * shop a place to be careful rather than a place to experiment.
 */
function sellToStall(world: World, player: Player, slot: Appliance, appliance: Appliance): void {
  if (slot.taken !== null && slot.taken === appliance.id && slot.offer) {
    const price = offerPrice(slot.offer);
    world.money += price;
    slot.taken = null;
    player.carriedAppliance = null;
    world.appliances.delete(appliance.id);
    log(world, `${who(player)} put the ${offerLabel(slot.offer)} back  +$${price}`);
    touchLayout(world);
    return;
  }

  if (slot.taken === null && slot.offer) return; // the slot is full; nothing to do

  const def = applianceDef(appliance.kind);
  if (isEssential(appliance.kind) && countKind(world, appliance.kind) <= 1) {
    refuse(world, slot, `The kitchen needs its ${def.label.toLowerCase()}`);
    return;
  }

  // Plates travel with a lifted plate stack when it is the only one in the
  // kitchen, so this has to be true rather than assumed: nothing is sold with
  // crockery still on board.
  if (plateCount(appliance.item) > 0) {
    refuse(world, slot, "Take the plates off first");
    return;
  }

  const price = sellPrice(appliance.kind);
  emptyAppliance(world, appliance);
  world.appliances.delete(appliance.id);
  player.carriedAppliance = null;
  world.money += price;
  // Whatever the slot was holding is gone with the sale: one slot, one thing.
  slot.offer = null;
  slot.taken = null;
  log(world, `${who(player)} sold a ${def.label}  +$${price}`);
  touchLayout(world);
}

/** A refusal that can be seen as well as read. */
function refuse(world: World, slot: Appliance, why: string): void {
  log(world, why);
  effect(world, { kind: "refused", tile: slot.tile });
}

/** Money leaving, drawn where it left from. */
function spend(world: World, slot: Appliance, amount: number): void {
  effect(world, { kind: "spent", tile: slot.tile, amount });
}

/** Who did it. Local players have no name; the kitchen still has to say something. */
function who(player: Player): string {
  return player.name || "Chef";
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
