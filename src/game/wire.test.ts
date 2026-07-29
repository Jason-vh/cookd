import { describe, expect, test } from "bun:test";
import { LEVEL } from "../data/level";
import { Host } from "./host";
import { encodeFrame, encodeLayout, PROTOCOL_VERSION } from "./protocol";
import { decode, parseClientMessage, parseInput, parseServerMessage } from "./wire";

/**
 * The edge of trust, tested from the outside.
 *
 * Every case here is something that used to be accepted, and most of them are
 * something that used to be accepted *and then ruin a room for everybody in it*.
 */

const INPUT = { move: { x: 0, y: 0 }, grab: false, use: false, start: false, menu: false };

function inputMessage(input: unknown): string {
  return JSON.stringify({ t: "input", seq: 1, inputs: { 0: input } });
}

/**
 * A complete, honest layout holding one appliance.
 *
 * Spelled out rather than hand-written per test, so a test about a bad
 * *coordinate* cannot start passing because the message is missing an unrelated
 * field — which is exactly what happened when the menu joined the layout.
 */
function layoutWith(kind: string, x: number, y: number) {
  return {
    appliances: [{ id: 1, kind, x, y, source: null, offer: null, taken: null, card: null }],
    unlocked: ["salad"],
    unlockedDay: 0,
  };
}

describe("input is parsed, not trusted", () => {
  test("NaN never reaches the simulation", () => {
    // The original blocker. NaN slips past `movementSystem`'s deadzone (every
    // comparison against NaN is false), becomes the chef's position, survives
    // `clamp` for the same reason, and is then pushed into everyone nearby by
    // `separatePlayers`. One message, whole room, permanently.
    expect(parseInput({ ...INPUT, move: { x: NaN, y: 0 } })).toBeNull();
    expect(parseInput({ ...INPUT, move: { x: 0, y: NaN } })).toBeNull();
  });

  test("infinities never reach the simulation", () => {
    expect(parseInput({ ...INPUT, move: { x: Infinity, y: 0 } })).toBeNull();
    expect(parseInput({ ...INPUT, move: { x: 0, y: -Infinity } })).toBeNull();
    // An overflowing literal is how an infinity arrives over JSON, which has no
    // syntax for one. Spliced into the string rather than written in source,
    // because writing it is itself a lint error — the rule doing its job.
    const overflowing = inputMessage(INPUT).replace('"x":0', '"x":1e999');
    expect(decode(overflowing, parseClientMessage)).toBeNull();
  });

  test("a missing or wrongly typed move is rejected rather than dereferenced", () => {
    // `input.move.x` on any of these threw *inside the room tick*, which
    // evicted the room — taking out the seven people who sent nothing.
    for (const move of [null, undefined, 7, "up", [], true]) {
      expect(parseInput({ ...INPUT, move })).toBeNull();
    }
  });

  test("buttons must be booleans", () => {
    for (const grab of [1, "true", null, {}]) {
      expect(parseInput({ ...INPUT, grab })).toBeNull();
    }
  });

  test("an over-long stick vector is normalised, not rejected", () => {
    // A legitimate client can produce this; it is not an attack, it is a
    // controller. The sim normalises too — this is belt and braces, and the
    // sim's copy is about feel rather than safety.
    const parsed = parseInput({ ...INPUT, move: { x: 3, y: 4 } });
    expect(parsed).not.toBeNull();
    expect(Math.hypot(parsed!.move.x, parsed!.move.y)).toBeCloseTo(1, 6);
  });

  test("an honest input survives unchanged", () => {
    const parsed = parseInput({ ...INPUT, move: { x: 0.5, y: -0.25 }, grab: true });
    expect(parsed).toEqual({ ...INPUT, move: { x: 0.5, y: -0.25 }, grab: true });
  });
});

