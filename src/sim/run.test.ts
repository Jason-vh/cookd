import { describe, expect, test } from "bun:test";
import { LEVEL } from "../data/level";
import { endDay } from "./day";
import { beatsRecord, daysPlayed, fileRun, passedRecord } from "./run";
import { createWorld, emptyLedger } from "./world";
import type { World } from "./types";

/**
 * The mark a run leaves on the room it was played in.
 *
 * The arithmetic is small and the *timing* is the whole feature: a record filed
 * one moment too early makes the closed-down card congratulate every run on
 * beating itself, and one filed too late loses the run that set it. Both are
 * invisible in review, and each of them is the entire point of the thing.
 */

function makeWorld(): World {
  return createWorld(LEVEL, 1);
}

/** Play `days` days, taking `perDay` at the door. Rent is not the subject here. */
function playDays(world: World, days: number, perDay = 0): void {
  for (let i = 0; i < days; i++) {
    world.today = emptyLedger(world.day);
    world.today.earned = perDay;
    world.money = 10_000;
    endDay(world);
  }
}

describe("how long a run lasted", () => {
  test("a kitchen nobody opened has played nothing", () => {
    // Day one is the day *in hand*, not a day survived. A room that counted it
    // would hand out a record for opening the link.
    expect(daysPlayed(makeWorld())).toBe(0);
  });

  test("counts the days that closed, in both phases", () => {
    const world = makeWorld();
    playDays(world, 3);
    expect(daysPlayed(world)).toBe(3);

    // Mid-service on day four: still three days behind it.
    world.phase = "service";
    expect(daysPlayed(world)).toBe(3);
  });
});

describe("what beats what", () => {
  test("any run beats no record at all", () => {
    const world = makeWorld();
    playDays(world, 1);
    expect(beatsRecord(world)).toBe(true);
  });

  test("except one nobody played", () => {
    // Reset twice in a row and the second reset must not wipe the first run's
    // record with a kitchen that never opened.
    const world = makeWorld();
    expect(beatsRecord(world)).toBe(false);
    expect(fileRun(world)).toBeNull();
  });

  test("days come first, and money only breaks a tie", () => {
    const world = makeWorld();
    world.best = { run: 1, days: 5, takings: 900 };

    // Further, on far less money: still the better run. Days are what the rent
    // is asking of a kitchen.
    playDays(world, 6, 10);
    expect(beatsRecord(world)).toBe(true);

    // The same depth, and now it is the takings that decide.
    world.day = 6;
    world.takings = 400;
    expect(beatsRecord(world)).toBe(false);
    world.takings = 1000;
    expect(beatsRecord(world)).toBe(true);
  });

  test("filing a run that fell short leaves the record alone", () => {
    const world = makeWorld();
    const best = { run: 1, days: 9, takings: 500 };
    world.best = best;
    world.run = 2;
    playDays(world, 4, 100);

    expect(fileRun(world)).toBe(best);
  });

  test("filing a better one names the run that set it", () => {
    const world = makeWorld();
    world.best = { run: 1, days: 2, takings: 50 };
    world.run = 3;
    playDays(world, 4, 25);

    expect(fileRun(world)).toEqual({ run: 3, days: 4, takings: 100 });
  });
});

describe("takings are what came in", () => {
  test("earnings and tips, not what is left in the till", () => {
    const world = makeWorld();
    world.today = emptyLedger(1);
    world.today.earned = 60;
    world.today.tips = 12;
    world.money = 500;
    endDay(world);

    // The till is untouched by this: a room that spent everything on a good
    // kitchen has still taken what it took.
    expect(world.takings).toBe(72);
  });

  test("accumulate across the run", () => {
    const world = makeWorld();
    playDays(world, 3, 40);
    expect(world.takings).toBe(120);
  });
});

describe("the evening the record falls", () => {
  test("is said once, on the closing that does it", () => {
    const world = makeWorld();
    world.best = { run: 1, days: 2, takings: 0 };
    world.run = 2;

    playDays(world, 2);
    expect(passedRecord(world)).toBe(false);
    playDays(world, 1);
    expect(passedRecord(world)).toBe(true);
    // And not again the next evening: it is a moment, not a state.
    playDays(world, 1);
    expect(passedRecord(world)).toBe(false);
  });

  test("a kitchen with nothing to beat says nothing", () => {
    const world = makeWorld();
    playDays(world, 4);
    expect(passedRecord(world)).toBe(false);
    expect(world.events.some((e) => e.text.includes("ever done"))).toBe(false);
  });

  test("reaches the log, where the day's other news is", () => {
    const world = makeWorld();
    world.best = { run: 1, days: 1, takings: 0 };
    world.run = 2;
    playDays(world, 2);

    expect(world.events.some((e) => e.text.includes("2 days"))).toBe(true);
  });
});
