import { APPLIANCE_KINDS, applianceDef, type ApplianceKind } from "../data/appliances";
import { ingredient } from "../data/ingredients";
import { TIER_WEIGHT } from "../data/progression";
import { RECIPE_BY_ID, RECIPE_NEEDS, RECIPES } from "../data/recipes";
import type { ItemSpec, Recipe, Station, Vec2, World } from "./types";
import { fittedDef, log, nearestFreeTile, spawnAppliance, touchLayout } from "./world";

/**
 * The menu: what this kitchen may be asked for, and what it costs to widen it.
 *
 * A kitchen starts with one dish and buys the rest with **money**, from the
 * same paving the oven is sold on. One square of every morning's delivery holds
 * a recipe card; carrying it inside and putting it down is what spends it. The
 * roll and the price live here, the pallet it stands on lives in `shop.ts`, and
 * the grab that buys it lives in `systems/interaction.ts`.
 *
 * ## What this replaced
 *
 * Two cards on a stand, then two posters on the outside wall, on day 2 and
 * every third morning after. The wall was the last thing outside that existed
 * only because the game needed somewhere to put an offer — the same fault as
 * the market stall and the caravan before it — and the cadence was the calendar
 * still authoring the menu, one level up from the `unlockDay` it replaced.
 *
 * A card is a good now, and the only calendar left is "is there a delivery
 * today", which is a question about the shop.
 *
 * ## The rules it inherits from the delivery
 *
 * 1. **The offer is derived, not stored.** The card is rolled from
 *    `(seed, day)` in `restockStall`, never from `random(world)`, which play has
 *    already consumed by the time anybody reaches the patio. Two clients on one
 *    seed must be offered one card.
 * 2. **The result is ordinary world state.** It rides the layout message on its
 *    slot, so a card being bought is a layout change like an oven moving.
 * 3. **What cannot be recomputed is written down.** `world.unlocked` is the
 *    room's whole history and is saved; `world.unlockedDay` carries the launch
 *    share and stops a restored save re-running it.
 *
 * ## Cards deliver what they need
 *
 * Buying a recipe hands the kitchen, free, every requirement it lacks: the
 * appliance kinds and the ingredient crates. Those are **derived from the
 * recipe data** (`RECIPE_NEEDS`) rather than listed on the card, because a
 * hand-written "fries need a fryer and a potato crate" is a second opinion
 * about the content and it goes stale the day a step changes.
 *
 * So the fee is flat and the kit is free: a card is how a room gets its *first*
 * fryer, and the shop is where it buys the second.
 */

// --- the menu ------------------------------------------------------------------

/**
 * What this room can be asked for.
 *
 * The one answer to "what is on the menu", shared by the customers who order
 * from it, the warnings that check the kitchen against it, and the stall that
 * stocks for it. It used to be `RECIPES.filter(r => r.unlockDay <= world.day)`
 * written out in three places — three copies of a rule, and three chances to
 * miss one when the rule changed, which it just did.
 *
 * Unknown ids are dropped rather than trusted: `world.unlocked` arrives from a
 * save file and from a socket, and an order for a recipe that does not exist is
 * a customer nobody can ever serve.
 */
export function unlockedRecipes(world: World): Recipe[] {
  const menu: Recipe[] = [];
  for (const id of world.unlocked) {
    const recipe = RECIPE_BY_ID.get(id);
    if (recipe) menu.push(recipe);
  }
  return menu;
}

export function isUnlocked(world: World, id: string): boolean {
  return world.unlocked.includes(id);
}

/**
 * Raw ingredients the menu actually starts from.
 *
 * What a crate in this kitchen may hold. `RAW_INGREDIENTS` is the same question
 * asked of the *whole library* and is still the right answer for content
 * validation; a shop stocks for a restaurant, not for a cookbook.
 */
export function unlockedIngredients(world: World): string[] {
  const bases = new Set<string>();
  for (const recipe of unlockedRecipes(world)) {
    for (const base of RECIPE_NEEDS.get(recipe.id)?.bases ?? []) bases.add(base);
  }
  return [...bases].sort();
}