describe("client messages", () => {
  test("non-string hello fields are rejected, not coerced", () => {
    // `sanitiseName(42)` threw `raw.trim is not a function` inside an async
    // websocket handler, i.e. as an unhandled rejection rather than a refusal.
    const base = {
      t: "hello" as const,
      version: PROTOCOL_VERSION,
      room: "R",
      name: "n",
      players: 1,
      token: "",
    };
    expect(parseClientMessage({ ...base, room: 7 })).toBeNull();
    expect(parseClientMessage({ ...base, name: null })).toBeNull();
    expect(parseClientMessage({ ...base, token: 12 })).toBeNull();
    // `players: "x"` produced NaN, the seat loop never ran, and the player was
    // told "Kitchen is full" for a malformed field.
    expect(parseClientMessage({ ...base, players: "x" })).toBeNull();
    expect(parseClientMessage({ ...base, players: 0 })).toBeNull();
    expect(parseClientMessage({ ...base, players: 99 })).toBeNull();
    expect(parseClientMessage(base)).toEqual(base);
  });

  test("unknown and malformed messages are dropped", () => {
    expect(decode("not json", parseClientMessage)).toBeNull();
    expect(decode("[]", parseClientMessage)).toBeNull();
    expect(decode('"hello"', parseClientMessage)).toBeNull();
    expect(decode(null, parseClientMessage)).toBeNull();
    expect(parseClientMessage({ t: "sudo" })).toBeNull();
    expect(parseClientMessage({})).toBeNull();
  });

  test("menu actions are a closed set", () => {
    expect(parseClientMessage({ t: "menu", action: "startDay" })).toEqual({
      t: "menu",
      action: "startDay",
    });
    expect(parseClientMessage({ t: "menu", action: "deleteEverything" })).toBeNull();
  });

  test("one bad seat rejects the whole input message", () => {
    // Partial credit would mean applying half of what a client meant, which is
    // worse than applying none of it: the sim holds a starved queue's last
    // input, so a dropped message reads as a moment of lag.
    const message = {
      t: "input",
      seq: 1,
      inputs: { 0: INPUT, 1: { ...INPUT, move: { x: NaN, y: 0 } } },
    };
    expect(parseClientMessage(message)).toBeNull();
  });

  test("a flood of seats in one message is rejected", () => {
    const inputs: Record<number, unknown> = {};
    for (let i = 0; i < 500; i++) inputs[i] = INPUT;
    expect(parseClientMessage({ t: "input", seq: 1, inputs })).toBeNull();
  });
});

