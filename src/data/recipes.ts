import type { Combine, ItemSpec, Recipe, Station, Transform } from "../sim/types";
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
  // Bread is the oven's cheap dish: kneaded dough, six seconds, and a short
  // fuse. It is what makes an oven worth owning before a pizza is.
  { station: "bake", mode: "auto", motion: "bake", duration: 6.0, burnAfter: 6.0, input: { base: "dough", processes: ["kneaded"] }, output: { base: "bread", processes: ["baked"] } },
  // A potato goes in whole — the one bake with no prep in front of it, which
  // is the whole character of the dish.
  { station: "bake", mode: "auto", motion: "bake", duration: 7.0, burnAfter: 7.0, input: { base: "potato", processes: [] }, output: { base: "potato", processes: ["baked"] } },
  { station: "bake", mode: "auto", motion: "bake", duration: 7.0, burnAfter: 6.5, input: { base: "cheesybread", processes: [] }, output: { base: "cheesybread", processes: ["baked"] } },
  // The longest bake in the game, and the shortest fuse relative to it: a
  // loaded pizza is the thing you stand next to.
  { station: "bake", mode: "auto", motion: "bake", duration: 9.0, burnAfter: 7.0, input: { base: "pizza", processes: ["sauced", "topped", "loaded"] }, output: { base: "pizza", processes: ["sauced", "topped", "loaded", "baked"] } },
];

// prettier-ignore
export const COMBINES: Combine[] = [
  // Dough is made, not found: flour + water is the first step of a pizza.
  { a: { base: "flour", processes: [] }, b: { base: "water", processes: [] }, output: { base: "dough", processes: [] } },
  { a: { base: "dough", processes: ["kneaded"] }, b: { base: "tomato", processes: ["chopped", "crushed"] }, output: { base: "pizza", processes: ["sauced"] } },
  { a: { base: "pizza", processes: ["sauced"] }, b: { base: "cheese", processes: ["chopped"] }, output: { base: "pizza", processes: ["sauced", "topped"] } },
  { a: { base: "lettuce", processes: ["chopped"] }, b: { base: "tomato", processes: ["chopped"] }, output: { base: "salad", processes: [] } },
  // Dishes that build on another dish. Each one is a card with a prerequisite,
  // so the stand can never offer the second half of a pipeline first.
  { a: { base: "fries", processes: ["fried"] }, b: { base: "cheese", processes: ["chopped"] }, output: { base: "cheesefries", processes: [] } },
  { a: { base: "dough", processes: ["kneaded"] }, b: { base: "cheese", processes: ["chopped"] }, output: { base: "cheesybread", processes: [] } },
  { a: { base: "potato", processes: ["baked"] }, b: { base: "cheese", processes: ["chopped"] }, output: { base: "bakedpotato", processes: [] } },
  { a: { base: "pizza", processes: ["sauced", "topped"] }, b: { base: "cheese", processes: ["chopped"] }, output: { base: "pizza", processes: ["sauced", "topped", "loaded"] } },
];

/**
 * The library. A kitchen starts with one of these and buys the rest with days.
 *
 * `tier` is the difficulty curve, said out loud. It used to be `unlockDay` —
 * and before that, the *position in this array* — so sorting these rows by
 * reward silently changed what day one looks like. Now the day number decides
 * nothing at all: the card stand offers by tier (see `TIER_WEIGHT`), a room
 * picks, and what a kitchen can cook is the record of its own choices.
 *
 * `prereq` keeps a dish that builds on another dish's output from being
 * offered first — cheese fries before fries is a card nobody can use.
 *
 * `steps` lives here for the same reason everything else does: it was a
 * separate map keyed by id, already free to drift, and a recipe should not be
 * able to ship without saying how it is made. The card face reads it out.
 */
