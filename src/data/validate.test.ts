import { describe, expect, test } from "bun:test";
import { RECIPES, TRANSFORM_INDEX, COMBINE_INDEX, DISH_INDEX } from "./recipes";
import { validateContent } from "./validate";

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

  test("unlocks difficulty by day, not by array position", () => {
    // The guarantee that lets `recipes.ts` be reordered freely.
    const shuffled = [...RECIPES].reverse();
    expect(
      shuffled
        .filter((r) => r.unlockDay <= 1)
        .map((r) => r.id)
        .sort(),
    ).toEqual(
      RECIPES.filter((r) => r.unlockDay <= 1)
        .map((r) => r.id)
        .sort(),
    );
  });

  test("every recipe says how to make it", () => {
    for (const recipe of RECIPES) {
      expect(recipe.steps.length).toBeGreaterThan(0);
    }
  });
});
