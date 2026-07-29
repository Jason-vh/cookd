import { describe, expect, test } from "bun:test";
import { LEVEL } from "./data/level";
import { createWorld } from "./sim/world";
import { migrate, parseSave, restore, saveSignature, snapshot, type Save } from "./save";

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

describe("round trip", () => {
  test("a kitchen survives being written and read", () => {
    const before = world();
    before.money = 137;
    before.day = 4;
    const oven = [...before.appliances.values()].find((a) => a.kind === "oven")!;
    oven.tile = { x: 3, y: 3 };

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
  const good: Save = { schema: 2, level: LEVEL.id, appliances: [], money: 0, day: 1 };

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
    expect(target.appliances.size).toBe(1);

    const onGrid = target.applianceAt.filter((id) => id !== 0);
    expect(onGrid.length).toBe(1);
    expect(target.appliances.has(onGrid[0]!)).toBe(true);
  });

  test("an appliance out of bounds or inside a wall is dropped", () => {
    const save: Save = {
      ...good,
      appliances: [
        { kind: "oven", x: -1, y: 3 },
        { kind: "oven", x: 9999, y: 3 },
        { kind: "oven", x: 0, y: 0 }, // the level's outer wall
        { kind: "oven", x: 3, y: 3 },
      ],
    };
    const target = world();
    expect(restore(target, save)).toEqual({ ok: true });
    expect(target.appliances.size).toBe(1);
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
    };
    const migrated = migrate(v1);
    expect(migrated?.schema).toBe(2);
    expect(migrated?.level).toBe(LEVEL.id);

    const target = world();
    expect(restore(target, v1)).toEqual({ ok: true });
    expect(target.money).toBe(90);
    expect(target.day).toBe(6);
  });

  test("a save from the future is refused rather than half-understood", () => {
    const future: Save = { schema: 99, level: LEVEL.id, appliances: [], money: 0, day: 1 };
    expect(migrate(future)).toBeNull();
    expect(restore(world(), future)).toEqual({ ok: false, reason: "schema" });
  });

  test("a schema with no route forward is refused, not looped on", () => {
    const orphan: Save = { schema: 0, level: LEVEL.id, appliances: [], money: 0, day: 1 };
    expect(migrate(orphan)).toBeNull();
  });
});
