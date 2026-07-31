import { APPLIANCE_KINDS, ESSENTIAL, applianceDef, type ApplianceKind } from "../data/appliances";
import { PLATE_PRICE, PLATE_WEIGHT, SCARCE_BELOW, SELLBACK, STOCK_WEIGHT } from "../data/economy";
import { unlockedIngredients, unlockedKinds } from "./cards";
import { ingredient } from "../data/ingredients";
import { mulberry32 } from "./random";
import type { Appliance, Offer, Vec2, World } from "./types";
import { inward } from "./walls";
import { applianceAtTile, inBounds, tileIndex, touchLayout } from "./world";

/**
 * The shop: what is for sale, what it costs, and what a sale pays.
 *
 * It is a *place*, not a menu — three squares of paving outside the door with
 * the morning's delivery standing on them, faced and grabbed exactly like
 * anything else in the kitchen. So there is nothing here about interaction;
 * `systems/interaction.ts` owns that, and this file owns only the questions it
 * has to ask. What is on square two? What is it worth? May this be sold?
 *
 * ## The delivery is derived, not stored
 *
 * Where it lands and what is on it are both rolled from `(seed, day)` through
 * their **own** generator, not from
 * `random(world)`. The world's stream is consumed by play — arrivals, chairs —
 * so it has diverged between two rooms on the same seed by the end of the first
 * minute. Anything that must look the same on every client and is not sent over
 * the wire has to come from something that does not move; the seed and the day
 * do not move.
 *
 * The *result* is ordinary world state: it lives on the slot appliances, so it
 * rides the layout message like everything else about where things are, and a
 * slot emptying is a layout change like an oven moving.
 *
 * ## It lands somewhere different every morning
 *
 * A delivery that appeared on the same three squares every day would be three
 * squares the game had reserved, which is the shop-as-furniture problem coming
 * back in through the floor. So the squares themselves move: near the door,
 * never on the way in, and never twice in the same arrangement.
 *
 * The level still lists three of them, because a level says what a kitchen has
 * — it is only where they stand on the first morning, and the roll takes over
 * from there.
 *
 * ## The delivery is for *this* restaurant
 *
 * What is on offer follows the room's own menu, not the library: crates hold
 * ingredients its recipes start from, and an appliance kind nothing on the menu
 * can use is not offered at all. A fryer in a slot before fries exist is an
 * expensive thing to buy in order to watch it do nothing — noise in the one
 * place the game is trying to teach what a kitchen is missing.
 *
 * Implemented as a **filter at roll time**, never by writing to `STOCK_WEIGHT`:
 * the weights are content, they are the same for every room, and a shop that
 * edited them would be a shop whose tuning depended on who had been playing.
 */

/** The squares things are sold from, in a stable order: top to bottom. */
export function stallSlots(world: World): Appliance[] {
  const slots: Appliance[] = [];
  for (const appliance of world.appliances.values()) {
    if (appliance.kind === "stall") slots.push(appliance);
  }
  // Sorted rather than trusted to insertion order: a restored kitchen rebuilds
  // its furniture in level order, but a layout arriving over the wire is
  // whatever the server's map iteration produced. Slot 1 has to be the same
  // slot on both, or a refund lands on the wrong one.
  return slots.sort((a, b) => a.tile.y - b.tile.y || a.tile.x - b.tile.x);
}

export function offerPrice(offer: Offer): number {
  return offer.good === "plate" ? PLATE_PRICE : applianceDef(offer.kind).price;
}

/** What the stall pays for one of these. Rounded down: the house rounds. */
export function sellPrice(kind: ApplianceKind): number {
  return Math.floor(applianceDef(kind).price * SELLBACK);
}

export function offerLabel(offer: Offer): string {
  if (offer.good === "plate") return "Plate";
  if (offer.source) return `${ingredient(offer.source.base).name} crate`;
  return applianceDef(offer.kind).label;
}

/**
 * May this kind be sold at all?
 *
 * The last plate stack and the last sink are refused, and they are refused from
 * the *same list* the save system backfills from — there is one answer to "what
 * can a kitchen not live without" and it lives in `data/appliances.ts`. Selling
 * the last plate stack is the worse of the two and the less obvious: the
 * kitchen's plates are riding on it while it is held, so the sale would take
 * the crockery with it and write that to disk.
 */
export function isEssential(kind: ApplianceKind): boolean {
  return ESSENTIAL.includes(kind);
}

