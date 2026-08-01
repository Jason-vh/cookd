import { describe, expect, test } from "bun:test";
import { PUFFS, puffAt, type PuffSpec } from "./particles";

/**
 * The curves a puff lives on.
 *
 * `particles.ts` itself imports three.js and cannot be built without a GL
 * context, but the shape of a plume is arithmetic and this is the half of it
 * that goes quietly wrong: a fade that never reaches zero leaves a hard-edged
 * disc popping out of existence, and a size curve that runs backwards makes
 * steam condense on its way up. Neither is visible in review and both are
 * obvious in play.
 */

const KINDS: [string, PuffSpec][] = Object.entries(PUFFS);

describe("a puff over its life", () => {
  for (const [name, spec] of KINDS) {
    test(`${name} arrives and leaves`, () => {
      // Born invisible and gone invisible: anything else is a disc appearing
      // or vanishing with an edge on it.
      expect(puffAt(spec, 0).alpha).toBe(0);
      expect(puffAt(spec, 1).alpha).toBeCloseTo(0, 5);
      // And visible in between, which is the assertion that would catch a fade
      // whose two halves cancelled out.
      expect(puffAt(spec, 0.3).alpha).toBeGreaterThan(0);
    });

    test(`${name} fades in faster than it fades out`, () => {
      // A puff that ramped up over the same time it ramps down spends its first
      // third invisible, which reads as a gap between the appliance and the
      // plume rather than as something leaving it.
      const peak = peakOf(spec);
      expect(peak).toBeLessThan(0.25);
      expect(puffAt(spec, peak).alpha).toBeCloseTo(spec.alpha, 5);
    });

    test(`${name} only ever spreads`, () => {
      let last = -Infinity;
      for (let t = 0; t <= 1; t += 0.02) {
        const size = puffAt(spec, t).size;
        expect(size).toBeGreaterThanOrEqual(last);
        last = size;
      }
      expect(puffAt(spec, 1).size).toBeCloseTo(spec.size[1], 5);
    });

    test(`${name} slows as it goes`, () => {
      // Rising fastest at birth is what makes a plume rather than a column:
      // the gap between two puffs closes as they climb.
      expect(puffAt(spec, 0).rise).toBeGreaterThan(puffAt(spec, 1).rise);
    });

    test(`${name} is clamped outside its own life`, () => {
      // `update` never asks for these, and the day something rounds past 1 the
      // answer should be the end of the curve rather than a negative radius.
      expect(puffAt(spec, -3)).toEqual(puffAt(spec, 0));
      expect(puffAt(spec, 4)).toEqual(puffAt(spec, 1));
    });
  }

  test("smoke and steam cannot be mistaken for each other at a glance", () => {
    // They are read against each other from across a kitchen, in peripheral
    // vision, while something else is on fire. Differing only in colour would
    // not survive that — so the whole shape of the plume differs, and this is
    // the assertion that stops a later tuning pass quietly converging them.
    expect(PUFFS.smoke.size[1]).toBeGreaterThan(PUFFS.steam.size[1] * 1.5);
    expect(PUFFS.smoke.alpha).toBeGreaterThan(PUFFS.steam.alpha * 1.4);
    expect(PUFFS.smoke.every).toBeLessThan(PUFFS.steam.every);
    expect(PUFFS.smoke.life).toBeGreaterThan(PUFFS.steam.life);
  });
});

/** Where in a puff's life it is at its most opaque. */
function peakOf(spec: PuffSpec): number {
  let best = 0;
  let peak = 0;
  for (let t = 0; t <= 1; t += 0.005) {
    const alpha = puffAt(spec, t).alpha;
    if (alpha > best) {
      best = alpha;
      peak = t;
    }
  }
  return peak;
}