/**
 * Appliance kinds the menu has a use for.
 *
 * A fryer on the stall before fries exist is noise — an expensive thing to buy
 * to watch it do nothing — so the stall filters its roll through this. Kinds
 * that serve no station at all (a table, a bin, a crate) are *always* useful
 * and are not the question this asks.
 */
export function unlockedKinds(world: World): Set<ApplianceKind> {
  const stations = new Set<Station>();
  for (const recipe of unlockedRecipes(world)) {
    for (const station of RECIPE_NEEDS.get(recipe.id)?.stations ?? []) stations.add(station);
  }
  const kinds = new Set<ApplianceKind>();
  for (const kind of APPLIANCE_KINDS) {
    const serves = applianceDef(kind).stations;
    if (serves.length === 0 || serves.some((station) => stations.has(station))) kinds.add(kind);
  }
  return kinds;
}

/**
 * Adopt a set of unlocks wholesale, keeping only recipes that exist.
 *
 * Used by a restored save and by a reset — the two places a world is handed a
 * menu it did not earn during play. Both the stall and the stand roll *against*
 * the menu, so a caller must restock after this; it does not do so itself,
 * because `sim/shop.ts` reads the menu and a module cannot be both above and
 * below another one.
 */
export function setUnlocked(world: World, ids: string[], day: number): void {
  const seen = new Set<string>();
  world.unlocked = ids.filter((id) => RECIPE_BY_ID.has(id) && !seen.has(id) && seen.add(id));
  world.unlockedDay = day;
}

// --- the morning's card --------------------------------------------------------

/** Recipes that could be offered right now: locked, and with their prereq met. */
export function offerable(world: World): Recipe[] {
  return RECIPES.filter((recipe) => {
    if (isUnlocked(world, recipe.id)) return false;
    return !recipe.prereq || isUnlocked(world, recipe.prereq);
  });
}

/**
 * One card, weighted by tier — see `TIER_WEIGHT`.
 *
 * Null only when there is genuinely nothing left to offer, which is a room that
 * has bought the whole library. The morning then holds four goods instead of
 * three, and nothing anywhere has to say so.
 *
 * The stream is the delivery's own: a card is one of the four squares, so it is
 * one event with the rest of the morning rather than a second roll to keep in
 * step.
 */
export function rollCard(pool: Recipe[], random: () => number): Recipe | null {
  let total = 0;
  for (const recipe of pool) total += TIER_WEIGHT[recipe.tier] ?? 1;
  if (total <= 0) return null;
  let roll = random() * total;
  for (const recipe of pool) {
    roll -= TIER_WEIGHT[recipe.tier] ?? 1;
    if (roll < 0) return recipe;
  }
  return pool.at(-1) ?? null;
}

// --- what a card costs the world to honour ------------------------------------

/**
 * The appliance kind that answers for a station, or null when any kitchen
 * already has one covered.
 *
 * Derived by asking the appliance table rather than by naming ovens and fryers
 * here: the cheapest movable appliance that offers the station is the one a
 * card delivers, so "the dedicated appliance for `bake`" stays a fact about
 * `data/appliances.ts` even after somebody adds a hob.
 *
 * Fittings are skipped. A delivery is set down on a **tile** (see `deliver`),
 * and a board has no tile — it goes on a counter, which is a thing somebody has
 * to already own. The counter is what answers for `prep` anyway, and it is
 * cheaper, so this only guards against a future fitting that undercuts its host.
 */
function applianceForStation(station: Station): ApplianceKind | null {
  let best: ApplianceKind | null = null;
  for (const kind of APPLIANCE_KINDS) {
    const def = applianceDef(kind);
    if (!def.movable || def.fitting || !def.stations.includes(station)) continue;
    if (best === null || def.price < applianceDef(best).price) best = kind;
  }
  return best;
}

export type Delivery = { kinds: ApplianceKind[]; crates: string[] };

/**
 * What this kitchen would have to be given before it could cook this dish.
 *
 * Asked of the *world*, so a kitchen that already owns an oven is not sent a
 * second one, and a kitchen that sold its board still counts as able to prep
 * because every counter can. Stations are answered by "does anything here offer
 * it", not by "does the dedicated appliance stand here" — that is the same rule
 * the transforms themselves run on.
 */