/** How many of this kind the kitchen owns, held ones included. */
export function countKind(world: World, kind: ApplianceKind): number {
  let count = 0;
  for (const appliance of world.appliances.values()) {
    if (appliance.kind === kind) count++;
  }
  return count;
}

// --- the morning roll ---------------------------------------------------------

/**
 * Stand this morning's delivery on the paving, and fill it.
 *
 * Called once a morning, and once when a world is built or restored — the roll
 * is a pure function of the seed and the day, so doing it again is doing it
 * identically. Anything a player took yesterday is simply gone; there is no
 * buy-back of a specific unit, and a square they emptied comes back somewhere
 * else with something new on it.
 *
 * Where it lands is drawn first and from the same stream, because it is the
 * same event: one delivery, one roll. Two streams would be two things to keep
 * in step for no gain, and drawing in a fixed order is what keeps every client
 * agreeing about a morning nobody sent them.
 */
export function restockStall(world: World): void {
  const slots = stallSlots(world);
  if (slots.length === 0) return;

  // A stream of its own, from two numbers that cannot drift. `| 0` keeps the
  // seed in the same 32-bit shape `mulberry32` is written for.
  const random = mulberry32((world.seed * 0x9e37 + world.day * 0x85eb) | 0);
  landDelivery(world, slots, random);

  // One slot is promised to something the kitchen is short of, so a morning is
  // never three duds. Which slot is itself rolled, or the guarantee would
  // always be sitting in the same place and stop reading as luck.
  const sold = soldKinds(world);
  const sources = unlockedIngredients(world);
  const scarce = scarceKinds(world, sold);
  const promised = slots.length > 0 ? Math.floor(random() * slots.length) : -1;

  for (const [index, slot] of slots.entries()) {
    const guaranteed = index === promised && scarce.length > 0;
    slot.offer = guaranteed ? rollFrom(scarce, random, sources) : rollOffer(sold, random, sources);
    slot.taken = null;
  }

  // An offer rides the layout message, so a new morning's stock is a layout
  // change like an oven moving. Without this the server never re-sends it: a
  // client keeps drawing yesterday's slot and buys today's thing out of it.
  touchLayout(world);
}

/** How far from the door a delivery may be dropped, in squares. */
const DELIVERY_REACH = 4;

/**
 * Move the squares to this morning's spots: paving near the door, never on the
 * way in.
 *
 * "Never on the way in" is a filter rather than a check afterwards, and that is
 * deliberate: the row a customer walks up to the door along is the one place a
 * crate can seal a restaurant shut, and a rule that *cannot* choose it beats a
 * rule that notices it has and rolls again. Everything else is fair game,
 * including round the corner of the building.
 *
 * Candidates are gathered in grid order so that the same seed picks the same
 * squares on every client, in a room nobody has sent them.
 */
function landDelivery(world: World, slots: Appliance[], random: () => number): void {
  const walkIn = inward(world.room, world.door);
  const moving = new Set(slots.map((slot) => slot.id));
  const spots: Vec2[] = [];
  for (let y = world.door.y - DELIVERY_REACH; y <= world.door.y + DELIVERY_REACH; y++) {
    for (let x = world.door.x - DELIVERY_REACH; x <= world.door.x + DELIVERY_REACH; x++) {
      if (!inBounds(world, x, y)) continue;
      const tile = world.tiles[tileIndex(world, x, y)];
      // Paving only: walkable, and not somewhere a kitchen may build. That is
      // the same pair of facts that makes the goods legible as goods.
      if (!tile?.walkable || tile.placeable) continue;
      // The way in, along the door's own line, stays clear both sides of it.
      if (walkIn.x !== 0 ? y === world.door.y : x === world.door.x) continue;
      // Anything already standing here — a poster on the wall, most often. The
      // squares being moved do not count as standing anywhere: the candidates
      // have to come out the same whatever yesterday's roll did with them, or
      // two clients that reached today by different routes would disagree.
      const here = applianceAtTile(world, x, y);
      if (here && !moving.has(here.id)) continue;
      spots.push({ x, y });
    }
  }
  if (spots.length < slots.length) return; // nowhere to put it: leave it be

  // Partial Fisher-Yates: one draw per square, and the draws happen whether or
  // not they are used, so the stream advances by the same amount every morning.
  for (const [index, slot] of slots.entries()) {
    const pick = index + Math.floor(random() * (spots.length - index));
    const spot = spots[pick]!;
    spots[pick] = spots[index]!;
    world.applianceAt[tileIndex(world, slot.tile.x, slot.tile.y)] = 0;
    slot.tile = { x: spot.x, y: spot.y };
  }
  // Written after every square has moved, or one landing where another has not
  // left yet would overwrite it and take the second off the grid.
  for (const slot of slots) {
    world.applianceAt[tileIndex(world, slot.tile.x, slot.tile.y)] = slot.id;
  }
}

