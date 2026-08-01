import { describe, expect, test } from "bun:test";
import { LEVEL } from "../data/level";
import type { Customer, Motion, World } from "../sim/types";
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
    const counter = applianceAtTile(kitchen, 11, 4)!;

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

/**
 * The sound of the job being done, rather than only of it finishing.
 *
 * A chop used to be silent from the moment you started holding `Use` until the
 * dial completed, which made the tightest loop in the game feel like waiting
 * for a progress bar. The knife knocks now, and it knocks off the world's own
 * tick — which is what keeps this pure, frame-rate independent, and silent the
 * moment a kitchen is paused.
 */
describe("the sound of work being done", () => {
  test("a working appliance knocks, repeatedly, and stops when the work does", () => {
    const kitchen = world();
    const counter = applianceAtTile(kitchen, 11, 4)!;
    const watcher = listening(kitchen);

    counter.motion = "chop";
    let knocks = 0;
    for (let i = 0; i < 120; i++) {
      kitchen.tick++;
      if (watcher.listen(kitchen, [0]).includes("chop")) knocks++;
    }
    // Several times a second, and not once a frame: this is texture, and a
    // knife that fired on every tick would be a buzz.
    expect(knocks).toBeGreaterThan(4);
    expect(knocks).toBeLessThan(30);

    counter.motion = null;
    for (let i = 0; i < 60; i++) {
      kitchen.tick++;
      expect(watcher.listen(kitchen, [0])).toEqual([]);
    }
  });

  test("each kind of work has its own sound", () => {
    const kitchen = world();
    const counter = applianceAtTile(kitchen, 11, 4)!;
    const watcher = listening(kitchen);

    const heard = (motion: Motion): Set<string> => {
      counter.motion = motion;
      const sounds = new Set<string>();
      for (let i = 0; i < 120; i++) {
        kitchen.tick++;
        for (const sound of watcher.listen(kitchen, [0])) sounds.add(sound);
      }
      return sounds;
    };
    expect(heard("scrub")).toContain("scrub");
    expect(heard("fry")).toContain("sizzle");
  });
});
