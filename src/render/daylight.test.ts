import { describe, expect, test } from "bun:test";
import type { DaylightKey } from "../data/biomes";
import { PARK } from "../data/biomes";
import { blankSky, sampleDaylight } from "./daylight";

const key = (at: number, patch: Partial<DaylightKey> = {}): DaylightKey => ({
  ...blankSky(),
  at,
  ...patch,
});

const sample = (keys: DaylightKey[], time: number) => sampleDaylight(keys, time, blankSky());

describe("sampleDaylight", () => {
  test("lands exactly on a key", () => {
    const keys = [
      key(0, { exposure: 1, sun: { color: 0, intensity: 1, azimuth: 90, elevation: 20 } }),
      key(1, { exposure: 2, sun: { color: 0, intensity: 3, azimuth: -30, elevation: 40 } }),
    ];
    expect(sample(keys, 0).exposure).toBe(1);
    expect(sample(keys, 1).sun.azimuth).toBe(-30);
  });

  test("interpolates between the keys either side", () => {
    const keys = [key(0, { exposure: 1 }), key(0.5, { exposure: 2 }), key(1, { exposure: 4 })];
    expect(sample(keys, 0.25).exposure).toBeCloseTo(1.5);
    expect(sample(keys, 0.75).exposure).toBeCloseTo(3);
  });

  test("holds at the ends rather than running off them", () => {
    // Past closing the clock goes negative, and a predicted tick can hand back
    // a fraction either side. Neither is a different time of day.
    const keys = [key(0, { exposure: 1 }), key(1, { exposure: 2 })];
    expect(sample(keys, -5).exposure).toBe(1);
    expect(sample(keys, 9).exposure).toBe(2);
  });

  test("a day with one key is that key all day", () => {
    const keys = [key(0.3, { exposure: 1.5 })];
    expect(sample(keys, 0).exposure).toBe(1.5);
    expect(sample(keys, 1).exposure).toBe(1.5);
  });

  test("mixes colour in linear light, not in sRGB", () => {
    const keys = [
      key(0, { fog: { color: 0x000000, near: 0, far: 0 } }),
      key(1, { fog: { color: 0xffffff, near: 0, far: 0 } }),
    ];
    // Half way from black to white is perceptually pale, not mid grey: an sRGB
    // mix would give 0x808080 and a sun going white-to-amber would pass through
    // khaki on the way.
    expect(sample(keys, 0.5).fog.color).toBeGreaterThan(0xb0b0b0);
  });

  test("writes into the state it is given and allocates nothing", () => {
    const state = blankSky();
    expect(sampleDaylight(PARK.daylight, 0.5, state)).toBe(state);
  });

  test("the sun climbs and then sets over a real biome's day", () => {
    // The one shape the whole feature is for. Authoring is checked separately
    // in `data/validate.ts`; this is the curve being read back.
    const noon = PARK.daylight[1]!.at;
    expect(sample(PARK.daylight, noon / 2).sun.elevation).toBeGreaterThan(
      sample(PARK.daylight, 0).sun.elevation,
    );
    expect(sample(PARK.daylight, 1).sun.elevation).toBeLessThan(
      sample(PARK.daylight, noon).sun.elevation,
    );
  });
});