/**
 * Kinds the kitchen owns fewer than `SCARCE_BELOW` of, and that are for sale.
 *
 * "For sale" now includes "this menu has a use for it", which is what keeps the
 * guarantee honest: the promised slot exists to hold something *relevant*, and
 * a fryer the room cannot cook with is the least relevant thing there is. It
 * covers a delivered kind the morning after a card arrives, without being told
 * to — a kitchen with one oven owns fewer than two ovens.
 *
 * **Upgrades are never promised.** A kitchen owns none of them for a long time
 * and is missing nothing: the guarantee is about gaps, and a steel board is a
 * luxury. Left in, it would qualify forever — nobody buys two — and the one
 * slot reserved for what a room actually needs would spend every morning
 * showing it something it cannot afford.
 */
function scarceKinds(world: World, sold: ApplianceKind[]): ApplianceKind[] {
  return sold.filter(
    (kind) => applianceDef(kind).upgrades === null && countKind(world, kind) < SCARCE_BELOW,
  );
}

/**
 * Kinds this room may be offered at all: sold, and useful to its menu.
 *
 * Walks `APPLIANCE_KINDS`, so the order of the roll is the order of the
 * appliance table — a fixed, shared sequence rather than whatever a `Set`
 * happened to be built in.
 */
function soldKinds(world: World): ApplianceKind[] {
  const useful = unlockedKinds(world);
  return APPLIANCE_KINDS.filter((kind) => STOCK_WEIGHT[kind] > 0 && useful.has(kind));
}

/**
 * One slot's worth of stock, weighted across the appliances and the plate.
 *
 * Walks `APPLIANCE_KINDS` rather than the weight table's own keys, so the order
 * of the roll is the order of the appliance table — a fixed, shared sequence.
 * Iterating a record's keys would tie the outcome to insertion order, which is
 * stable in practice and is exactly the sort of thing that has no business
 * deciding what two different clients see in a shop.
 */
function rollOffer(pool: ApplianceKind[], random: () => number, sources: string[]): Offer {
  let total = PLATE_WEIGHT;
  for (const kind of pool) total += STOCK_WEIGHT[kind];

  let roll = random() * total;
  for (const kind of pool) {
    roll -= STOCK_WEIGHT[kind];
    if (roll < 0) return withSource(kind, random, sources);
  }
  return { good: "plate" };
}

/**
 * Pick from a shortlist, still by weight.
 *
 * Uniformly would have been simpler and was wrong. A lean kitchen owns one of
 * nearly everything, so "kinds you have fewer than two of" is most of the
 * catalogue — and picking evenly from it made a fryer exactly as likely as a
 * counter. The promised slot held throughput on four mornings out of six, which
 * is the opposite of the rhythm the tiers exist to create. The guarantee is
 * about *relevance*, not about rarity, and it has no business overriding it.
 */
function rollFrom(pool: ApplianceKind[], random: () => number, sources: string[]): Offer {
  let total = 0;
  for (const kind of pool) total += STOCK_WEIGHT[kind];
  let roll = random() * total;
  for (const kind of pool) {
    roll -= STOCK_WEIGHT[kind];
    if (roll < 0) return withSource(kind, random, sources);
  }
  return withSource(pool[0] ?? "counter", random, sources);
}

/**
 * A crate is not a crate: it is a *tomato* crate, and which one is part of the
 * offer. Rolled from the ingredients **this room's** recipes start from, so a
 * kitchen can never be sold a crate of something its menu has no use for — no
 * cheese until a dish takes cheese, and tomatoes from the first morning.
 */
function withSource(kind: ApplianceKind, random: () => number, sources: string[]): Offer {
  if (kind !== "crate") return { good: "appliance", kind, source: null };
  const base = sources[Math.floor(random() * sources.length)] ?? "tomato";
  return { good: "appliance", kind, source: { base, processes: [] } };
}
