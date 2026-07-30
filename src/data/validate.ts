import { specKey } from "../sim/items";
import type { ItemSpec } from "../sim/types";
import { APPLIANCES, APPLIANCE_KINDS, isApplianceKind } from "./appliances";
import { CUSTOMER_KINDS, DEFAULT_CUSTOMER_KIND } from "./customers";
import { STALL_SLOTS, STOCK_WEIGHT } from "./economy";
import { INGREDIENTS, PROCESSES } from "./ingredients";
import { LEVELS } from "./level";
import { BACKFILL_RECIPES, CARD_SLOTS, STARTING_RECIPES, TIER_WEIGHT } from "./progression";
import { COMBINES, RAW_INGREDIENTS, RECIPES, RECIPE_NEEDS, TRANSFORMS } from "./recipes";

/**
 * Is the content coherent?
 *
 * The four lookup indexes in `recipes.ts` are built with bare `Map.set`, so a
 * duplicated transform, a duplicated combine pair or two recipes sharing a dish
 * silently overwrite each other. A typo in a `base` is quieter still: the
 * content simply becomes unreachable, or it throws out of `ingredient()` at
 * render time, several minutes into a game, in a stack trace that says nothing
 * about the row that caused it.
 *
 * None of that is a *code* bug and none of it would be caught by types, because
 * `IngredientId` is a string. So it is checked here instead, once, and the
 * failure lands at startup pointing at the row.
 *
 * Run in development and in tests. Not in production: the content is compiled
 * in, so if it was valid when the bundle was built it is valid now, and a
 * player is not the right person to tell about it.
 */