export function missingFor(world: World, recipe: Recipe): Delivery {
  const needs = RECIPE_NEEDS.get(recipe.id);
  const stations = new Set<Station>();
  const bases = new Set<string>();
  for (const appliance of world.appliances.values()) {
    for (const station of fittedDef(appliance).stations) stations.add(station);
    if (appliance.source && appliance.source.processes.length === 0) {
      bases.add(appliance.source.base);
    }
  }

  const kinds: ApplianceKind[] = [];
  for (const station of needs?.stations ?? []) {
    if (stations.has(station)) continue;
    const kind = applianceForStation(station);
    // Delivered kinds count as present for the rest of this delivery, so a
    // recipe wanting two of the same station is not sent two ovens.
    if (kind && !kinds.includes(kind)) kinds.push(kind);
    stations.add(station);
  }
  const crates = (needs?.bases ?? []).filter((base) => !bases.has(base));
  return { kinds, crates };
}

/** "needs: fryer, potato crate" — the second half of a card's face. */
export function deliveryLabel(delivery: Delivery): string {
  const parts = [
    ...delivery.kinds.map((kind) => applianceDef(kind).label.toLowerCase()),
    ...delivery.crates.map((base) => `${ingredient(base).name.toLowerCase()} crate`),
  ];
  return parts.join(", ");
}

// --- setting a card down -------------------------------------------------------

/**
 * Unlock a recipe and deliver everything the kitchen lacks for it.
 *
 * Returns false when the delivery cannot be made, having changed nothing. That
 * is the pathological case — a kitchen with no free interior tile left — and it
 * has to be **refused out loud**: quietly unlocking a dish whose oven was
 * dropped on the floor is a menu the room cannot cook and cannot diagnose.
 *
 * A refusal leaves the card **in the buyer's hands**, which is where the money
 * still is: the pallet it came from will take it back at full price all
 * morning. The old stand refused after the choice was spent; this refuses
 * before, because a card is a thing you are carrying until you put it down.
 *
 * Everything is logged, by name. Money is one shared number and the menu is one
 * shared list; the log is the only honest account of who changed either.
 */
export function unlockRecipe(world: World, recipe: Recipe, chooser: string, from: Vec2): boolean {
  const delivery = missingFor(world, recipe);
  const total = delivery.kinds.length + delivery.crates.length;
  if (total > 0 && countFreeTiles(world, total) < total) {
    log(world, `No room for the ${deliveryLabel(delivery)} — clear a tile first`);
    return false;
  }

  world.unlocked.push(recipe.id);
  world.unlockedDay = world.day;
  log(world, `${chooser} added ${recipe.name} to the menu`);

  for (const kind of delivery.kinds) deliver(world, kind, null, from);
  for (const base of delivery.crates) {
    deliver(world, "crate", { base, processes: [] }, from);
  }
  // The unlock itself changes no tile when nothing is delivered, and the menu
  // rides the layout. Without this a room that already owned everything would
  // unlock a dish nobody else in it could see.
  touchLayout(world);
  return true;
}

/** One delivered appliance, on the nearest free interior tile, said out loud. */
function deliver(world: World, kind: ApplianceKind, source: ItemSpec | null, from: Vec2): void {
  const tile = nearestFreeTile(world, from);
  if (!tile) return; // guarded against above; a delivery is never dropped silently
  spawnAppliance(world, kind, tile, source);
  const label = source ? `${ingredient(source.base).name} crate` : applianceDef(kind).label;
  log(world, `Delivered: ${label}`);
}

/** Are there at least `wanted` free interior tiles? Stops counting once there are. */
function countFreeTiles(world: World, wanted: number): number {
  let free = 0;
  for (let y = 0; y < world.height && free < wanted; y++) {
    for (let x = 0; x < world.width && free < wanted; x++) {
      const tile = world.tiles[y * world.width + x];
      if (!tile?.placeable || tile.door) continue;
      if ((world.applianceAt[y * world.width + x] ?? 0) === 0) free++;
    }
  }
  return free;
}
