import { describe, expect, test } from "bun:test";
import type { PropKind, ScatterEntry } from "../data/biomes";
import { scatter, type KeepOut, type PropSpace } from "./scatter";

/**
 * Rejection sampling with a bail-out has three ways to quietly do nothing, and
 * none of them were checked while this lived behind a three.js import.
 */

/** Deterministic, so a failure is reproducible. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SPACE: Record<PropKind, PropSpace> = {
  tree: { radius: 0.55, clearance: 1.4 },
  blossom: { radius: 0.5, clearance: 1.4 },
  bush: { radius: 0.6, clearance: 1.4 },
  rock: { radius: 0.45, clearance: 1.4 },
  picnic: { radius: 1.35, clearance: 1.4 },
  flowers: { radius: 0.28, clearance: 0.6 },
  tuft: { radius: 0.14, clearance: 0.6 },
  palm: { radius: 0.5, clearance: 1.4 },
  parasol: { radius: 1, clearance: 1.4 },
  driftwood: { radius: 0.55, clearance: 1 },
};

/** The building and its paving, as the only place props may not stand. */
const KITCHEN: KeepOut = { minX: -10, maxX: 10, minZ: -5, maxZ: 5 };

function entry(kind: PropKind, count: number, min = 14, max = 26): ScatterEntry {
  return { kind, count, minDistance: min, maxDistance: max, scale: [1, 1] };
}

describe("placement", () => {
  test("nothing lands on the kitchen or its patio", () => {
    // The clearance test is the only thing stopping a tree growing through the
    // dining room.
    const placed = scatter([entry("tree", 40), entry("tuft", 120)], SPACE, [KITCHEN], seeded(1));
    expect(placed.length).toBeGreaterThan(0);
    for (const { entry: which, x, z } of placed) {
      const clearance = SPACE[which.kind].clearance;
      const clear = Math.abs(x) >= 10 + clearance || Math.abs(z) >= 5 + clearance;
      expect(clear).toBe(true);
    }
  });

  test("nothing lands on the market square either", () => {
    // The reason keep-out is a list: paving is wherever the level says it is,
    // and a tree in the middle of the market is the same bug as a tree in the
    // middle of the dining room.
    const market: KeepOut = { minX: -8, maxX: -4, minZ: 12, maxZ: 16 };
    const placed = scatter(
      [entry("tree", 60), entry("tuft", 200)],
      SPACE,
      [KITCHEN, market],
      seeded(4),
    );
    for (const { entry: which, x, z } of placed) {
      const clearance = SPACE[which.kind].clearance;
      const clear =
        x <= market.minX - clearance ||
        x >= market.maxX + clearance ||
        z <= market.minZ - clearance ||
        z >= market.maxZ + clearance;
      expect(clear).toBe(true);
    }
  });

  test("prop bases never overlap", () => {
    // Canopies are allowed to; bases are not — a bush sprouting out of a picnic
    // table breaks the illusion instantly.
    const placed = scatter(
      [entry("picnic", 6), entry("tree", 30), entry("bush", 30)],
      SPACE,
      [KITCHEN],
      seeded(7),
    );
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]!;
        const b = placed[j]!;
        const minimum = SPACE[a.entry.kind].radius + SPACE[b.entry.kind].radius;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(minimum);
      }
    }
  });

  test("props stay inside the ring their entry asks for", () => {
    const placed = scatter([entry("rock", 30, 12, 15)], SPACE, [KITCHEN], seeded(3));
    for (const { x, z } of placed) {
      const distance = Math.hypot(x, z);
      expect(distance).toBeGreaterThanOrEqual(12);
      expect(distance).toBeLessThanOrEqual(15);
    }
  });

  test("the same seed scatters the same park", () => {
    // Online this is not cosmetic: two clients drawing different scenery from
    // the same biome is a per-machine opinion about the world.
    const entries = [entry("tree", 20), entry("bush", 20), entry("tuft", 60)];
    const a = scatter(entries, SPACE, [KITCHEN], seeded(99));
    const b = scatter(entries, SPACE, [KITCHEN], seeded(99));
    expect(a).toEqual(b);
  });

  test("a different seed scatters a different park", () => {
    const entries = [entry("tree", 20)];
    const a = scatter(entries, SPACE, [KITCHEN], seeded(1));
    const b = scatter(entries, SPACE, [KITCHEN], seeded(2));
    expect(a).not.toEqual(b);
  });

  test("largest first, so the hard-to-fit props get the space", () => {
    const placed = scatter([entry("tuft", 5), entry("picnic", 3)], SPACE, [KITCHEN], seeded(5));
    const firstTuft = placed.findIndex((p) => p.entry.kind === "tuft");
    const lastPicnic = placed.map((p) => p.entry.kind).lastIndexOf("picnic");
    expect(lastPicnic).toBeLessThan(firstTuft);
  });
});

describe("when it cannot fit everything", () => {
  test("it under-delivers rather than overlapping or hanging", () => {
    // The bail-out is silent by design. Worth pinning down that it is a
    // *shortfall* and not a freeze, and that what does get placed is still
    // legal — a scatter budget that quietly halves is the failure mode here.
    const impossible = [entry("picnic", 200, 12, 14)];
    const placed = scatter(impossible, SPACE, [KITCHEN], seeded(11));

    expect(placed.length).toBeGreaterThan(0);
    expect(placed.length).toBeLessThan(200);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]!;
        const b = placed[j]!;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(2 * SPACE.picnic.radius);
      }
    }
  });

  test("an empty biome places nothing and does not throw", () => {
    expect(scatter([], SPACE, [KITCHEN], seeded(1))).toEqual([]);
    expect(scatter([entry("tree", 0)], SPACE, [KITCHEN], seeded(1))).toEqual([]);
  });
});