export function validateContent(): string[] {
  const problems: string[] = [];

  const spec = (where: string, item: ItemSpec): void => {
    if (!Object.hasOwn(INGREDIENTS, item.base)) {
      problems.push(`${where}: unknown ingredient "${item.base}"`);
    }
    for (const process of item.processes) {
      if (!Object.hasOwn(PROCESSES, process)) {
        problems.push(`${where}: unknown process "${process}"`);
      }
    }
  };

  // --- transforms: one per station+input, or the later one wins silently ---
  const byInput = new Set<string>();
  for (const transform of TRANSFORMS) {
    const where = `transform ${specKey(transform.input)} -> ${specKey(transform.output)}`;
    spec(where, transform.input);
    spec(where, transform.output);
    const key = `${transform.station}|${specKey(transform.input)}`;
    if (byInput.has(key)) problems.push(`${where}: a second transform for ${key}`);
    byInput.add(key);
    if (transform.duration <= 0) problems.push(`${where}: duration must be positive`);
    if (transform.mode === "auto" && !transform.motion) {
      problems.push(`${where}: an unattended transform needs a motion to advertise itself`);
    }
    // An appliance has to exist that can actually do this work, or the content
    // is unreachable in a way no player could diagnose.
    const stations = Object.values(APPLIANCES).flatMap((def) => def.stations);
    if (!stations.includes(transform.station)) {
      problems.push(`${where}: no appliance provides the "${transform.station}" station`);
    }
  }

  // --- combines: the pair key is unordered, so a+b and b+a are one rule ---
  const byPair = new Set<string>();
  for (const combine of COMBINES) {
    const where = `combine ${specKey(combine.a)} + ${specKey(combine.b)}`;
    spec(where, combine.a);
    spec(where, combine.b);
    spec(where, combine.output);
    const [x, y] = [specKey(combine.a), specKey(combine.b)].sort();
    const key = `${x}+${y}`;
    if (byPair.has(key)) problems.push(`${where}: a second combine for the same pair`);
    byPair.add(key);
  }

  // --- recipes ---
  const byId = new Set<string>();
  const byDish = new Set<string>();
  for (const recipe of RECIPES) {
    const where = `recipe "${recipe.id}"`;
    spec(where, recipe.dish);
    if (byId.has(recipe.id)) problems.push(`${where}: duplicate id`);
    byId.add(recipe.id);
    // Two recipes wanting the same plate is not a bug the sim can resolve: it
    // looks a dish up by spec to decide what was ordered.
    const dish = specKey(recipe.dish);
    if (byDish.has(dish)) problems.push(`${where}: another recipe already wants ${dish}`);
    byDish.add(dish);
    if (recipe.steps.length === 0) problems.push(`${where}: no steps`);
    if (recipe.patience <= 0) problems.push(`${where}: patience must be positive`);
    // A tier the card stand has no weight for would be offered at weight 1 by
    // the fallback, which is a silent tuning decision nobody made.
    if (!Object.hasOwn(TIER_WEIGHT, recipe.tier)) {
      problems.push(`${where}: tier ${recipe.tier} has no weight in TIER_WEIGHT`);
    }
    // A card has to be able to *say* what it needs. An empty requirement set
    // means nothing in the content produces this dish from raw ingredients.
    const needs = RECIPE_NEEDS.get(recipe.id);
    if (!needs || needs.bases.length === 0) {
      problems.push(`${where}: no route from raw ingredients to ${specKey(recipe.dish)}`);
    }
  }
  for (const recipe of RECIPES) {
    if (recipe.prereq === undefined) continue;
    const where = `recipe "${recipe.id}"`;
    const prereq = RECIPES.find((other) => other.id === recipe.prereq);
    // A prerequisite that does not exist is a recipe the stand can never offer:
    // `offerable` asks whether it is unlocked, and nothing can unlock it.
    if (!prereq) problems.push(`${where}: unknown prereq "${recipe.prereq}"`);
    else if (prereq.id === recipe.id) problems.push(`${where}: is its own prereq`);
    else if (prereq.prereq === recipe.id) problems.push(`${where}: prereq cycle with ${prereq.id}`);
  }
  // Somebody has to be able to order on day one, and a room has to be able to
  // come back from a pre-card save with a menu.
  for (const [what, ids] of [
    ["STARTING_RECIPES", STARTING_RECIPES],
    ["BACKFILL_RECIPES", BACKFILL_RECIPES],
  ] as const) {
    if (ids.length === 0) problems.push(`${what} is empty`);
    for (const id of ids) {
      if (!byId.has(id)) problems.push(`${what}: no such recipe "${id}"`);
    }
  }

  // --- who walks in ---
  // Every dial multiplies a number the dining room already has, so zero is
  // never a tuning value: a patience of 0 is somebody who walks out on the tick
  // they order, and an appetite of 0 is a table that is never occupied.
  const kindIds = new Set<string>();
  for (const kind of CUSTOMER_KINDS) {
    const where = `customer "${kind.id}"`;
    if (kindIds.has(kind.id)) problems.push(`${where}: duplicate id`);
    kindIds.add(kind.id);
    if (kind.weight <= 0) problems.push(`${where}: weight must be positive`);
    for (const [dial, value] of Object.entries({
      patience: kind.patience,
      appetite: kind.appetite,
      generosity: kind.generosity,
      pace: kind.pace,
      build: kind.build,
    })) {
      if (value <= 0) problems.push(`${where}: ${dial} must be positive`);
    }
    // A kind with no coat cannot be dressed, and `buildCustomer` indexes into
    // the list without asking.
    if (kind.coats.length === 0) problems.push(`${where}: no coat to wear`);
  }
  // The fallback for an id we do not know — an older client, a newer server —
  // has to be somebody. Without it `customerKind` returns whatever row happens
  // to be first, which is a silent tuning decision nobody made.
  if (!kindIds.has(DEFAULT_CUSTOMER_KIND)) {
    problems.push(`no customer kind "${DEFAULT_CUSTOMER_KIND}" for unknown ids to fall back to`);
  }

  // --- the shop ---
  // A crate is sold with an ingredient in it, drawn from what the recipes
  // actually start from. An empty pool would mean a crate of nothing.
  if (STOCK_WEIGHT.crate > 0 && RAW_INGREDIENTS.length === 0) {
    problems.push("the stall sells crates, but no recipe starts from a raw ingredient");
  }
  for (const kind of APPLIANCE_KINDS) {
    // A sale hands over a *held* appliance, so anything immovable is unsellable
    // by construction — the buyer would be given something they cannot carry.
    if (STOCK_WEIGHT[kind] > 0 && !APPLIANCES[kind].movable) {
      problems.push(`stall: "${kind}" is for sale but cannot be picked up`);
    }
  }

  // --- upgrades ---
  // The `upgrades` column is a `string`, because the union it names is derived
  // from the table it sits in. These three checks are what the type would have
  // said: it points at a real kind, it does the same job, and it costs more.
  // Without the last one a card would deliver the upgrade instead of the plain
  // appliance, since delivery picks the cheapest kind that offers the station.
  for (const kind of APPLIANCE_KINDS) {
    const def = APPLIANCES[kind];
    if (def.upgrades === null) continue;
    const base = isApplianceKind(def.upgrades) ? APPLIANCES[def.upgrades] : null;
    if (!base) {
      problems.push(`appliance "${kind}": upgrades unknown kind "${def.upgrades}"`);
      continue;
    }
    if (!base.stations.some((station) => def.stations.includes(station))) {
      problems.push(`appliance "${kind}": upgrades "${def.upgrades}", which does another job`);
    }
    if (def.price <= base.price) {
      problems.push(`appliance "${kind}": costs no more than the "${def.upgrades}" it improves on`);
    }
    if (def.speed < base.speed || def.patience < base.patience) {
      problems.push(`appliance "${kind}": is worse than the "${def.upgrades}" it improves on`);
    }
  }

  // --- can each dish actually be made? ---
  const makeable = new Set<string>();
  for (const transform of TRANSFORMS) makeable.add(specKey(transform.output));
  for (const combine of COMBINES) makeable.add(specKey(combine.output));
  for (const ingredientId of Object.keys(INGREDIENTS)) makeable.add(`${ingredientId}|`);
  for (const recipe of RECIPES) {
    if (!makeable.has(specKey(recipe.dish))) {
      problems.push(`recipe "${recipe.id}": nothing produces ${specKey(recipe.dish)}`);
    }
  }

  // --- levels ---
  for (const [id, level] of Object.entries(LEVELS)) {
    if (level.id !== id) problems.push(`level "${id}": registered under a different id`);
    if (level.spawns.length === 0) problems.push(`level "${id}": no spawn points`);
    if (level.dayLength <= 0) problems.push(`level "${id}": dayLength must be positive`);
    if (!level.rows.some((row) => row.includes("D"))) {
      problems.push(`level "${id}": no door, so no customer can ever arrive`);
    }
    if (!level.rows.some((row) => row.includes("T"))) {
      problems.push(`level "${id}": no table, so no customer can ever sit`);
    }
    // Plates are finite and conserved, so the two appliances the plate economy
    // runs on are not optional scenery: without a stack there is nowhere for
    // the kitchen's plates to start, and without a sink the first six dirty
    // ones end the run.
    const tiles = level.rows.join("");
    if (!tiles.includes("P")) problems.push(`level "${id}": no plate stack, so no plates`);
    if (!tiles.includes("S")) {
      problems.push(`level "${id}": no sink, so a dirty plate can never be used again`);
    }
    const tables = tiles.split("T").length - 1;
    if (level.plates < tables) {
      problems.push(`level "${id}": ${level.plates} plates for ${tables} tables`);
    }
    // The stall is how a kitchen grows, and a kitchen that cannot grow is one
    // where money has nothing to be for. The count matters as much as the
    // presence: `STALL_SLOTS` is what the stock roll fills, so a level with
    // two `$` tiles would silently be a two-slot shop that every tuning note
    // in `data/economy.ts` describes wrongly.
    const slots = tiles.split("$").length - 1;
    if (slots !== STALL_SLOTS) {
      problems.push(`level "${id}": ${slots} stall slots, expected ${STALL_SLOTS}`);
    }
    // A stall standing where nobody can face it is a shop that does not exist.
    if (slots > 0 && !level.rows.some((row) => row.includes(","))) {
      problems.push(`level "${id}": a stall, but no patio to stand it on`);
    }
    // The card stand is the only way a menu grows, and `restockCards` fills
    // exactly the tiles the level puts down: a level with one `?` would be a
    // stand that offers no choice, which is the one thing it is for.
    const stands = tiles.split("?").length - 1;
    if (stands !== CARD_SLOTS) {
      problems.push(`level "${id}": ${stands} card stands, expected ${CARD_SLOTS}`);
    }
  }

  return problems;
}

/** Throw if the content is incoherent. Called at startup in development. */
export function assertContentValid(): void {
  const problems = validateContent();
  if (problems.length === 0) return;
  throw new Error(`cookd content is invalid:\n  - ${problems.join("\n  - ")}`);
}
