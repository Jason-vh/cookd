import { APPLIANCE_KINDS, ESSENTIAL, applianceDef, type ApplianceKind } from "../data/appliances";
import { FIRST_DELIVERY_DAY, SCARCE_BELOW, SELLBACK, STOCK_WEIGHT } from "../data/economy";
import { offerable, rollCard, unlockedIngredients, unlockedKinds } from "./cards";
import { cardFee } from "../data/progression";
import { RECIPE_BY_ID } from "../data/recipes";
import { ingredient } from "../data/ingredients";
import { mulberry32 } from "./random";
import type { Appliance, Offer, Vec2, World } from "./types";
import { reachableFrom, seatsAround } from "./pathing";
import { inward } from "./walls";
import { applianceAtTile, inBounds, tileIndex, touchLayout } from "./world";

/**
 * The shop: what is for sale, what it costs, and what a sale pays.
 *
 * It is a *place*, not a menu — four squares of paving outside the door with
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
 * A delivery that appeared on the same four squares every day would be four
 * squares the game had reserved, which is the shop-as-furniture problem coming
 * back in through the floor. So the squares themselves move: near the door,
 * never on the way in, and never twice in the same arrangement.
 *
 * The level still lists four of them, because a level says what a kitchen has
 * — and on day one nothing is delivered to them at all, so where they stand is
 * only ever a starting point the roll takes over from.
 *
 * ## One of the four is a recipe
 *
 * A card is a good like the rest: rolled from the same stream, standing on the
 * same pallet, bought with the same `Grab`. It used to be a poster on the wall
 * with a calendar of its own — see `sim/cards.ts` for why neither survived.
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
  const recipe = offer.recipe === undefined ? null : RECIPE_BY_ID.get(offer.recipe);
  return recipe ? cardFee(recipe.tier) : applianceDef(offer.kind).price;
}

/** What the stall pays for one of these. Rounded down: the house rounds. */
export function sellPrice(kind: ApplianceKind): number {
  return Math.floor(applianceDef(kind).price * SELLBACK);
}

export function offerLabel(offer: Offer): string {
  const recipe = offer.recipe === undefined ? null : RECIPE_BY_ID.get(offer.recipe);
  if (recipe) return recipe.name;
  // "Tomato crate", "Tomato hopper": the ingredient names the offer and the
  // appliance says what it is. The second half used to be the word "crate",
  // which was true for exactly as long as one kind held a source.
  if (offer.source) {
    return `${ingredient(offer.source.base).name} ${applianceDef(offer.kind).label.toLowerCase()}`;
  }
  return applianceDef(offer.kind).label;
}