describe("server messages", () => {
  test("a real frame round-trips", () => {
    const host = new Host();
    host.join("Ann");
    host.advance(1 / 60);
    const message = {
      t: "welcome" as const,
      room: "MAIN",
      level: LEVEL.id,
      you: [0],
      layout: encodeLayout(host.world),
      frame: encodeFrame(host.world, host.acks),
    };
    const parsed = decode(JSON.stringify(message), parseServerMessage);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(message);
  });

  test("a frame carrying a busy appliance round-trips its item", () => {
    const host = new Host();
    host.join("Ann");
    const board = [...host.world.appliances.values()].find((a) => a.kind === "board")!;
    board.item = { id: 4, base: "tomato", processes: ["chopped"], contents: [] };
    board.progress = 0.5;
    board.motion = "chop";
    const frame = encodeFrame(host.world, host.acks);
    const parsed = decode(JSON.stringify({ t: "frame", frame }), parseServerMessage);
    expect(parsed?.t).toBe("frame");
    // By id: the board is not the only appliance holding something — the plate
    // stack is holding the kitchen's plates.
    const sent =
      parsed?.t === "frame" ? parsed.frame.appliances.find((a) => a.id === board.id) : null;
    expect(sent?.item?.processes).toEqual(["chopped"]);
  });

  test("a plated dish round-trips through nested contents", () => {
    const host = new Host();
    const id = host.join("Ann");
    const player = host.world.players[0]!;
    player.carried = {
      id: 1,
      base: "plate",
      processes: [],
      contents: [{ id: 2, base: "salad", processes: [], contents: [] }],
    };
    void id;
    const frame = encodeFrame(host.world, host.acks);
    const parsed = decode(JSON.stringify({ t: "frame", frame }), parseServerMessage);
    expect(parsed?.t === "frame" && parsed.frame.players[0]?.carried?.contents[0]?.base).toBe(
      "salad",
    );
  });

  test("an unbounded nest of plates cannot blow the parser's stack", () => {
    let item: unknown = { id: 1, base: "plate", processes: [], contents: [] };
    for (let i = 0; i < 10_000; i++) {
      item = { id: i, base: "plate", processes: [], contents: [item] };
    }
    const frame = { t: "frame", frame: { players: [{ carried: item }] } };
    expect(parseServerMessage(frame)).toBeNull();
  });

  test("a bogus appliance kind is rejected before it can reach applianceDef", () => {
    // `applianceDef(kind).speed` on an unknown kind throws inside the tick.
    // Spelled out in full, menu and all: a layout missing an unrelated field
    // would be rejected too, and then this would be passing for a reason that
    // has nothing to do with the kind.
    expect(parseServerMessage({ t: "layout", layout: layoutWith("portal", 1, 1) })).toBeNull();
  });

  test("negative appliance coordinates are rejected", () => {
    expect(parseServerMessage({ t: "layout", layout: layoutWith("oven", -5, 1) })).toBeNull();
  });

  test("an honest layout carries the menu through unchanged", () => {
    const layout = { ...layoutWith("oven", 1, 1), unlocked: ["salad", "fries"], unlockedDay: 2 };
    const parsed = parseServerMessage({ t: "layout", layout });
    expect(parsed?.t).toBe("layout");
    expect(parsed?.t === "layout" && parsed.layout.unlocked).toEqual(["salad", "fries"]);
  });

  test("a malformed menu is rejected: it is what customers order from", () => {
    const base = layoutWith("oven", 1, 1);
    for (const unlocked of [[42], "salad", [{ id: "salad" }], null]) {
      expect(parseServerMessage({ t: "layout", layout: { ...base, unlocked } })).toBeNull();
    }
    expect(parseServerMessage({ t: "layout", layout: { ...base, unlockedDay: -1 } })).toBeNull();
    expect(parseServerMessage({ t: "layout", layout: { ...base, unlockedDay: "2" } })).toBeNull();
  });

  test("a card that is not a recipe id is rejected, not coerced", () => {
    const base = layoutWith("cards", 0, 7);
    const withCard = (card: unknown): unknown => ({
      ...base,
      appliances: [Object.assign({}, base.appliances[0], { card })],
    });
    expect(parseServerMessage({ t: "layout", layout: withCard(7) })).toBeNull();
    const good = parseServerMessage({ t: "layout", layout: withCard("fries") });
    expect(good?.t === "layout" && good.layout.appliances[0]?.card).toBe("fries");
  });

  test("a customer's kind travels, and an unfamiliar one is not a reason to drop them", () => {
    const host = new Host();
    host.join("Ann");
    host.menu("startDay");
    host.world.nextArrivalIn = 0;
    for (let i = 0; i < 60; i++) host.advance(1 / 60);
    expect(host.world.customers.length).toBeGreaterThan(0);

    const frame = encodeFrame(host.world, host.acks);
    const parsed = decode(JSON.stringify({ t: "frame", frame }), parseServerMessage);
    expect(parsed?.t === "frame" && parsed.frame.customers[0]?.kind).toBe(
      host.world.customers[0]!.kind,
    );

    // A kind this build has never heard of is a *newer server*, which is an
    // ordinary state of the world mid-deploy. It resolves to a regular where it
    // is read; rejecting the frame would freeze a whole kitchen over a coat.
    const future = { ...frame, customers: [{ ...frame.customers[0], kind: "astronaut" }] };
    expect(parseServerMessage({ t: "frame", frame: future })).not.toBeNull();
    // A kind that is not a *string* is a malformed message, and those are still
    // dropped whole.
    const broken = { ...frame, customers: [{ ...frame.customers[0], kind: 7 }] };
    expect(parseServerMessage({ t: "frame", frame: broken })).toBeNull();
  });

  test("a fatal error is distinguishable from a passing one", () => {
    expect(parseServerMessage({ t: "error", message: "full", fatal: true })).toEqual({
      t: "error",
      message: "full",
      fatal: true,
    });
    // Older servers do not send the field at all; absent means "keep trying".
    expect(parseServerMessage({ t: "error", message: "full" })).toEqual({
      t: "error",
      message: "full",
      fatal: false,
    });
  });
});
