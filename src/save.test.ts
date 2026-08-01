import { describe, expect, test } from "bun:test";
import { LEVEL } from "./data/level";
import { generateLevel, seedFromCode } from "./data/generate";
import { platesInWorld } from "./sim/plates";
import { restockStall } from "./sim/shop";
import { createWorld } from "./sim/world";
import { BACKFILL_RECIPES } from "./data/progression";
import { Host } from "./game/host";
import { SCHEMA, migrate, parseSave, restore, saveSignature, snapshot, type Save } from "./save";

/**
 * A save is the one artefact in this game a player would be genuinely upset to
 * lose: it is the kitchen they designed, and there is no way to buy an
 * appliance back. So the interesting cases here are all about what happens when
 * the file is *wrong* — because the answer used to be "overwrite it".
 */

function world() {
  return createWorld(LEVEL, 0);
}

/** Every appliance as "kind at x,y", sorted — identity without ids. */
function places(target: ReturnType<typeof world>): string[] {
  return [...target.appliances.values()].map((a) => `${a.kind}@${a.tile.x},${a.tile.y}`).sort();
}

/**
 * How many of one kind a world has.
 *
 * Counting by kind rather than by total, because a restored kitchen is also
 * handed back any *essential* appliance its file has none of — see `topUp`. A
 * test about where an oven ends up should not fail because a sink turned up.
 */
function kinds(target: ReturnType<typeof world>, kind: string): number {
  return [...target.appliances.values()].filter((a) => a.kind === kind).length;
}

describe("round trip", () => {
  test("a kitchen survives being written and read", () => {
    const before = world();
    before.money = 137;
    before.day = 4;
    // The delivery outside is a function of the seed and the day, not something
    // a save carries, so a world moved to day 4 by hand has to be given day
    // four's morning — `restore` gives the other one its own.
    restockStall(before);
    // Anything the *player* moved has to come back where they left it. The
    // level's own crates are the movable thing every kitchen still ships with
    // now that the heat arrives on a card.
    const crate = [...before.appliances.values()].find((a) => a.kind === "crate")!;
    before.applianceAt[crate.tile.y * before.width + crate.tile.x] = 0;
    crate.tile = { x: 5, y: 5 };
    before.applianceAt[5 * before.width + 5] = crate.id;

    const after = world();
    expect(restore(after, snapshot(before))).toEqual({ ok: true });
    expect(after.money).toBe(137);
    expect(after.day).toBe(4);
    // Compared by kind and place, not by `saveSignature`: that includes ids,
    // which `restore` renumbers. The signature answers "has *this* world
    // changed since I last wrote it", which is the only question the server
    // asks of it — it is not an equality test between two kitchens.
    expect(places(after)).toEqual(places(before));
  });

  test("what a crate dispenses is part of the kitchen", () => {
    const before = world();
    const after = world();
    restore(after, snapshot(before));
    const crates = [...after.appliances.values()].filter((a) => a.kind === "crate");
    expect(crates.length).toBeGreaterThan(0);
    expect(crates.every((c) => c.source !== null)).toBe(true);
  });

  test("moving an appliance changes the signature; a day of cooking does not", () => {
    const first = world();
    const before = saveSignature(first);
    first.tick += 600;
    expect(saveSignature(first)).toBe(before);
    // Money is saved, so it must be in the signature. It once was not, and a
    // room could reach day five with takings in the bank and never be written
    // because nobody had moved an appliance.
    first.money += 10;
    expect(saveSignature(first)).not.toBe(before);
  });
});