// prettier-ignore
export const RECIPES: Recipe[] = [
  { id: "salad", name: "Garden Salad", dish: { base: "salad", processes: [] }, patience: 60, reward: 8, tier: 1,
    steps: ["Chop lettuce", "Chop tomato", "Combine", "Plate"] },
  { id: "fries", name: "Fries", dish: { base: "fries", processes: ["fried"] }, patience: 55, reward: 6, tier: 1,
    steps: ["Chop potato", "Fry", "Plate"] },
  { id: "bread", name: "Bread", dish: { base: "bread", processes: ["baked"] }, patience: 60, reward: 7, tier: 1,
    steps: ["Flour + water", "Knead dough", "Bake", "Plate"] },
  { id: "cheesefries", name: "Cheese Fries", dish: { base: "cheesefries", processes: [] }, patience: 60, reward: 9, tier: 1, prereq: "fries",
    steps: ["Chop potato", "Fry", "Chop cheese", "Combine", "Plate"] },
  { id: "cheesybread", name: "Cheesy Bread", dish: { base: "cheesybread", processes: ["baked"] }, patience: 65, reward: 10, tier: 2,
    steps: ["Flour + water", "Knead dough", "Chop cheese", "Combine", "Bake", "Plate"] },
  { id: "bakedpotato", name: "Baked Potato", dish: { base: "bakedpotato", processes: [] }, patience: 70, reward: 10, tier: 2,
    steps: ["Bake a potato whole", "Chop cheese", "Combine", "Plate"] },
  { id: "pizza", name: "Pizza", dish: { base: "pizza", processes: ["sauced", "topped", "baked"] }, patience: 95, reward: 16, tier: 3,
    steps: ["Flour + water", "Knead dough", "Chop tomato twice -> sauce", "Chop cheese -> top", "Bake", "Plate"] },
  { id: "loadedpizza", name: "Loaded Pizza", dish: { base: "pizza", processes: ["sauced", "topped", "loaded", "baked"] }, patience: 100, reward: 22, tier: 3, prereq: "pizza",
    steps: ["Build a pizza, unbaked", "Chop cheese -> load it", "Bake", "Plate"] },
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

/**
 * The raw ingredients the recipes actually start from — what a crate may hold.
 *
 * Derived rather than listed, because a hand-kept list of "what crates exist"
 * is a second opinion about the content that goes stale the day a recipe
 * changes. Two conditions, and both are load-bearing:
 *
 *  1. it is *used* unprocessed by a transform or a combine — so an ingredient
 *     no dish touches can never be sold to anybody; and
 *  2. **nothing produces it**. Dough passes the first test (you knead it) and
 *     fails this one, because dough is flour plus water. Without the second
 *     condition the stall cheerfully offered a "Dough crate", which is a crate
 *     of the thing the entire pizza pipeline exists to make.
 *
 * Both conditions are about the *whole spec*, not the base. Keying the second
 * one on `base` alone looked equivalent and quietly excluded tomatoes: chopping
 * a tomato produces a tomato, so "something makes tomatoes" is true and
 * completely beside the point. What matters is that nothing makes an
 * **unprocessed** one.
 *
 * A plate is excluded by name: it is crockery rather than food, it is finite,
 * and it has its own way of being bought.
 */
const MADE = new Set<string>([
  ...TRANSFORMS.map((t) => specKey(t.output)),
  ...COMBINES.map((c) => specKey(c.output)),
]);

export const RAW_INGREDIENTS: string[] = [
  ...new Set(
    [...TRANSFORMS.map((t) => t.input), ...COMBINES.flatMap((c) => [c.a, c.b])]
      .filter((spec) => spec.processes.length === 0 && spec.base !== "plate")
      .filter((spec) => !MADE.has(specKey(spec)))
      .map((spec) => spec.base),
  ),
].sort();

// --- what a dish needs -------------------------------------------------------

/**
 * The equipment and the ingredients a dish cannot be made without.
 *
 * `stations` are the *kinds of work* its shortest route passes through, not
 * appliance kinds — a `bake` is an oven's problem, a `prep` is any counter's,
 * and which appliance satisfies which is `data/appliances.ts`'s business, not
 * this file's. `bases` are the raw ingredients it starts from, so a crate list
 * falls out of it.
 */
export type RecipeNeeds = {
  stations: Station[];
  bases: string[];
};

type Need = { stations: Set<Station>; bases: Set<string> };

function needCost(need: Need): number {
  return need.stations.size + need.bases.size;
}

/** Stable tie-break, so two equally cheap routes resolve the same way twice. */
function needKey(need: Need): string {
  return `${[...need.stations].sort().join(",")}|${[...need.bases].sort().join(",")}`;
}

function mergeNeeds(a: Need, b: Need): Need {
  return {
    stations: new Set([...a.stations, ...b.stations]),
    bases: new Set([...a.bases, ...b.bases]),
  };
}

/**
 * Every makeable spec, and the cheapest way to get there.
 *
 * `makeableHere` in `sim/queries.ts` runs this fixed point forwards — "given
 * these appliances, what can be cooked" — and this runs the same content the
 * other way: "given this dish, what does a kitchen have to have". It is derived
 * for the reason `RAW_INGREDIENTS` is derived. A hand-written list of what a
 * card delivers is a second opinion about the recipes, and two opinions drift
 * the day somebody adds a step.
 *
 * Cheapest by count of requirements, ties broken by name. Where a dish has two
 * routes the game has no view on which is "the" recipe, so the card promises
 * the smaller kitchen and the bigger one still works.
 *
 * Bounded by construction: a candidate only replaces an entry by being strictly
 * cheaper or strictly earlier by name, and both orderings are finite.
 */
const NEEDS = new Map<string, Need>();
for (const base of RAW_INGREDIENTS) {
  NEEDS.set(base, { stations: new Set(), bases: new Set([base]) });
}
for (let grew = true; grew;) {
  grew = false;
  const offer = (key: string, candidate: Need): void => {
    const current = NEEDS.get(key);
    if (current) {
      const difference = needCost(candidate) - needCost(current);
      if (difference > 0) return;
      if (difference === 0 && needKey(candidate) >= needKey(current)) return;
    }
    NEEDS.set(key, candidate);
    grew = true;
  };
  for (const transform of TRANSFORMS) {
    const input = NEEDS.get(specKey(transform.input));
    if (!input) continue;
    const work: Need = { stations: new Set([transform.station]), bases: new Set() };
    offer(specKey(transform.output), mergeNeeds(input, work));
  }
  for (const combine of COMBINES) {
    const a = NEEDS.get(specKey(combine.a));
    const b = NEEDS.get(specKey(combine.b));
    if (!a || !b) continue;
    offer(specKey(combine.output), mergeNeeds(a, b));
  }
}

/** What each recipe needs, by recipe id. Empty for a dish nothing can produce. */
export const RECIPE_NEEDS = new Map<string, RecipeNeeds>(
  RECIPES.map((recipe) => {
    const need = NEEDS.get(specKey(recipe.dish));
    return [
      recipe.id,
      {
        stations: [...(need?.stations ?? [])].sort(),
        bases: [...(need?.bases ?? [])].sort(),
      },
    ];
  }),
);

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}+${b}` : `${b}+${a}`;
}
