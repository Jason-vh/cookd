import type { Combine, ItemSpec, Recipe, Transform } from "../sim/types";
import { specKey } from "../sim/items";

/**
 * ---------------------------------------------------------------------------
 * CONTENT
 * ---------------------------------------------------------------------------
 * Everything below is plain data. Adding a recipe means adding rows here; no
 * engine code changes. The three lookup maps at the bottom are built once at
 * module load so the sim never scans arrays at runtime.
 */

// One row per transform, one line each: this is a table, and reading down the
// `duration` or `station` column is the point. The formatter would explode each
// row into eight lines and that reading would be gone, so it is pinned.
// prettier-ignore
export const TRANSFORMS: Transform[] = [
  // --- prep station: hold USE to work. Any counter can do this; a chopping
  // board is simply faster (see `speed` in data/appliances.ts). ------------
  { station: "prep", mode: "hold", motion: "chop", duration: 2.0, input: { base: "tomato", processes: [] }, output: { base: "tomato", processes: ["chopped"] } },
  // Chop a tomato once for salad, twice for sauce. The same ingredient
  // reaching two dishes by depth rather than by branching keeps the crate
  // count down and gives the prep station something to decide about.
  //
  // Deliberately the slowest prep step. Holding USE runs straight on into it,
  // so its duration *is* the window a player has to let go after the first chop
  // finishes — 1.7s on a board, 3s on a counter. Crushing to a sauce being
  // heavier work than a rough chop is a happy coincidence.
  { station: "prep", mode: "hold", motion: "chop", duration: 3.0, input: { base: "tomato", processes: ["chopped"] }, output: { base: "tomato", processes: ["chopped", "crushed"] } },
  { station: "prep", mode: "hold", motion: "chop", duration: 2.0, input: { base: "lettuce", processes: [] }, output: { base: "lettuce", processes: ["chopped"] } },
  { station: "prep", mode: "hold", motion: "chop", duration: 2.0, input: { base: "cheese", processes: [] }, output: { base: "cheese", processes: ["chopped"] } },
  { station: "prep", mode: "hold", motion: "chop", duration: 2.5, input: { base: "potato", processes: [] }, output: { base: "potato", processes: ["chopped"] } },
  { station: "prep", mode: "hold", motion: "knead", duration: 3.0, input: { base: "dough", processes: [] }, output: { base: "dough", processes: ["kneaded"] } },

  // --- sink: the plate economy, closed. One hold, one plate, no burning ----
  // A pile of dirty plates is a stack, and `applianceSystem` works a stack one
  // plate per cycle, so this duration is per plate rather than per pile: the
  // dial fills four times for a bussing sweep of four, and walking away costs
  // you the plate in hand, not the sweep.
  { station: "wash", mode: "hold", motion: "scrub", duration: 1.5, input: { base: "plate", processes: ["dirty"] }, output: { base: "plate", processes: [] } },

  // --- fryer / oven: run on their own, then burn ---------------------------
  { station: "fry", mode: "auto", motion: "fry", duration: 5.0, burnAfter: 6.0, input: { base: "potato", processes: ["chopped"] }, output: { base: "fries", processes: ["fried"] } },
  { station: "bake", mode: "auto", motion: "bake", duration: 8.0, burnAfter: 8.0, input: { base: "pizza", processes: ["sauced", "topped"] }, output: { base: "pizza", processes: ["sauced", "topped", "baked"] } },
];

// prettier-ignore
export const COMBINES: Combine[] = [
  // Dough is made, not found: flour + water is the first step of a pizza.
  { a: { base: "flour", processes: [] }, b: { base: "water", processes: [] }, output: { base: "dough", processes: [] } },
  { a: { base: "dough", processes: ["kneaded"] }, b: { base: "tomato", processes: ["chopped", "crushed"] }, output: { base: "pizza", processes: ["sauced"] } },
  { a: { base: "pizza", processes: ["sauced"] }, b: { base: "cheese", processes: ["chopped"] }, output: { base: "pizza", processes: ["sauced", "topped"] } },
  { a: { base: "lettuce", processes: ["chopped"] }, b: { base: "tomato", processes: ["chopped"] }, output: { base: "salad", processes: [] } },
];

/**
 * `unlockDay` is the difficulty curve, said out loud.
 *
 * It used to be the *position in this array* — `RECIPES.slice(0, 1 + day)` —
 * so sorting these rows by reward, or slipping a hard dish in beside a related
 * one, silently changed what day one looks like. `steps` moved in here for the
 * same reason: it was a separate map keyed by id, already unreferenced and
 * already free to drift, and a recipe should not be able to ship without
 * saying how it is made.
 */
// prettier-ignore
export const RECIPES: Recipe[] = [
  { id: "salad", name: "Garden Salad", dish: { base: "salad", processes: [] }, patience: 60, reward: 8, unlockDay: 1,
    steps: ["Chop lettuce", "Chop tomato", "Combine", "Plate"] },
  { id: "fries", name: "Fries", dish: { base: "fries", processes: ["fried"] }, patience: 55, reward: 6, unlockDay: 2,
    steps: ["Chop potato", "Fry", "Plate"] },
  { id: "pizza", name: "Pizza", dish: { base: "pizza", processes: ["sauced", "topped", "baked"] }, patience: 95, reward: 16, unlockDay: 3,
    steps: ["Flour + water", "Knead dough", "Chop tomato twice -> sauce", "Chop cheese -> top", "Bake", "Plate"] },
];

// --- derived lookup tables ---------------------------------------------------

/** `${station}|${itemKey}` -> Transform */
export const TRANSFORM_INDEX = new Map<string, Transform>();
for (const t of TRANSFORMS) {
  TRANSFORM_INDEX.set(`${t.station}|${specKey(t.input)}`, t);
}

/**
 * `${station}|${outputKey}` -> seconds before the finished item burns.
 * Derived from the transform that produced it, which means leaving a cooked
 * item on a hot appliance burns it even if a player put it back there.
 */
export const BURN_INDEX = new Map<string, number>();
for (const t of TRANSFORMS) {
  if (t.burnAfter !== undefined) BURN_INDEX.set(`${t.station}|${specKey(t.output)}`, t.burnAfter);
}

/** unordered pair key -> output spec */
export const COMBINE_INDEX = new Map<string, ItemSpec>();
for (const c of COMBINES) {
  COMBINE_INDEX.set(pairKey(specKey(c.a), specKey(c.b)), c.output);
}

/** Every item that counts as a servable dish. */
export const DISH_INDEX = new Map<string, Recipe>();
for (const r of RECIPES) {
  DISH_INDEX.set(specKey(r.dish), r);
}

export const RECIPE_BY_ID = new Map<string, Recipe>(RECIPES.map((r) => [r.id, r]));

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}+${b}` : `${b}+${a}`;
}