describe("a file we cannot trust", () => {
  const good: Save = {
    schema: 5,
    level: LEVEL.id,
    appliances: [],
    money: 0,
    day: 1,
    plates: 6,
    stall: [],
    unlocked: ["salad"],
    unlockedDay: 0,
    evicted: false,
  };

  test("an unknown appliance kind is rejected at the door", () => {
    // This is the eviction loop: `applianceDef(kind).speed` throws inside the
    // room tick, the room is evicted, and its players reconnect — rebuilding it
    // from the same bad file, for ever.
    const save = { ...good, appliances: [{ kind: "portal", x: 1, y: 1 }] };
    expect(parseSave(save)).toBeNull();
  });

  test("non-numeric money and day are rejected", () => {
    expect(parseSave({ ...good, money: "lots" })).toBeNull();
    expect(parseSave({ ...good, day: null })).toBeNull();
    expect(parseSave({ ...good, money: NaN })).toBeNull();
  });

  test("non-integer coordinates are rejected", () => {
    expect(parseSave({ ...good, appliances: [{ kind: "oven", x: 1.5, y: 1 }] })).toBeNull();
    expect(parseSave({ ...good, appliances: [{ kind: "oven", x: Infinity, y: 1 }] })).toBeNull();
  });

  test("garbage shapes are rejected", () => {
    for (const bad of [null, [], "save", 42, {}, { ...good, appliances: "none" }]) {
      expect(parseSave(bad)).toBeNull();
    }
  });

  test("two appliances on one tile leave one on the grid, not two", () => {
    // The duplicate used to end up in `world.appliances` (so drawn, and sent in
    // every layout message) but not in `applianceAt` — a solid-looking oven
    // players walked straight through.
    const save: Save = {
      ...good,
      appliances: [
        { kind: "oven", x: 3, y: 3 },
        { kind: "fryer", x: 3, y: 3 },
      ],
    };
    const target = world();
    expect(restore(target, save)).toEqual({ ok: true });
    expect(kinds(target, "oven")).toBe(1);
    expect(kinds(target, "fryer")).toBe(0);

    // Everything restored is on the grid, essentials included: an appliance in
    // the map but not in `applianceAt` is a solid-looking phantom.
    const onGrid = target.applianceAt.filter((id) => id !== 0);
    expect(onGrid.length).toBe(target.appliances.size);
  });

  test("an appliance out of bounds or out on the paving is dropped", () => {
    const save: Save = {
      ...good,
      appliances: [
        { kind: "oven", x: -1, y: 3 },
        { kind: "oven", x: 9999, y: 3 },
        { kind: "oven", x: 1, y: 5 }, // the patio, which no build may reach
        { kind: "oven", x: 5, y: 5 },
      ],
    };
    const target = world();
    expect(restore(target, save)).toEqual({ ok: true });
    expect(kinds(target, "oven")).toBe(1);
  });

  test("a save that restores to nothing is refused, and leaves the world intact", () => {
    // The refusal has to happen *before* the world is touched. An earlier
    // version cleared the grid and then discovered the save was unusable,
    // handing the caller an empty kitchen along with a `false` it could ignore.
    const target = world();
    const appliances = target.appliances.size;
    expect(restore(target, { ...good, appliances: [] })).toEqual({ ok: false, reason: "empty" });
    expect(target.appliances.size).toBe(appliances);
  });

  test("a save from another level is refused by name, not by hash", () => {
    const target = world();
    const result = restore(target, { ...good, level: "space-station", appliances: [] });
    expect(result).toEqual({ ok: false, reason: "level" });
  });
});

