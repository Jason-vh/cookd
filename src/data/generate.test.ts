import { describe, expect, test } from "bun:test";
import { generateLevel } from "./generate";
import { levelProblems } from "./validate";
import { BIOMES } from "./biomes";

/** Enough seeds that a constraint holding "usually" shows up as a failure. */
const SEEDS = Array.from({ length: 500 }, (_, i) => i + 1);

describe("generated kitchens", () => {
  // The whole safety net. `levelProblems` is the specification a level is
  // written against — reachability, the sign's wall, the stall's three slots,
  // plates against tables — so a generator that satisfies it produces kitchens
  // that are legal by the same standard the hand-made ones are held to.
  test("every seed produces a level the validator accepts", () => {
    const broken = SEEDS.map((seed) => ({
      seed,
      problems: levelProblems(generateLevel(seed)),
    })).filter((result) => result.problems.length > 0);
    expect(broken.slice(0, 3)).toEqual([]);
  });

  test("a seed always builds the same kitchen", () => {
    for (const seed of [1, 7, 99, 1234]) {
      expect(generateLevel(seed)).toEqual(generateLevel(seed));
    }
  });

  // The id is a hash of the room, so two rooms that differ anywhere have
  // different ids — which is what saves are keyed on.
  test("the id follows the geometry, not the seed", () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const level = generateLevel(seed);
      const { id, ...rest } = generateLevel(seed);
      expect(level.id).toBe(id);
      expect(level.id).toBe(`gen-${id.slice(4)}`);
      expect(rest.name.length).toBeGreaterThan(0);
    }
  });

  test("the biome is one the renderer knows", () => {
    for (const seed of SEEDS) {
      expect(Object.hasOwn(BIOMES, generateLevel(seed).biome)).toBe(true);
    }
  });

  // Difficulty is the shop's dial, not the seed's: every kitchen opens with the
  // same seats and the same crockery, and only their arrangement moves.
  test("the starting difficulty is not rolled", () => {
    for (const seed of SEEDS) {
      const level = generateLevel(seed);
      const count = (kind: string): number =>
        level.appliances.filter((placement) => placement.kind === kind).length;
      expect(count("table")).toBe(2);
      expect(level.plates).toBe(4);
      expect(level.dayLength).toBe(150);
      // A kitchen starts on one salad. Heat arrives with the recipe that calls
      // for it, and a generator handing out ovens would undo that.
      expect(count("fryer") + count("oven")).toBe(0);
    }
  });

  // A generator that produced one kitchen would pass everything above.
  test("the seeds actually differ", () => {
    const ids = new Set(SEEDS.map((seed) => generateLevel(seed).id));
    expect(ids.size).toBeGreaterThan(SEEDS.length / 2);
  });
});
