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
import { reachableFrom, seatsAround } from "../sim/pathing";
import { kitchenWarnings, unreachableTables } from "../sim/queries";
import { createWorld, tileIndex } from "../sim/world";
import { at, LEVELS, PARK_KITCHEN, wall, type LevelDef } from "./level";
import { levelProblems, validateContent } from "./validate";

/** Every tier-1 recipe, by id, in a stable order. */
function tierOne(list: typeof RECIPES): string[] {
  return list
    .filter((recipe) => recipe.tier === 1)
    .map((recipe) => recipe.id)
    .sort();
}

describe("every level ships a kitchen that works", () => {
  // A level is data, and data with coordinates in it is data that can be
  // subtly wrong: a sink boxed into a corner, a table nobody can walk to, a
  // menu the room cannot cook. Each of those already has a sentence
  // (`kitchenWarnings`) that a *player* would be shown at day open, so the
  // cheapest possible test of a new level is to ask it that question.
  for (const level of Object.values(LEVELS)) {
    test(`${level.name} opens with nothing wrong with it`, () => {
      const world = createWorld(level, level.spawns.length);
      expect(kitchenWarnings(world)).toEqual([]);
      expect(unreachableTables(world)).toEqual([]);
      // Nothing a chef has to face is walled in. This is asked of the *level*
      // rather than of a running kitchen for a reason — see `levelProblems`,
      // and the note in `kitchenWarnings` about why the same question stopped
      // being asked of a room somebody has been rearranging.
      expect(levelProblems(level)).toEqual([]);
      // Every table in the open, so a level can seat the parties it will be
      // sent. One against a wall is a legitimate thing for a *player* to build
      // and a poor thing to ship.
      const reachable = reachableFrom(world, world.door);
      for (const appliance of world.appliances.values()) {
        if (appliance.kind !== "table") continue;
        const chairs = seatsAround(world, appliance.tile).filter((chair) =>
          reachable.has(tileIndex(world, chair.x, chair.y)),
        );
        expect(chairs.length).toBeGreaterThan(2);
      }
    });
  }
});

/** The park kitchen, with one thing about it made wrong. */
function broken(change: Partial<LevelDef>): string[] {
  return levelProblems({ ...PARK_KITCHEN, ...change });
}

/** The park kitchen's appliances, with its sign moved somewhere else. */
function signAt(x: number, y: number): Partial<LevelDef> {
  return {
    appliances: [...PARK_KITCHEN.appliances.filter((p) => p.kind !== "sign"), at("sign", x, y)],
  };
}

describe("a level that does not work is caught before it ships", () => {
  // A level used to be a picture, and a picture is checked by looking at it.
  // These are the checks that replaced looking, so each one is pointed at a
  // broken kitchen to prove it fires — a validator that never says no is
  // indistinguishable from no validator at all.
  test("a door that is not against a wall", () => {
    // One tile west and it is a square of patio with the shell unbroken behind
    // it. One tile in and there is no wall for it to pierce. A corner is two
    // walls and no answer.
    expect(broken({ door: { x: 1, y: 5 } })[0]).toContain("the door is not against");
    expect(broken({ door: { x: 3, y: 5 } })[0]).toContain("the door is not against");
    expect(broken({ door: { x: 2, y: 2 } })[0]).toContain("the door is not against");
  });

  test("a sign with no wall to hang on", () => {
    // One tile in off the wall and there is nothing behind it; a corner touches
    // two walls and answers neither, which is the case `edgeSeam` cannot decide.
    expect(broken(signAt(3, 4))[0]).toContain("no wall to hang on");
    expect(broken(signAt(2, 2))[0]).toContain("no wall to hang on");
    expect(levelProblems({ ...PARK_KITCHEN, ...signAt(2, 4) })).toEqual([]);
  });

  test("a building with no patio around it", () => {
    expect(broken({ room: { x: 0, y: 2, width: 18, height: 7 } })[0]).toContain("no patio");
    expect(broken({ size: { width: 20, height: 11 } })[0]).toContain("no patio");
  });

  test("a wall outside the building it divides", () => {
    expect(broken({ walls: [wall(30, 3, 30, 4)] })[0]).toContain("a wall outside the building");
    expect(broken({ walls: [wall(8, 2, 9, 4)] })[0]).toContain("a diagonal wall");
    // A run from a corner to itself covers no seams at all: a wall that was
    // meant to be there and is not.
    expect(broken({ walls: [wall(8, 2, 8, 2)] })[0]).toContain("a wall of no length");
  });

  test("two appliances on one tile, which draws one and collides with neither", () => {
    const appliances = [...PARK_KITCHEN.appliances, at("bin", 3, 3)];
    expect(broken({ appliances })[0]).toContain("two appliances on 3,3");
  });

  test("a chef spawning inside the furniture", () => {
    expect(broken({ spawns: [{ x: 11, y: 4 }] })[0]).toContain("spawns inside something");
  });

  test("a kitchen missing the things a day cannot start without", () => {
    expect(broken({ appliances: [at("table", 4, 4)] })).toEqual([
      `level "park-kitchen-3": no plate stack, so no plates`,
      `level "park-kitchen-3": no sink, so a dirty plate can never be used again`,
      `level "park-kitchen-3": 0 stall slots, expected 3`,
      `level "park-kitchen-3": 0 recipe posters, expected 2`,
      `level "park-kitchen-3": 0 signs, expected exactly 1 — no way to open the day`,
    ]);
  });

  test("more tables than the kitchen has plates to serve them on", () => {
    expect(broken({ plates: 1 })[0]).toContain("1 plates for 2 tables");
  });
});

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