describe("migration", () => {
  test("a v1 save is carried forward rather than thrown away", () => {
    // v1 identified levels by hashing the ASCII, so its `level` is a hash we can
    // no longer match. Every v1 save was written against the only level that
    // existed, and the part a player built — the appliance list — is unchanged.
    const v1: Save = {
      schema: 1,
      level: "Park Kitchen:1a2b3c",
      appliances: [{ kind: "oven", x: 3, y: 3 }],
      money: 90,
      day: 6,
      plates: 0,
      stall: [],
      unlocked: [],
      unlockedDay: 0,
      evicted: false,
    };
    const migrated = migrate(v1);
    expect(migrated?.schema).toBe(SCHEMA);
    // Named, not looked up. `LEVEL.id` is whichever kitchen ships today, and a
    // v1 save belongs to the one that existed when it was written — labelling
    // it with the current level would restore it into walls that have moved.
    expect(migrated?.level).toBe("park-kitchen");

    // Which, today, means it is refused: the patio ring gave the kitchen a new
    // id, and a save whose coordinates predate it is not one we can honour.
    // Being *carried forward* and being *usable* are different questions, and
    // the migration only answers the first.
    expect(restore(world(), v1)).toEqual({ ok: false, reason: "level" });
  });

  test("a save from the future is refused rather than half-understood", () => {
    const future: Save = {
      schema: 99,
      level: LEVEL.id,
      appliances: [],
      money: 0,
      day: 1,
      plates: 6,
      stall: [],
      unlocked: [],
      unlockedDay: 0,
      evicted: false,
    };
    expect(migrate(future)).toBeNull();
    expect(restore(world(), future)).toEqual({ ok: false, reason: "schema" });
  });

  test("a schema with no route forward is refused, not looped on", () => {
    const orphan: Save = {
      schema: 0,
      level: LEVEL.id,
      appliances: [],
      money: 0,
      day: 1,
      plates: 6,
      stall: [],
      unlocked: [],
      unlockedDay: 0,
      evicted: false,
    };
    expect(migrate(orphan)).toBeNull();
  });

  test("a v2 save is given the plates it was written before", () => {
    // Plates became finite in v3. A v2 file cannot say how many the kitchen
    // owns, and defaulting to zero would restore a kitchen that cannot plate
    // anything at all.
    const v2: Save = {
      schema: 2,
      level: LEVEL.id,
      appliances: [
        { kind: "table", x: 2, y: 2 },
        { kind: "table", x: 4, y: 2 },
        { kind: "plates", x: 3, y: 3 },
      ],
      money: 0,
      day: 1,
      plates: 0,
      stall: [],
      unlocked: [],
      unlockedDay: 0,
      evicted: false,
    };
    expect(migrate(v2)?.plates).toBe(4);
  });

  test("a v3 save has bought nothing, because there was nowhere to buy it", () => {
    const v3: Save = {
      schema: 3,
      level: LEVEL.id,
      appliances: [{ kind: "oven", x: 5, y: 5 }],
      money: 40,
      day: 2,
      plates: 4,
      stall: [],
      unlocked: [],
      unlockedDay: 0,
      evicted: false,
    };
    expect(migrate(v3)?.stall).toEqual([]);
  });

  test("a v4 save is given the menu it was played with", () => {
    // v4 predates the cards: those kitchens were played against `unlockDay`,
    // which handed out fries on day two and pizza on day three, and their
    // layouts still have the fryer and the oven standing in them. Dropping them
    // back to salad-only would be taking away a restaurant somebody built.
    const v4: Save = {
      schema: 4,
      level: LEVEL.id,
      appliances: [
        { kind: "oven", x: 5, y: 5 },
        { kind: "fryer", x: 6, y: 5 },
      ],
      money: 40,
      day: 7,
      plates: 4,
      stall: [],
      unlocked: [],
      unlockedDay: 0,
      evicted: false,
    };
    const migrated = migrate(v4);
    expect(migrated?.unlocked).toEqual(BACKFILL_RECIPES);
    // Not "unlocked today": there must be no launch-day weighting for a dish
    // this kitchen has been cooking for a week.
    expect(migrated?.unlockedDay).toBe(0);

    const target = world();
    expect(restore(target, v4)).toEqual({ ok: true });
    expect(target.unlocked).toEqual(BACKFILL_RECIPES);
    // ...and it keeps the kit it was built with, which the level no longer has.
    expect(kinds(target, "oven")).toBe(1);
    expect(kinds(target, "fryer")).toBe(1);
  });

  test("a v5 save cannot have failed to pay a rent that did not exist", () => {
    // Read the way a real one arrives: off disk, with no `evicted` key at all.
    const onDisk = {
      schema: 5,
      level: LEVEL.id,
      appliances: [{ kind: "oven", x: 5, y: 5 }],
      money: 40,
      day: 7,
      plates: 4,
      stall: [],
      unlocked: ["salad"],
      unlockedDay: 0,
    };
    const parsed = parseSave(onDisk);
    expect(parsed?.evicted).toBe(false);
    expect(parsed && migrate(parsed)?.evicted).toBe(false);
  });
});

describe("a run that ended", () => {
  test("stays ended across a save and a reload", () => {
    // A repossessed kitchen that comes back from disk able to open again is not
    // a lose condition, it is a loading screen.
    const before = world();
    before.evicted = true;
    before.money = -20;

    const after = world();
    expect(restore(after, snapshot(before))).toEqual({ ok: true });
    expect(after.evicted).toBe(true);
    // The debt comes back with it. Money is signed now.
    expect(after.money).toBe(-20);
  });

  test("is worth writing down on its own", () => {
    // Eviction changes nothing else a save records — no appliance moves, the
    // money is whatever it already was — so without this the last thing that
    // ever happens to a room is the one thing never written.
    const first = world();
    const before = saveSignature(first);
    first.evicted = true;
    expect(saveSignature(first)).not.toBe(before);
  });
});

