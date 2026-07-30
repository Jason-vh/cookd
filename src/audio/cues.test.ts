import { describe, expect, test } from "bun:test";
import { LEVEL } from "../data/level";
import type { Customer, World } from "../sim/types";
import { applianceAtTile, createWorld, effect } from "../sim/world";
import { SoundWatcher } from "./cues";

/**
 * What the kitchen sounds like, without a browser anywhere near it.
 *
 * This is the whole reason the decision half of the audio layer is a pure
 * module: "does a burn fire once or sixty times a second" is a question worth
 * an answer, and it is unanswerable inside an `AudioContext`.
 */

function world(): World {
  const built = createWorld(LEVEL, 2);
  built.nextArrivalIn = Infinity;
  return built;
}

/** A watcher that has already had its first look, which is always silent. */
function listening(from: World): SoundWatcher {
  const watcher = new SoundWatcher();
  watcher.listen(from, [0]);
  return watcher;
}

function seat(into: World, id: number): Customer {
  const customer: Customer = {
    id,
    kind: "regular",
    state: "arriving",
    pos: { x: 0.5, y: 0.5 },
    prevPos: { x: 0.5, y: 0.5 },
    facing: { x: 0, y: 1 },
    path: [],
    table: null,
    seat: null,
    party: 0,
    plate: null,
    recipeId: "salad",
    patience: 60,
    timer: 60,
    remaining: 60,
    tip: 0,
  };
  into.customers.push(customer);
  return customer;
}

describe("what makes a sound", () => {
  test("the first look is silent, whatever is going on", () => {
    // Joining a kitchen mid-service must not replay the day at you: a fresh
    // watcher has no idea what is new, so nothing is.
    const kitchen = world();
    seat(kitchen, 1);
    kitchen.players[0]!.carried = { id: 1, base: "tomato", processes: [], contents: [] };
    effect(kitchen, { kind: "served", playerId: 0, amount: 12 });

    expect(new SoundWatcher().listen(kitchen, [0])).toEqual([]);
  });

  test("your own hands click; the chef next to you does not", () => {
    const kitchen = world();
    const watcher = listening(kitchen);

    kitchen.players[0]!.carried = { id: 1, base: "tomato", processes: [], contents: [] };
    expect(watcher.listen(kitchen, [0])).toEqual(["pickup"]);

    kitchen.players[0]!.carried = null;
    expect(watcher.listen(kitchen, [0])).toEqual(["place"]);

    // Somebody else's chef, in the same kitchen: visible, and not audible.
    kitchen.players[1]!.carried = { id: 2, base: "lettuce", processes: [], contents: [] };
    expect(watcher.listen(kitchen, [0])).toEqual([]);
  });

  test("a burn is one sound, not one a frame", () => {
    const kitchen = world();
    const watcher = listening(kitchen);
    const counter = applianceAtTile(kitchen, 11, 5)!;

    counter.item = { id: 3, base: "pizza", processes: ["sauced", "topped", "baked"], contents: [] };
    expect(watcher.listen(kitchen, [0])).toEqual([]);

    counter.item.processes = [...counter.item.processes, "burnt"];
    expect(watcher.listen(kitchen, [0])).toEqual(["burn"]);
    expect(watcher.listen(kitchen, [0])).toEqual([]);

    // Scraped into the bin and started again: the next one is heard.
    counter.item = null;
    watcher.listen(kitchen, [0]);
    counter.item = { id: 4, base: "fries", processes: ["fried", "burnt"], contents: [] };
    expect(watcher.listen(kitchen, [0])).toEqual(["burn"]);
  });

  test("every cue the simulation announces has a sound, and gets it once", () => {
    const kitchen = world();
    const watcher = listening(kitchen);

    effect(kitchen, { kind: "served", playerId: 0, amount: 12 });
    effect(kitchen, { kind: "tipped", playerId: 0, amount: 3 });
    effect(kitchen, { kind: "binned", tile: { x: 1, y: 1 } });
    expect(watcher.listen(kitchen, [0])).toEqual(["serve", "tip", "bin"]);
    expect(watcher.listen(kitchen, [0])).toEqual([]);
  });

  test("a world whose ids start over is not silenced forever", () => {
    // A reset, or going online: the new world counts from one, and a watcher
    // holding the old high-water mark would mute the kitchen until it caught
    // up. Same failure the renderer had with popups, same fix.
    const kitchen = world();
    const watcher = listening(kitchen);
    for (let i = 0; i < 5; i++) effect(kitchen, { kind: "walkout", tile: { x: 1, y: 1 } });
    watcher.listen(kitchen, [0]);

    const fresh = world();
    effect(fresh, { kind: "served", playerId: 0, amount: 9 });
    expect(watcher.listen(fresh, [0])).toEqual(["serve"]);
  });

  test("a rush is one door chime, not three", () => {
    const kitchen = world();
    const watcher = listening(kitchen);
    seat(kitchen, 1);
    seat(kitchen, 2);
    seat(kitchen, 3);

    // Three people on the path at once is one sound: the same voice played
    // three times a millisecond apart is one loud, phased, unpleasant one.
    expect(watcher.listen(kitchen, [0])).toEqual(["arrive"]);
    expect(watcher.listen(kitchen, [0])).toEqual([]);
  });

  test("opening and closing the day are heard", () => {
    const kitchen = world();
    const watcher = listening(kitchen);

    kitchen.phase = "service";
    expect(watcher.listen(kitchen, [0])).toEqual(["open"]);
    kitchen.phase = "build";
    expect(watcher.listen(kitchen, [0])).toEqual(["close"]);
  });

  test("clearing forgets the kitchen, so the next one starts silent", () => {
    const kitchen = world();
    const watcher = listening(kitchen);
    watcher.clear();

    kitchen.players[0]!.carried = { id: 1, base: "tomato", processes: [], contents: [] };
    expect(watcher.listen(kitchen, [0])).toEqual([]);
  });
});
