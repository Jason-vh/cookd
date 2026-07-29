import { describe, expect, test } from "bun:test";
import {
  COMBINES,
  COMBINE_INDEX,
  DISH_INDEX,
  RAW_INGREDIENTS,
  RECIPES,
  RECIPE_NEEDS,
  TRANSFORMS,
  TRANSFORM_INDEX,
} from "./recipes";
import { specKey } from "../sim/items";
import { validateContent } from "./validate";

/** Every tier-1 recipe, by id, in a stable order. */
function tierOne(list: typeof RECIPES): string[] {
  return list
    .filter((recipe) => recipe.tier === 1)
    .map((recipe) => recipe.id)
    .sort();
}

describe("the content the game actually ships", () => {
  test("is coherent", () => {
    // If this fails it names the row. That is the entire point: a typo in a
    // `base` used to become an unreachable recipe or a throw out of
    // `ingredient()` several minutes into a game.
    expect(validateContent()).toEqual([]);
  });

  test("builds an index entry for every row", () => {
    // A silent collision in one of these is how two transforms become one.
    expect(TRANSFORM_INDEX.size).toBeGreaterThan(0);
    expect(COMBINE_INDEX.size).toBeGreaterThan(0);
    expect(DISH_INDEX.size).toBe(RECIPES.length);
  });

  test("says how hard a dish is, rather than leaving it to array position", () => {
    // The guarantee that lets `recipes.ts` be reordered freely. Difficulty was
    // the position in this array, then a day number; it is now `tier`, and
    // nothing about the offer may depend on the order of the rows.
    const shuffled = [...RECIPES].reverse();
    expect(tierOne(shuffled)).toEqual(tierOne(RECIPES));
  });

  test("knows what each dish needs, derived from its own steps", () => {
    // What a card delivers comes from here. A hand-written "fries need a fryer
    // and a potato crate" is a second opinion about the content, and it goes
    // stale the day somebody changes a step.
    expect(RECIPE_NEEDS.get("salad")).toEqual({ stations: ["prep"], bases: ["lettuce", "tomato"] });
    expect(RECIPE_NEEDS.get("fries")).toEqual({ stations: ["fry", "prep"], bases: ["potato"] });
    expect(RECIPE_NEEDS.get("bakedpotato")).toEqual({
      stations: ["bake", "prep"],
      bases: ["cheese", "potato"],
    });
    expect(RECIPE_NEEDS.get("pizza")).toEqual({
      stations: ["bake", "prep"],
      bases: ["cheese", "flour", "tomato", "water"],
    });
    // Every recipe has to have an answer, or a card could promise nothing and
    // deliver nothing while the dish stays unmakeable.
    for (const recipe of RECIPES) {
      expect(RECIPE_NEEDS.get(recipe.id)?.bases.length).toBeGreaterThan(0);
    }
  });

  test("every recipe says how to make it", () => {
    for (const recipe of RECIPES) {
      expect(recipe.steps.length).toBeGreaterThan(0);
    }
  });

  test("a crate can only hold something nothing else produces", () => {
    // The stall sells crates by rolling one of these, and it briefly offered a
    // "Dough crate" — dough being the thing the entire pizza pipeline exists to
    // make. "Used unprocessed" was not enough of a definition, because you do
    // knead dough; "and nothing makes it" is the other half.
    //
    // Compared by *spec*, not by base. The first attempt at this test compared
    // bases and excluded tomatoes, because chopping a tomato produces a tomato.
    const made = new Set([
      ...TRANSFORMS.map((t) => specKey(t.output)),
      ...COMBINES.map((c) => specKey(c.output)),
    ]);
    expect(RAW_INGREDIENTS.length).toBeGreaterThan(0);
    for (const base of RAW_INGREDIENTS) {
      expect(made.has(specKey({ base, processes: [] }))).toBe(false);
    }

    // ...and it is still the real list, not an empty one that trivially passes.
    expect(RAW_INGREDIENTS).toContain("tomato");
    expect(RAW_INGREDIENTS).toContain("flour");
    expect(RAW_INGREDIENTS).not.toContain("dough");
    expect(RAW_INGREDIENTS).not.toContain("plate");
  });
});
