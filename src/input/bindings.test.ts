import { describe, expect, test } from "bun:test";
import {
  bindKey,
  boundKeys,
  chordKey,
  chordOf,
  clearKeys,
  defaultBindings,
  keyLabel,
  keysFor,
  keysLabel,
  parseBindings,
  sameBindings,
} from "./bindings";

/**
 * The bindings are the one part of the input layer that is pure data, and the
 * one part that reads *another machine's* data back out of storage. Both halves
 * are worth pinning down: a double-bound key is a chef who chops when you meant
 * to walk, and a corrupt save should cost you your keys, not your game.
 */

describe("rebinding", () => {
  test("a key moves to its new action and leaves the old one", () => {
    const bound = bindKey(defaultBindings(), { scheme: 0, action: "use" }, "KeyQ");

    expect(keysFor(bound, { scheme: 0, action: "use" })).toEqual(["KeyQ"]);
    expect(keysFor(bound, { scheme: 0, action: "grab" })).toEqual(["Space", "KeyE"]);
  });

  test("taking a key that was doing something else takes it away from it", () => {
    const bound = bindKey(defaultBindings(), { scheme: 0, action: "use" }, "KeyE");

    expect(keysFor(bound, { scheme: 0, action: "use" })).toEqual(["KeyE"]);
    // `E` was an alternate grab. One key, one job.
    expect(keysFor(bound, { scheme: 0, action: "grab" })).toEqual(["Space"]);
  });

  test("two players cannot end up sharing a key", () => {
    const bound = bindKey(defaultBindings(), { scheme: 1, action: "grab" }, "KeyE");

    expect(keysFor(bound, { scheme: 0, action: "grab" })).toEqual(["Space"]);
    expect(keysFor(bound, { scheme: 1, action: "grab" })).toEqual(["KeyE"]);
  });

  /** Opening the next day happens to the room, so it does not matter whose finger. */
  test("but they may share the actions that are not about a chef", () => {
    const bound = bindKey(defaultBindings(), { scheme: 0, action: "start" }, "Enter");

    expect(keysFor(bound, { scheme: 1, action: "start" })).toEqual(["Enter"]);
  });

  test("a shared key still comes off whatever else was using it", () => {
    const bound = bindKey(defaultBindings(), { scheme: 1, action: "menu" }, "KeyA");

    expect(keysFor(bound, { scheme: 0, action: "left" })).toEqual([]);
    expect(keysFor(bound, { scheme: 0, action: "menu" })).toEqual(["Escape"]);
  });

  test("a global key and a chef's key are different jobs", () => {
    const bound = bindKey(defaultBindings(), { scheme: "global", action: "mute" }, "KeyF");

    expect(keysFor(bound, { scheme: "global", action: "mute" })).toEqual(["KeyF"]);
    // `F` was player one's prep key, and it is not any more.
    expect(keysFor(bound, { scheme: 0, action: "use" })).toEqual(["ShiftLeft"]);
  });

  test("an action can be left with no key at all", () => {
    const bound = clearKeys(defaultBindings(), { scheme: 1, action: "menu" });

    expect(keysFor(bound, { scheme: 1, action: "menu" })).toEqual([]);
    expect(keysLabel(keysFor(bound, { scheme: 1, action: "menu" }))).toBe("\u2014");
  });

  test("the defaults are handed out as copies, not as themselves", () => {
    const first = defaultBindings();
    first.players[0]!.up = ["KeyZ"];

    expect(keysFor(defaultBindings(), { scheme: 0, action: "up" })).toEqual(["KeyW"]);
  });
});

