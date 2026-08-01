import { APPLIANCE_KINDS, applianceDef, type ApplianceKind } from "../data/appliances";
import { ingredient } from "../data/ingredients";
import { CARD_INTERVAL, FIRST_CARD_DAY, TIER_WEIGHT } from "../data/progression";
import { RECIPE_BY_ID, RECIPE_NEEDS, RECIPES } from "../data/recipes";
import { mulberry32 } from "./random";
import type { Appliance, ItemSpec, Recipe, Station, Vec2, World } from "./types";
import { fittedDef, log, nearestFreeTile, spawnAppliance, touchLayout } from "./world";

/**
 * The menu, and the stand that grows it.
 *
 * A kitchen starts with one dish and buys the rest with *days*: on the morning
 * of day 2, and every third morning after it, two recipe cards stand on the
 * west apron beside the stall. Face one, `Grab` to lift it, `Grab` again to
 * take it. It is a choice **between** the two, not two things to collect — the
 * pair leaves together, either in somebody's hands or at open.
 *
 * ## The same three rules as the stall
 *
 * 1. **The offer is derived, not stored.** It is rolled from `(seed, day)`
 *    through its own generator, never from `random(world)`, which play has
 *    already consumed by the time anybody reaches the patio. Two clients on one
 *    seed must see one pair of cards.
 * 2. **The result is ordinary world state.** The cards live on the stand
 *    appliances and ride the layout message, so a card being taken is a layout
 *    change like an oven moving.
 * 3. **What cannot be recomputed is written down.** `world.unlocked` is the
 *    room's whole history and is saved; `world.unlockedDay` is what stops a
 *    morning offering a second card, and a reloaded room re-offering the pair
 *    it already spent.
 *
 * ## Cards deliver what they need
 *
 * Picking a recipe hands the kitchen, free, every requirement it lacks: the
 * appliance kinds and the ingredient crates. Those are **derived from the
 * recipe data** (`RECIPE_NEEDS`) rather than listed on the card, because a
 * hand-written "fries need a fryer and a potato crate" is a second opinion
 * about the content and it goes stale the day a step changes.
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

// --- the stand -----------------------------------------------------------------

/** The card stands, in a stable order: the level's `?` tiles, top to bottom. */
export function cardStands(world: World): Appliance[] {
  const stands: Appliance[] = [];
  for (const appliance of world.appliances.values()) {
    if (appliance.kind === "cards") stands.push(appliance);
  }
  // Sorted rather than trusted to insertion order, for the same reason the
  // stall's slots are: a layout arriving over the wire is whatever the server's
  // map iteration produced, and card one has to be card one on both ends.
  return stands.sort((a, b) => a.tile.y - b.tile.y || a.tile.x - b.tile.x);
}

/** Is this a morning the cards come out? Day 2, then every third: 5, 8, 11… */
export function isCardMorning(day: number): boolean {
  return day >= FIRST_CARD_DAY && (day - FIRST_CARD_DAY) % CARD_INTERVAL === 0;
}

/** Recipes that could be offered right now: locked, and with their prereq met. */
export function offerable(world: World): Recipe[] {
  return RECIPES.filter((recipe) => {
    if (isUnlocked(world, recipe.id)) return false;
    return !recipe.prereq || isUnlocked(world, recipe.prereq);
  });
}

/**
 * Put this morning's cards on the stands, or leave them bare.
 *
 * Called wherever `restockStall` is: on a world being built, on a day closing,
 * and on a save being restored. The roll is a pure function of the seed, the
 * day and the menu, so doing it again is doing it identically.
 *
 * The stands are left empty on three occasions, and they are all the same
 * sentence — *there is nothing to choose today*: it is not a card morning, the
 * room has already chosen this morning, or the library is exhausted.
 */
export function restockCards(world: World): void {
  const stands = cardStands(world);
  if (stands.length === 0) return;
  for (const stand of stands) clearCard(stand);
  // A card rides the layout message, exactly as a stall offer does, so the
  // morning's roll is a layout change. One bump covers everything this call
  // goes on to write: the server reads the version once, after the tick.
  touchLayout(world);
  if (!isCardMorning(world.day) || world.unlockedDay === world.day) return;

  // A stream of its own, from numbers that cannot drift, mixed differently from
  // the stall's so the two do not move in lockstep on the same morning.
  const random = mulberry32((world.seed * 0x2545 + world.day * 0x9e3779b1) | 0);
  const pool = offerable(world);
  // Never two cards of the same recipe: each pick is removed from the pool
  // before the next is drawn, so a one-recipe library offers one card.
  for (const stand of stands) {
    const picked = drawByTier(pool, random);
    if (!picked) return;
    pool.splice(pool.indexOf(picked), 1);
    stand.card = picked.id;
  }
}

/** One card, weighted by tier — see `TIER_WEIGHT`. */
function drawByTier(pool: Recipe[], random: () => number): Recipe | null {
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

/** Take every card off the stands, armed or not. */
export function clearCards(world: World): void {
  for (const stand of cardStands(world)) clearCard(stand);
  touchLayout(world);
}

function clearCard(stand: Appliance): void {
  stand.card = null;
  stand.armedBy = null;
  stand.armTime = 0;
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

// --- taking a card -------------------------------------------------------------

/**
 * Unlock a recipe and deliver everything the kitchen lacks for it.
 *
 * Returns false when the delivery cannot be made, having changed nothing. That
 * is the pathological case — a kitchen with no free interior tile left — and it
 * has to be **refused out loud**: quietly unlocking a dish whose oven was
 * dropped on the floor is a menu the room cannot cook and cannot diagnose.
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
  clearCards(world);
  // The unlock itself changes no tile when nothing is delivered, and the cards
  // and the menu both ride the layout. Without this a room that already owned
  // everything would unlock a dish nobody else in it could see.
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
