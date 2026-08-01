import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA, type Save } from "../src/save";
import { LEVEL } from "../src/data/level";
import { loadSave, saveKitchen } from "./store";

/**
 * The save store, which had no tests at all — including for the atomicity it
 * exists to provide.
 *
 * `COOKD_SAVE_DIR` is read at module load, so each test file gets one directory
 * and the module is imported after it is set.
 */

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cookd-store-"));
  process.env.COOKD_SAVE_DIR = dir;
});

afterEach(() => {
  delete process.env.COOKD_SAVE_DIR;
});

function save(day: number): Save {
  return {
    schema: SCHEMA,
    level: LEVEL.id,
    appliances: [{ kind: "oven", x: 3, y: 3 }],
    money: 0,
    day,
    plates: 6,
    stall: [],
    unlocked: ["salad"],
    unlockedDay: 0,
    evicted: false,
  };
}

describe("reading", () => {
  test("a missing file is a new kitchen, not a failure", async () => {
    expect(await loadSave("NEW")).toEqual({ save: null, corrupt: false });
  });

  test("a written kitchen reads back", async () => {
    expect(await saveKitchen("ROOM", save(4))).toBe(true);
    const loaded = await loadSave("ROOM");
    expect(loaded.corrupt).toBe(false);
    expect(loaded.save?.day).toBe(4);
  });

  test("unparseable JSON is quarantined, not silently replaced", async () => {
    // This is the one that mattered: a truncated or hand-broken file used to be
    // overwritten by the next successful write, so a bug in the save format
    // destroyed the evidence of itself along with somebody's kitchen.
    await writeFile(join(dir, "BAD.json"), "{ this is not json");
    const loaded = await loadSave("BAD");
    expect(loaded).toEqual({ save: null, corrupt: true });

    const files = await readdir(dir);
    expect(files.some((f) => f.endsWith(".bad"))).toBe(true);
    expect(files.includes("BAD.json")).toBe(false);
  });

  test("valid JSON that is not a save is quarantined too", async () => {
    await writeFile(join(dir, "ODD.json"), JSON.stringify({ schema: 2, appliances: "lots" }));
    const loaded = await loadSave("ODD");
    expect(loaded).toEqual({ save: null, corrupt: true });
    expect((await readdir(dir)).some((f) => f.endsWith(".bad"))).toBe(true);
  });

  test("a room code cannot escape the save directory", async () => {
    // Codes are normalised upstream, but this is the one place a bad one would
    // become a path traversal, so it is checked again here. Whatever a hostile
    // code collapses to, it lands in this directory and nowhere else.
    for (const code of ["../../etc/passwd", "../ESCAPE", "A/../../B", "..", ""]) {
      await saveKitchen(code, save(1));
    }
    const files = await readdir(dir);
    expect(files.every((f) => /^[A-Z0-9]{1,8}\.json$/.test(f))).toBe(true);
    // Lowercase is stripped along with the separators, so the traversal above
    // has nothing left and falls back to MAIN rather than to `etcpasswd`.
    expect(files.sort()).toEqual(["AB.json", "ESCAPE.json", "MAIN.json"]);
  });
});

describe("writing", () => {
  test("concurrent writes serialise, and the last one wins", async () => {
    // The queue used to *chain*: a build phase where somebody shuffled ten
    // appliances wrote ten files one after another when only the tenth
    // mattered. Now a room holds one in-flight write and one pending save.
    const results = await Promise.all([
      saveKitchen("BUSY", save(1)),
      saveKitchen("BUSY", save(2)),
      saveKitchen("BUSY", save(3)),
      saveKitchen("BUSY", save(4)),
    ]);
    expect(results.every(Boolean)).toBe(true);

    const written: unknown = JSON.parse(await readFile(join(dir, "BUSY.json"), "utf8"));
    expect(written).toMatchObject({ day: 4 });
  });

  test("everyone waiting is told the truth about the write that happened", async () => {
    const first = saveKitchen("MANY", save(1));
    const second = saveKitchen("MANY", save(2));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
  });

  test("no temporary file is left behind", async () => {
    await saveKitchen("CLEAN", save(1));
    const files = await readdir(dir);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(files).toEqual(["CLEAN.json"]);
  });

  test("a failed write is reported rather than swallowed", async () => {
    // The directory is a file, so mkdir and rename both fail. The caller has to
    // find out: `persist` marks a room clean only on success, and it used to
    // mark it clean *before* writing.
    await writeFile(join(dir, "blocked"), "not a directory");
    process.env.COOKD_SAVE_DIR = join(dir, "blocked", "deeper");
    expect(await saveKitchen("NOPE", save(1))).toBe(false);
  });
});
