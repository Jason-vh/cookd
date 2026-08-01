import { describe, expect, test } from "bun:test";
import { generateLevel } from "./generate";
import { levelProblems } from "./validate";
import { BIOMES } from "./biomes";
import { BEACH_SHACK, PARK_KITCHEN } from "./level";
import { kitchenWalks } from "./walks";

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

/**
 * Is it a kitchen worth cooking in?
 *
 * `levelProblems` says a kitchen is *legal* — you can reach everything and the
 * day can open. It deliberately says nothing about whether the room is any
 * good, because "badly laid out" is a thing a player is allowed to do to their
 * own restaurant. That tolerance does not extend to a generator: nobody chose
 * this layout, and nobody can be blamed for it.
 *
 * So the walks are measured, against the two hand-drawn kitchens as the
 * reference. These numbers found a real fault the validator could not: the
 * prep worktop was rolled across the whole galley, which put it up to ten
 * squares from the crates against a hand-made two — a twenty-step round trip
 * per tomato, on day one, before there is any money to fix it with.
 */
describe("the walks a generated kitchen costs", () => {
  /** Both hand-drawn kitchens put a worktop two squares from the crate run. */
  const HAND_MADE_GATHER = Math.max(
    kitchenWalks(PARK_KITCHEN).gather,
    kitchenWalks(BEACH_SHACK).gather,
  );

  test("the worktop stays beside the crates", () => {
    // Chop-and-gather is the tightest loop in the game: it is walked for every
    // ingredient of every dish, so it is the one that must not be left to luck.
    const worst = Math.max(...SEEDS.map((seed) => kitchenWalks(generateLevel(seed)).gather));
    expect(HAND_MADE_GATHER).toBe(2);
    expect(worst).toBeLessThanOrEqual(HAND_MADE_GATHER * 3);
  });

  test("a typical kitchen is as much walking as a drawn one", () => {
    // Not every kitchen — the point of a seed is that some rooms are harder
    // than others, and every appliance in this loop can be picked up and moved
    // in the morning. But the middle of the distribution has to land where the
    // hand-drawn kitchens already are, or the generator is quietly playing a
    // different game.
    const totals = SEEDS.map((seed) => kitchenWalks(generateLevel(seed)).total).sort(
      (a, b) => a - b,
    );
    const median = totals[Math.floor(totals.length / 2)]!;
    expect(median).toBeGreaterThanOrEqual(kitchenWalks(BEACH_SHACK).total);
    expect(median).toBeLessThanOrEqual(kitchenWalks(PARK_KITCHEN).total);
  });
});

/**
 * The way in stays clear.
 *
 * `landDelivery` in `sim/shop.ts` already keeps the door's own line free of the
 * morning's crates, on the grounds that it is the one place something standing
 * down can shut a restaurant. A table is a bigger thing to leave in a doorway
 * than a crate, and it stands there every day rather than until somebody buys
 * it — so the generator keeps the same line for the same reason.
 */
test("nothing is stood in the doorway", () => {
  for (const seed of SEEDS) {
    const level = generateLevel(seed);
    const inTheWay = level.appliances.filter(
      (placement) => placement.at.y === level.door.y && placement.kind === "table",
    );
    expect({ seed, inTheWay }).toEqual({ seed, inTheWay: [] });
  }
});
