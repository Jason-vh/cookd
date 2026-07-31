import { describe, expect, test } from "bun:test";
import { jitter, wobble } from "./wobble";

/**
 * The two properties everything built on this depends on: it never wanders
 * outside the range a builder budgeted for, and it gives the same answer twice.
 * The second is not decoration — online, two clients that disagree about which
 * way a crate slat leans are two clients drawing different rooms.
 */
describe("wobble", () => {
  test("stays inside half a unit, either side of nothing", () => {
    for (let seed = 0; seed < 40; seed++) {
      for (let index = 0; index < 40; index++) {
        const value = wobble(seed, index);
        expect(value).toBeGreaterThanOrEqual(-0.5);
        expect(value).toBeLessThan(0.5);
      }
    }
  });

  test("is the same answer every time", () => {
    expect(wobble(7, 3)).toBe(wobble(7, 3));
    expect(wobble(7, 3)).not.toBe(wobble(7, 4));
    expect(wobble(7, 3)).not.toBe(wobble(8, 3));
  });

  test("does not sit on one side of the middle", () => {
    let total = 0;
    for (let index = 0; index < 500; index++) total += wobble(11, index);
    expect(Math.abs(total / 500)).toBeLessThan(0.05);
  });
});

test("jitter scales the same wobble", () => {
  const nudge = jitter(4);
  expect(nudge(2, 0.04)).toBeCloseTo(wobble(4, 2) * 0.04, 12);
  expect(Math.abs(nudge(2, 0.04))).toBeLessThanOrEqual(0.02);
});