/** Is there a delivery at all this morning? Everything but the first — see `FIRST_DELIVERY_DAY`. */
export function hasDelivery(world: World): boolean {
  return world.day >= FIRST_DELIVERY_DAY;
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

/**
 * How many of this kind the kitchen owns, held ones included.
 *
 * **Fittings are counted where they sit.** A board set on a counter is not an
 * appliance in the map any more, and a count that only walked the map would
 * report a kitchen full of boards as owning none of them — so the stall would
 * promise a board every morning for ever.
 */
export function countKind(world: World, kind: ApplianceKind): number {
  let count = 0;
  for (const appliance of world.appliances.values()) {
    if (appliance.kind === kind) count++;
    if (appliance.topper === kind) count++;
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

  // Day one is delivered nothing at all: no goods, no card, and the squares
  // left where the level put them so the renderer draws no pallets either. A
  // kitchen with $0 in the till has nothing to do out here — see
  // `FIRST_DELIVERY_DAY`.
  if (!hasDelivery(world)) {
    for (const slot of slots) {
      slot.offer = null;
      slot.taken = null;
    }
    touchLayout(world);
    return;
  }

  // A stream of its own, from two numbers that cannot drift. `| 0` keeps the
  // seed in the same 32-bit shape `mulberry32` is written for.
  const random = mulberry32((world.seed * 0x9e37 + world.day * 0x85eb) | 0);
  // A square with nowhere safe to stand comes back in this set, and is left
  // bare below: see `landDelivery`.
  const stranded = landDelivery(world, slots, random);

  // Two of the four squares are spoken for: one holds a recipe, and one is
  // promised to something the kitchen is short of, so a morning is never four
  // duds. Both are *rolled*, and never the same square — a guarantee always
  // sitting in the same place stops reading as luck.
  const sold = soldKinds(world);
  const sources = unlockedIngredients(world);
  const scarce = scarceKinds(world, sold);

  // Every draw happens whether or not it is used, so the stream advances by the
  // same amount on every morning in every room. A room with an exhausted
  // library still draws its card, and still gets the same goods as one that has
  // not — randomness spent conditionally is randomness that makes two clients
  // on one seed disagree.
  const cardSlot = Math.floor(random() * slots.length);
  const promised = (cardSlot + 1 + Math.floor(random() * (slots.length - 1))) % slots.length;
  const card = rollCard(offerable(world), random);

  for (const [index, slot] of slots.entries()) {
    if (index === cardSlot && card) {
      slot.offer = { kind: "cards", source: null, recipe: card.id };
    } else {
      const guaranteed = index === promised && scarce.length > 0;
      slot.offer = rollFrom(guaranteed ? scarce : sold, random, sources);
    }
    // Rolled first and discarded second, so a square nobody can walk up to
    // costs the morning its goods rather than shifting every other square's
    // roll along by one. What two clients agree about is the stream.
    if (stranded.has(slot.id)) slot.offer = null;
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
function landDelivery(world: World, slots: Appliance[], random: () => number): Set<number> {
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
  if (spots.length < slots.length) return new Set(); // nowhere to put it: leave it be

  // Lifted off the grid before anything lands, so a square is never blocked by
  // where it used to be and the reachability check below sees only what this
  // morning has actually placed.
  for (const slot of slots) {
    world.applianceAt[tileIndex(world, slot.tile.x, slot.tile.y)] = 0;
  }

  // The paving as it is before anything lands on it, which is what every
  // placement below is held against. Taken once, and taken *here*, because a
  // band can have a pocket in it that nothing this morning did — and a rule
  // that demanded what was never true would refuse every spot.
  const wasReachable = reachableFrom(world, world.door);
  const open = new Set(
    spots
      .map((spot) => tileIndex(world, spot.x, spot.y))
      .filter((index) => wasReachable.has(index)),
  );

  // Partial Fisher-Yates: one draw per square, and the draws happen whether or
  // not they are used, so the stream advances by the same amount every morning.
  //
  // **A square may not be placed where it would strand one.** The delivery is
  // solid, so every square added is an obstacle on the paving everybody walks;
  // enough of them and a pocket of it is walled off, with goods standing in it
  // that nobody can reach — money nobody can spend, in silence, which is the one
  // way this arrangement fails.
  //
  // Asked as *reachability* rather than as spacing, and that is the whole
  // lesson. Spacing was the first two attempts: no two squares orthogonally
  // adjacent, then none touching even at the corners, on the reasoning that the
  // paving is a ring two tiles deep and a diagonal pair seals it. Both are true
  // and neither is enough, because the premise is wrong — where a building
  // reaches within one tile of the grid's edge the band beside it is *one* deep
  // and a dead end, and there two squares strand whatever is between them at any
  // spacing at all. A rule about distances cannot see that; a flood fill can.
  //
  // Enforced by *scanning* rather than by drawing again: the draw happens once
  // per square exactly as before, and what follows it is a deterministic walk
  // forward to the first spot that leaves everything reachable. A rule that
  // cannot pick a bad spot beats a rule that notices and re-rolls — the same
  // reasoning as "never on the way in" above — and it keeps the stream advancing
  // by one per square, which is what two clients agreeing depends on.
  //
  // And the question is asked of the **whole band**, not of the squares standing
  // in it. Asking only about the delivery so far let the second crate wall off
  // an arm of the paving nobody had landed on yet: legal at the time, since
  // there was nothing behind it to strand, and the squares still to come then
  // had nowhere left to go. On a kitchen whose paving is two tiles deep that is
  // not a rare morning — it was one morning in five on the beach — and it is the
  // whole delivery lost, not one square of it. So: a square may not cut off
  // paving it is not standing on.
  const stranded = new Set<number>();
  for (const [index, slot] of slots.entries()) {
    const range = spots.length - index;
    const drawn = index + Math.floor(random() * range);
    let pick = drawn;
    let safe = false;
    for (let step = 0; step < range; step++) {
      const candidate = index + ((drawn - index + step) % range);
      if (keepsReachable(world, slots, index, spots[candidate]!, open)) {
        pick = candidate;
        safe = true;
        break;
      }
    }
    // Nowhere left that keeps everything walkable-up-to. It still lands, so the
    // grid and the level agree about how many squares there are — but it lands
    // **empty**, and an empty square in a pocket nobody can reach costs nobody
    // anything. The alternative is stranding goods somebody could have bought.
    //
    // Kept as a floor rather than as an expectation: no shipped or generated
    // kitchen reaches it any more, and a level that packed a delivery tighter
    // than its paving could hold would arrive short here rather than broken.
    if (!safe) stranded.add(slot.id);
    // A whole swap, not half of one. The original only wrote the hole, which
    // was harmless while nothing read the prefix back.
    const spot = spots[pick]!;
    spots[pick] = spots[index]!;
    spots[index] = spot;
    slot.tile = { x: spot.x, y: spot.y };
    world.applianceAt[tileIndex(world, spot.x, spot.y)] = slot.id;
  }

  // One last look at the finished arrangement, because a square that had to
  // fall back can wall in one that was checked and cleared before it existed.
  // Every guarantee above is about a layout half-built; this is the only place
  // that sees the morning as the players will.
  const reachable = reachableFrom(world, world.door);
  for (const slot of slots) {
    const reached = seatsAround(world, slot.tile).some((tile) =>
      reachable.has(tileIndex(world, tile.x, tile.y)),
    );
    if (!reached) stranded.add(slot.id);
  }
  return stranded;
}

/**
 * Would putting a square here leave the band as open as it found it?
 *
 * Two things, and the second is the one that matters: every square placed so
 * far is still walkable-up-to, and every tile of the delivery band that was
 * reachable this morning still is — unless the delivery is standing on it.
 * A tile nobody can walk to is a spot the squares still to come cannot use.
 *
 * Writes the candidate onto the grid, asks, and takes it back off — the
 * cheapest way to ask a question about a layout that does not exist yet, and
 * the only state it touches is the one cell it restores.
 *
 * Measured from the **door**, because that is where everybody comes from and it
 * is the same question `data/validate.ts` asks of a level that has not been
 * opened yet. One fill per candidate tried, a handful of candidates per square,
 * once a morning.
 */
function keepsReachable(
  world: World,
  slots: Appliance[],
  placed: number,
  spot: Vec2,
  open: Set<number>,
): boolean {
  const index = tileIndex(world, spot.x, spot.y);
  world.applianceAt[index] = slots[placed]!.id;
  const reachable = reachableFrom(world, world.door);
  let ok = seatsAround(world, spot).some((tile) => reachable.has(tileIndex(world, tile.x, tile.y)));
  for (let i = 0; ok && i < placed; i++) {
    const other = slots[i]!.tile;
    ok = seatsAround(world, other).some((tile) => reachable.has(tileIndex(world, tile.x, tile.y)));
  }
  // Occupied or walked-to. Nothing but the delivery stands on these tiles —
  // anything else was filtered out of the candidates — so a full cell here is a
  // square already landed, and an empty one has to stay reachable.
  for (const tile of open) {
    if (!ok) break;
    ok = world.applianceAt[tile] !== 0 || reachable.has(tile);
  }
  world.applianceAt[index] = 0;
  return ok;
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
 * One slot's worth of stock, drawn from a pool by weight.
 *
 * The pool is walked in `APPLIANCE_KINDS` order, so the roll follows the
 * appliance table — a fixed, shared sequence. Iterating a record's keys would
 * tie the outcome to insertion order, which is stable in practice and is
 * exactly the sort of thing that has no business deciding what two different
 * clients see in a shop.
 *
 * By weight rather than uniformly, even for the promised slot.
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
  // A draw that fell off the end of the table, which only a pool that is empty
  // or weightless can do. A counter is the thing every kitchen can use.
  return withSource(pool[0] ?? "counter", random, sources);
}

/**
 * A crate is not a crate: it is a *tomato* crate, and which one is part of the
 * offer. Rolled from the ingredients **this room's** recipes start from, so a
 * kitchen can never be sold a crate of something its menu has no use for — no
 * cheese until a dish takes cheese, and tomatoes from the first morning.
 *
 * Asked of the `dispenses` column rather than of the kind by name, which is a
 * question about what a row *is*. A hopper was briefly the second row to answer
 * yes and no longer holds anything at all — it draws from the crate behind it —
 * so the column is back to one member and still the right question to ask.
 */
function withSource(kind: ApplianceKind, random: () => number, sources: string[]): Offer {
  if (!applianceDef(kind).dispenses) return { kind, source: null };
  const base = sources[Math.floor(random() * sources.length)] ?? "tomato";
  return { kind, source: { base, processes: [] } };
}