describe("the menu is part of the run", () => {
  test("unlocks survive the round trip", () => {
    const before = world();
    before.unlocked = ["salad", "fries"];
    before.unlockedDay = 3;
    before.day = 3;

    const after = world();
    expect(restore(after, snapshot(before))).toEqual({ ok: true });
    expect(after.unlocked).toEqual(["salad", "fries"]);
    expect(after.unlockedDay).toBe(3);
  });

  test("a recipe that no longer exists is dropped on the way in", () => {
    // The menu is the order pool. A customer asking for a dish the content does
    // not describe is one nobody can ever serve, and a save is a file on disk
    // that a content change can outlive.
    const before = world();
    before.unlocked = ["salad", "souffle"];
    const after = world();
    expect(restore(after, snapshot(before))).toEqual({ ok: true });
    expect(after.unlocked).toEqual(["salad"]);
  });

  test("unlocking changes the signature, so the room is written", () => {
    // It once covered only the layout, and a room could reach day five with
    // money in the bank and never be saved. A menu is the same kind of fact.
    const target = world();
    const before = saveSignature(target);
    target.unlocked = [...target.unlocked, "fries"];
    expect(saveSignature(target)).not.toBe(before);
  });

  test("a reset keeps the menu and takes back the kitchen", () => {
    // Reset un-wrecks the layout; it does not delete history. The days spent on
    // those cards were really spent.
    const host = new Host();
    host.world.unlocked = ["salad", "fries", "pizza"];
    host.world.unlockedDay = 4;
    host.reset();
    expect(host.world.unlocked).toEqual(["salad", "fries", "pizza"]);
    expect(host.world.unlockedDay).toBe(4);
  });
});

describe("what a save is not allowed to lose", () => {
  test("the plate count survives the round trip", () => {
    const before = world();
    expect(platesInWorld(before)).toBe(LEVEL.plates);

    const after = createWorld(LEVEL, 0);
    after.appliances.clear();
    expect(restore(after, snapshot(before))).toEqual({ ok: true });
    expect(platesInWorld(after)).toBe(LEVEL.plates);
  });

  test("a save written before the sink existed is given one", () => {
    // There is no way to sell an appliance, so a kind the level provides and
    // the file does not mention means the file *predates* it. Before this, such
    // a save restored a kitchen where a dirty plate could never be used again —
    // which, with plates finite, is a room that stops working after six
    // customers and stays broken because it is written back to disk.
    const save = snapshot(world());
    const withoutSink = {
      ...save,
      appliances: save.appliances.filter((entry) => entry.kind !== "sink"),
    };

    const target = world();
    expect(restore(target, withoutSink)).toEqual({ ok: true });
    const sinks = [...target.appliances.values()].filter((a) => a.kind === "sink");
    expect(sinks.length).toBe(1);
    // ...and on the grid, not merely in the map: a phantom sink is a tile
    // players walk through and cannot use.
    expect(target.applianceAt.includes(sinks[0]!.id)).toBe(true);
  });
});

/**
 * A kitchen nobody drew has nowhere to be looked up, so the file has to carry
 * it. These are the cases that decide whether the generator can ever be
 * retuned: if a room's building comes back from `generateLevel` rather than
 * from its own save, then every edit to that function silently moves the walls
 * of every room already playing.
 */
describe("a generated kitchen", () => {
  const generated = generateLevel(seedFromCode("TACO"));

  test("is written down, because there is nothing to look it up in", () => {
    const save = snapshot(createWorld(generated, 0), generated);
    expect(save.def?.id).toBe(generated.id);
    expect(save.level).toBe(generated.id);
  });

  test("is not written down for a level the registry already has", () => {
    // The park is a pointer into a table both ends compile. A save carrying a
    // copy of it is a save that disagrees with the park the day somebody moves
    // one of its walls.
    expect(snapshot(world(), LEVEL).def).toBeUndefined();
  });

  test("comes back from its own file, not from today's generator", () => {
    const before = createWorld(generated, 0);
    before.money = 42;
    const read = parseSave(JSON.parse(JSON.stringify(snapshot(before, generated))));
    expect(read?.def).toEqual(generated);

    const def = read!.def!;
    const after = createWorld(def, 0);
    expect(restore(after, read!, def)).toEqual({ ok: true });
    expect(places(after)).toEqual(places(before));
    expect(after.money).toBe(42);
  });

  test("is refused when the building disagrees with the level it claims to be", () => {
    // Two facts about which kitchen this is, and a file where they differ is a
    // file where the coordinates below belong to neither.
    const save = snapshot(createWorld(generated, 0), generated);
    expect(parseSave({ ...save, level: "park-kitchen-3" })).toBeNull();
  });

  test("is refused when it is not a kitchen at all", () => {
    const save = snapshot(createWorld(generated, 0), generated);
    expect(
      parseSave({ ...save, def: { ...generated, size: { width: -1, height: 9 } } }),
    ).toBeNull();
    expect(parseSave({ ...save, def: { ...generated, appliances: "lots" } })).toBeNull();
  });

  test("is the same restaurant for everybody who was sent the link", () => {
    expect(generateLevel(seedFromCode("TACO"))).toEqual(generated);
    expect(generateLevel(seedFromCode("TACOS"))).not.toEqual(generated);
  });
});