describe("chords", () => {
  test("shift is part of the key, and round-trips", () => {
    expect(chordOf("Shift+KeyP")).toEqual({ code: "KeyP", shift: true });
    expect(chordOf("KeyP")).toEqual({ code: "KeyP", shift: false });
    expect(chordKey("KeyP", true)).toBe("Shift+KeyP");
    expect(chordKey("KeyP", false)).toBe("KeyP");
  });

  test("shift held while binding shift is just shift", () => {
    expect(chordKey("ShiftLeft", true)).toBe("ShiftLeft");
  });

  test("a chord and its plain key are different bindings", () => {
    const bindings = defaultBindings();

    expect(keysFor(bindings, { scheme: "global", action: "addPlayer" })).toEqual(["KeyP"]);
    expect(keysFor(bindings, { scheme: "global", action: "dropPlayer" })).toEqual(["Shift+KeyP"]);
  });

  test("a bound chord still claims its underlying key from the browser", () => {
    expect(boundKeys(defaultBindings()).has("KeyP")).toBe(true);
  });
});

describe("reading what was stored", () => {
  test("nonsense is the defaults", () => {
    expect(sameBindings(parseBindings(null), defaultBindings())).toBe(true);
    expect(sameBindings(parseBindings("wasd"), defaultBindings())).toBe(true);
    expect(sameBindings(parseBindings({ players: 3 }), defaultBindings())).toBe(true);
  });

  test("a round trip through storage survives", () => {
    const bound = bindKey(defaultBindings(), { scheme: 0, action: "use" }, "KeyQ");
    const stored: unknown = JSON.parse(JSON.stringify(bound));

    expect(sameBindings(parseBindings(stored), bound)).toBe(true);
  });

  test("an action the stored data has never heard of falls back on its own", () => {
    const parsed = parseBindings({ players: [{ up: ["KeyI"] }], global: {} });

    expect(keysFor(parsed, { scheme: 0, action: "up" })).toEqual(["KeyI"]);
    // Nothing was stored for `use`, so it is still what it ships as.
    expect(keysFor(parsed, { scheme: 0, action: "use" })).toEqual(["KeyF", "ShiftLeft"]);
    expect(keysFor(parsed, { scheme: "global", action: "mute" })).toEqual(["KeyM"]);
  });

  /** Storage is the one place bindings can arrive already broken. */
  test("a key stored against two actions only keeps the first", () => {
    const parsed = parseBindings({
      players: [{ up: ["KeyW"], down: ["KeyW"] }],
      global: { mute: ["KeyW"] },
    });

    expect(keysFor(parsed, { scheme: 0, action: "up" })).toEqual(["KeyW"]);
    expect(keysFor(parsed, { scheme: 0, action: "down" })).toEqual([]);
    expect(keysFor(parsed, { scheme: "global", action: "mute" })).toEqual([]);
  });

  test("two players stored on one movement key is one player's key", () => {
    const parsed = parseBindings({ players: [{ up: ["KeyW"] }, { up: ["KeyW"] }] });

    expect(keysFor(parsed, { scheme: 0, action: "up" })).toEqual(["KeyW"]);
    expect(keysFor(parsed, { scheme: 1, action: "up" })).toEqual([]);
    // ...but the defaults, which share `Esc` on purpose, survive their own parse.
    expect(sameBindings(parseBindings(defaultBindings()), defaultBindings())).toBe(true);
  });

  test("keys that are not strings are not keys", () => {
    const parsed = parseBindings({ players: [{ up: ["KeyI", 4, "", null] }] });

    expect(keysFor(parsed, { scheme: 0, action: "up" })).toEqual(["KeyI"]);
  });
});

describe("labels", () => {
  test("a key cap says what is printed on the key", () => {
    expect(keyLabel("KeyW")).toBe("W");
    expect(keyLabel("Digit4")).toBe("4");
    expect(keyLabel("ArrowLeft")).toBe("\u2190");
    expect(keyLabel("NumpadDecimal")).toBe("Num .");
    expect(keyLabel("Numpad0")).toBe("Num 0");
    expect(keyLabel("Shift+KeyP")).toBe("Shift + P");
  });

  test("alternates are one label", () => {
    expect(keysLabel(["Space", "KeyE"])).toBe("Space / E");
  });
});
