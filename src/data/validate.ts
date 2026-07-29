import { specKey } from "../sim/items";
import type { ItemSpec } from "../sim/types";
import { APPLIANCES } from "./appliances";
import { INGREDIENTS, PROCESSES } from "./ingredients";
import { LEVELS } from "./level";
import { COMBINES, RECIPES, TRANSFORMS } from "./recipes";

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
    if (recipe.unlockDay < 1) problems.push(`${where}: unlockDay must be at least 1`);
    if (recipe.patience <= 0) problems.push(`${where}: patience must be positive`);
  }
  // Somebody has to be able to order on day one.
  if (!RECIPES.some((recipe) => recipe.unlockDay <= 1)) {
    problems.push("no recipe is available on day 1");
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
  }

  return problems;
}

/** Throw if the content is incoherent. Called at startup in development. */
export function assertContentValid(): void {
  const problems = validateContent();
  if (problems.length === 0) return;
  throw new Error(`cookd content is invalid:\n  - ${problems.join("\n  - ")}`);
}
