import { describe, expect, test } from "bun:test";
import {
  CHOP_FALL,
  CHOP_RAISE,
  CHOP_RECOIL,
  chopImpact,
  chopLift,
  clamp01,
  ease,
  isChefMotion,
  lerp,
  TAU,
  workPhase,
} from "./anim";

/**
 * None of this could be tested before: it lived inside `view.ts`, which touches
 * `window` at import time, so a Bun test could not even load the file. Pulling
 * the arithmetic out of the rendering is most of what made the split worth
 * doing — the chop cycle is a piecewise function with three segments whose
 * boundaries have to agree, and nothing was checking that they did.
 */

/** Phase for a given fraction through one cycle. */
function at(fraction: number): number {
  return fraction * TAU;
}

describe("the chop cycle", () => {
  test("starts on the board and reaches the top of the swing", () => {
    expect(chopLift(at(0))).toBe(0);
    expect(chopLift(at(CHOP_RAISE * 0.999))).toBeCloseTo(1, 3);
  });

  test("rises, then falls faster than it rose", () => {
    // The asymmetry *is* the animation: a symmetric lift reads as a metronome.
    const quarterUp = chopLift(at(CHOP_RAISE * 0.25));
    const quarterDown = chopLift(at(CHOP_RAISE + CHOP_FALL * 0.25));
    expect(quarterUp).toBeGreaterThan(0.4); // ease-out: most of the travel early
    expect(quarterDown).toBeGreaterThan(0.9); // ease-in: barely moved yet
    expect(CHOP_FALL).toBeLessThan(CHOP_RAISE);
  });

  test("rests on the board between strikes", () => {
    // The pause at the bottom is what makes the next strike read as a strike.
    // Sampled just past the boundary rather than exactly on it: `CHOP_RAISE +
    // CHOP_FALL` is not exactly representable, so landing on it is a coin toss
    // between the two branches. Phase is continuous in play and never asks.
    for (const f of [CHOP_RAISE + CHOP_FALL + 1e-9, 0.8, 0.99]) {
      expect(chopLift(at(f))).toBeCloseTo(0, 6);
    }
  });

  test("stays within 0..1 across a whole cycle", () => {
    for (let i = 0; i <= 200; i++) {
      const lift = chopLift(at(i / 200));
      expect(lift).toBeGreaterThanOrEqual(0);
      expect(lift).toBeLessThanOrEqual(1);
    }
  });

  test("repeats exactly, cycle after cycle", () => {
    for (const f of [0, 0.2, 0.5, 0.9]) {
      expect(chopLift(at(f + 3))).toBeCloseTo(chopLift(at(f)), 10);
    }
  });

  test("survives a negative phase", () => {
    // `%` keeps the sign of its left operand, so a negative phase would land
    // outside every branch and return 0 for a whole cycle. `workPhase` cannot
    // produce one today; a per-entity offset easily could.
    expect(chopLift(at(-0.75))).toBeCloseTo(chopLift(at(0.25)), 10);
    expect(chopImpact(at(-0.3))).toBeCloseTo(chopImpact(at(0.7)), 10);
  });
});

describe("the impact", () => {
  test("peaks where the knife lands, which is where the lift ends", () => {
    // The recoil and the food's squash both hang off this, so it has to line up
    // with the *end* of the fall, not the start of it.
    const landing = CHOP_RAISE + CHOP_FALL + 1e-9;
    expect(chopImpact(at(landing))).toBeCloseTo(1, 6);
    expect(chopLift(at(landing))).toBeCloseTo(0, 6);
  });

  test("is silent while the knife is still in the air", () => {
    expect(chopImpact(at(0))).toBe(0);
    expect(chopImpact(at(CHOP_RAISE * 0.5))).toBe(0);
    expect(chopImpact(at(CHOP_RAISE + CHOP_FALL * 0.5))).toBe(0);
  });

  test("decays to nothing before the next lift begins", () => {
    expect(chopImpact(at(CHOP_RAISE + CHOP_FALL + CHOP_RECOIL * 0.999))).toBeLessThan(0.01);
    expect(chopImpact(at(0.999))).toBe(0);
  });

  test("the three segments fit inside one cycle", () => {
    expect(CHOP_RAISE + CHOP_FALL + CHOP_RECOIL).toBeLessThanOrEqual(1);
  });
});

describe("work phase", () => {
  test("a still appliance has no phase of its own", () => {
    expect(workPhase(null, 0, 12.5)).toBe(0);
  });

  test("two appliances working together are offset", () => {
    // Otherwise a row of chefs at a row of boards is a chorus line.
    expect(workPhase("chop", 1, 4)).not.toBeCloseTo(workPhase("chop", 2, 4), 3);
  });

  test("each motion runs at its own rate", () => {
    // Baking barely moves; chopping is fast. Same time, very different phase.
    expect(Math.abs(workPhase("chop", 0, 1))).toBeGreaterThan(
      Math.abs(workPhase("bake", 0, 1)) * 5,
    );
  });
});

describe("chef motions", () => {
  test("only hand work poses a chef", () => {
    // Standing at a fryer is not an action; the appliance is doing it.
    expect(isChefMotion("chop")).toBe(true);
    expect(isChefMotion("knead")).toBe(true);
    expect(isChefMotion("mix")).toBe(true);
    expect(isChefMotion("fry")).toBe(false);
    expect(isChefMotion("bake")).toBe(false);
    expect(isChefMotion(null)).toBe(false);
    expect(isChefMotion(undefined)).toBe(false);
  });
});

describe("easing", () => {
  test("is independent of frame rate", () => {
    // The whole reason this exists. `Math.min(1, rate * dt)` \u2014 what the dials,
    // bubbles and ghosts used to use \u2014 fails this badly, and it mattered here
    // because `shouldRender` deliberately varies the frame rate.
    const rate = 8;
    // Stepped a fixed number of times rather than accumulating a float clock:
    // `for (t = 0; t < 0.5; t += 1/60)` runs 31 times, not 30, and the extra
    // step is bigger than the effect being measured.
    const converge = (fps: number, seconds: number): number => {
      const dt = 1 / fps;
      let value = 0;
      for (let i = 0; i < Math.round(seconds * fps); i++) {
        value += (1 - value) * ease(rate, dt);
      }
      return value;
    };
    // Same half second, three very different frame rates, same result.
    expect(converge(60, 0.5)).toBeCloseTo(converge(144, 0.5), 9);
    expect(converge(60, 0.5)).toBeCloseTo(converge(30, 0.5), 9);
    expect(converge(60, 0.5)).toBeCloseTo(1 - Math.exp(-rate * 0.5), 9);
  });

  test("never overshoots, however long the frame", () => {
    for (const dt of [1 / 144, 1 / 60, 0.1, 1, 10]) {
      const step = ease(9, dt);
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThanOrEqual(1);
    }
  });
});

describe("small arithmetic", () => {
  test("lerp", () => {
    expect(lerp(2, 4, 0)).toBe(2);
    expect(lerp(2, 4, 1)).toBe(4);
    expect(lerp(2, 4, 0.5)).toBe(3);
  });

  test("clamp01", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(2)).toBe(1);
  });
});
