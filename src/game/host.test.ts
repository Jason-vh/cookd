import { describe, expect, test } from "bun:test";
import { Host } from "./host";
import { applyFrame, applyLayout, encodeFrame, encodeLayout, layoutVersion } from "./protocol";
import { PLAYER_SPEED, emptyInput, isIdleInput } from "../sim/world";
import { saveSignature } from "../save";
import type { Customer, PlayerInput } from "../sim/types";

/**
 * These exercise the multiplayer machinery without a socket in sight. `Host` is
 * the same class the server runs, so anything proved here is proved for hosted
 * play too — which is the entire reason it exists as its own class rather than
 * living inside the server.
 */

function move(x: number): PlayerInput {
  return { ...emptyInput(), move: { x, y: 0 } };
}

/**
 * One press and release of a button, through the `Host`'s own clock.
 *
 * The release matters: everything the simulation does on a button is edge
 * triggered, so a held input is one action, not sixty.
 */
function press(host: Host, id: number, button: "grab" | "use" | "start"): void {
  host.setInput(id, { ...emptyInput(), [button]: true });
  host.advance(1 / 60);
  host.setInput(id, emptyInput());
  host.advance(1 / 60);
}

describe("host", () => {
  test("ids are stable when a player in the middle leaves", () => {
    const host = new Host();
    const a = host.join("Ann");
    const b = host.join("Bea");
    const c = host.join("Cal");
    expect([a, b, c]).toEqual([0, 1, 2]);

    host.leave(b);
    expect(host.world.players.map((p) => p.id)).toEqual([a, c]);
    // Cal must still be Cal. If ids were positions, this would now be 1 and
    // every client would be driving the wrong chef.
    expect(host.world.players.find((p) => p.id === c)?.name).toBe("Cal");
  });

  test("a new player never reuses a departed id", () => {
    const host = new Host();
    const first = host.join("Ann");
    host.leave(first);
    expect(host.join("Bea")).not.toBe(first);
  });

  test("leaving bins carried food but puts the appliance back", () => {
    const host = new Host();
    const id = host.join("Ann");
    const player = host.world.players[0]!;
    player.carried = { id: 99, base: "tomato", processes: [], contents: [] };

    const appliance = [...host.world.appliances.values()].find((a) => a.kind === "counter")!;
    const home = { ...appliance.tile };
    appliance.heldBy = id;
    host.world.applianceAt[home.y * host.world.width + home.x] = 0;
    player.carriedAppliance = appliance.id;

    host.leave(id);

    expect(host.world.players.length).toBe(0);
    expect(appliance.heldBy).toBeNull();
    expect(appliance.tile).toEqual(home);
    expect(host.world.applianceAt[home.y * host.world.width + home.x]).toBe(appliance.id);
  });

  test("inputs are consumed one per tick, so a client can predict against them", () => {
    const host = new Host();
    const id = host.join("Ann");
    const start = host.world.players[0]!.pos.x;

    // Three ticks of input arrive in one burst, as they would after a hiccup.
    host.enqueue(id, 1, move(1));
    host.enqueue(id, 2, move(1));
    host.enqueue(id, 3, move(1));

    host.advance(1 / 60);
    expect(host.acks.get(id)).toBe(1);
    host.advance(1 / 60);
    host.advance(1 / 60);
    expect(host.acks.get(id)).toBe(3);
    expect(host.world.players[0]!.pos.x).toBeGreaterThan(start);
  });

  test("a starved queue holds the last input rather than stopping dead", () => {
    const host = new Host();
    const id = host.join("Ann");
    host.enqueue(id, 1, move(1));
    host.advance(1 / 60);
    const afterFirst = host.world.players[0]!.pos.x;

    // Nothing more arrives: a dropped packet should look like lag, not a stumble.
    host.advance(1 / 60);
    expect(host.world.players[0]!.pos.x).toBeGreaterThan(afterFirst);
  });

  test("reset keeps everyone's id so nobody inherits another player's chef", () => {
    const host = new Host();
    const a = host.join("Ann");
    const b = host.join("Bea");
    host.world.money = 500;

    host.reset("Ann");

    expect(host.world.players.map((p) => p.id)).toEqual([a, b]);
    expect(host.world.players.map((p) => p.name)).toEqual(["Ann", "Bea"]);
    expect(host.world.money).toBe(0);
    expect(host.world.events.some((e) => e.text.includes("Ann reset"))).toBe(true);
  });
});

describe("protocol", () => {
  test("idle appliances are left out of the frame", () => {
    const host = new Host();
    host.join("Ann");
    const idle = encodeFrame(host.world, host.acks);
    expect(idle.appliances.length).toBe(0);

    const board = [...host.world.appliances.values()].find((a) => a.kind === "board")!;
    board.item = { id: 1, base: "tomato", processes: [], contents: [] };
    expect(encodeFrame(host.world, host.acks).appliances.length).toBe(1);
  });

  test("a frame stays small enough for a slow link", () => {
    const host = new Host();
    for (let i = 0; i < 4; i++) host.join(`Player ${i}`);
    const bytes = JSON.stringify(encodeFrame(host.world, host.acks)).length;
    // 20 frames a second, so this is the per-client bandwidth budget.
    expect(bytes).toBeLessThan(2000);
  });

  test("the layout version only changes when an appliance actually moves", () => {
    const host = new Host();
    const before = layoutVersion(host.world);
    host.join("Ann");
    // A full second of service: chefs walk, customers arrive, nothing is built.
    for (let i = 0; i < 60; i++) host.advance(1 / 60);
    expect(layoutVersion(host.world)).toBe(before);

    // Lifting an appliance in the build phase is a layout change, and so is
    // putting it back down. Driven through `interactionSystem` rather than by
    // assigning to `tile`, because the version is only correct if the code that
    // moves appliances is the code that bumps it — a test that pokes the field
    // directly would pass even if every real caller forgot.
    host.menu("endDay");
    const player = host.world.players[0]!;
    const board = [...host.world.appliances.values()].find((a) => a.kind === "board")!;
    player.pos = { x: board.tile.x + 0.5, y: board.tile.y - 0.5 };
    player.facing = { x: 0, y: 1 };

    press(host, player.id, "grab");
    const lifted = layoutVersion(host.world);
    expect(lifted).not.toBe(before);
    expect(board.heldBy).toBe(player.id);

    player.facing = { x: 0, y: -1 };
    press(host, player.id, "grab");
    expect(board.heldBy).toBe(null);
    expect(layoutVersion(host.world)).not.toBe(lifted);
  });

  test("layout carries what a crate dispenses", () => {
    const host = new Host();
    const layout = encodeLayout(host.world);
    const crate = layout.appliances.find((a) => a.kind === "crate");
    expect(crate?.source?.base).toBeTruthy();
  });
});

describe("frames rebuild the world faithfully", () => {
  test("a client that only ever sees frames ends up with the same kitchen", () => {
    const host = new Host();
    const id = host.join("Ann");

    // Do some real work so there is state worth carrying: put a tomato on the
    // board, chop it, and take the kitchen into the build phase.
    const board = [...host.world.appliances.values()].find((a) => a.kind === "board")!;
    board.item = { id: 42, base: "tomato", processes: [], contents: [] };
    host.world.money = 137;
    host.world.players[0]!.carried = { id: 43, base: "plate", processes: [], contents: [] };
    host.enqueue(id, 1, emptyInput());
    host.advance(1 / 60);

    // A fresh world, told nothing but the layout and one frame.
    const client = new Host().world;
    client.players.length = 0;
    applyLayout(client, encodeLayout(host.world));
    applyFrame(client, encodeFrame(host.world, host.acks));

    expect(client.money).toBe(137);
    expect(client.appliances.size).toBe(host.world.appliances.size);
    expect(client.appliances.get(board.id)?.item?.base).toBe("tomato");
    expect(client.players.map((p) => p.name)).toEqual(["Ann"]);
    expect(client.players[0]!.carried?.base).toBe("plate");
    // Idle appliances were never sent, and must have arrived at "idle" anyway.
    const idle = [...client.appliances.values()].filter((a) => a.id !== board.id);
    expect(idle.every((a) => a.item === null && a.progress === 0)).toBe(true);
  });

  test("a held appliance leaves its tile walkable on the client", () => {
    const host = new Host();
    const id = host.join("Ann");
    const appliance = [...host.world.appliances.values()].find((a) => a.kind === "counter")!;
    appliance.heldBy = id;

    const client = new Host().world;
    applyLayout(client, encodeLayout(host.world));
    applyFrame(client, encodeFrame(host.world, host.acks));

    const index = appliance.tile.y * client.width + appliance.tile.x;
    expect(client.applianceAt[index]).toBe(0);
  });
});

describe("overload", () => {
  test("a flooded queue drops the oldest input, and the ack says so", () => {
    const host = new Host();
    const id = host.join("Ann");
    const start = host.world.players[0]!.pos.x;

    // A stalled link delivers half a second of input at once: the player ran
    // right and then stopped. The server has already lived through that time,
    // so it cannot apply all of it — and what it drops is the *running*.
    for (let seq = 1; seq <= 32; seq++) host.enqueue(id, seq, move(1));
    for (let seq = 33; seq <= 40; seq++) host.enqueue(id, seq, emptyInput());
    for (let i = 0; i < 40; i++) host.advance(1 / 60);

    const moved = host.world.players[0]!.pos.x - start;
    const predicted = 32 * PLAYER_SPEED * (1 / 60);

    // The ack jumps to the newest input, *past* everything dropped. The client
    // prunes its history on that ack, so it can never replay the difference —
    // which is why the client smooths the correction rather than snapping.
    expect(host.acks.get(id)).toBe(40);
    expect(moved).toBeLessThan(predicted);
    expect(predicted - moved).toBeGreaterThan(0.1);
  });
});

describe("reset", () => {
  test("does not replay pre-reset input into the new kitchen", () => {
    const host = new Host();
    const id = host.join("Ann");

    // Ann is mid-grab and has a backlog queued when someone resets.
    const grab: PlayerInput = { ...emptyInput(), grab: true };
    for (let seq = 1; seq <= 5; seq++) host.enqueue(id, seq, grab);
    host.advance(1 / 60);

    host.reset("Bea");
    const before = host.world.players[0]!.pos.x;
    for (let i = 0; i < 10; i++) host.advance(1 / 60);

    // Nothing queued should have survived: no leftover grab, no drift.
    expect(host.world.players[0]!.pos.x).toBe(before);
    expect(host.world.players[0]!.carried).toBeNull();
  });

  test("the new world restarts its id counter, which the render layer relies on", () => {
    const host = new Host();
    host.join("Ann");
    for (let i = 0; i < 60; i++) host.advance(1 / 60);
    const highWater = host.world.nextId;

    host.reset();
    // View.syncEffects treats a lower nextId as "this is a different world" and
    // resets its effect high-water mark; if this stopped being true, every
    // effect after a reset would be silently swallowed.
    expect(host.world.nextId).toBeLessThan(highWater + 1);
  });
});

describe("holding a seat", () => {
  test("an away chef stands still instead of repeating its last input", () => {
    const host = new Host();
    const id = host.join("Ann");

    host.enqueue(id, 1, move(1));
    host.advance(1 / 60);
    const walked = host.world.players[0]!.pos.x;

    // Without setAway, a starved queue repeats the last input — which would
    // march an unattended chef into a wall for the whole grace period.
    host.setAway(id, true);
    for (let i = 0; i < 60; i++) host.advance(1 / 60);

    expect(host.world.players[0]!.pos.x).toBe(walked);
    expect(host.world.players[0]!.away).toBe(true);
  });

  test("coming back finds the chef, and what they were carrying, still there", () => {
    const host = new Host();
    const id = host.join("Ann");
    host.world.players[0]!.carried = { id: 7, base: "pizza", processes: ["sauced"], contents: [] };

    host.setAway(id, true);
    for (let i = 0; i < 60; i++) host.advance(1 / 60);
    host.setAway(id, false);

    const player = host.world.players[0]!;
    expect(player.away).toBe(false);
    expect(player.carried?.base).toBe("pizza");

    // ...and they can move again immediately.
    const before = player.pos.x;
    host.enqueue(id, 2, move(1));
    host.advance(1 / 60);
    expect(host.world.players[0]!.pos.x).toBeGreaterThan(before);
  });

  test("input queued before going away does not fire on return", () => {
    const host = new Host();
    const id = host.join("Ann");
    for (let seq = 1; seq <= 5; seq++) host.enqueue(id, seq, { ...emptyInput(), grab: true });

    host.setAway(id, true);
    host.setAway(id, false);
    host.advance(1 / 60);

    expect(host.world.players[0]!.carried).toBeNull();
  });
});

describe("what is worth saving", () => {
  test("the signature covers every saved field, not just the layout", () => {
    const host = new Host();
    const pristine = saveSignature(host.world);

    // Money and the day counter must both move it. They once did not, and a
    // room could reach day five with money banked and never be written to disk,
    // because nobody had moved an appliance so nothing looked dirty.
    host.world.money += 40;
    const afterMoney = saveSignature(host.world);
    expect(afterMoney).not.toBe(pristine);

    host.world.day += 1;
    expect(saveSignature(host.world)).not.toBe(afterMoney);

    const appliance = [...host.world.appliances.values()][0]!;
    const afterDay = saveSignature(host.world);
    appliance.tile = { x: appliance.tile.x, y: appliance.tile.y + 1 };
    expect(saveSignature(host.world)).not.toBe(afterDay);
  });

  /**
   * `NetGame` stops sending while a chef stands still, which is only safe
   * because a starved queue holds the last input it was given. These pin that
   * down from the server's side: silence must mean "carry on", and carrying on
   * from idle must mean staying put.
   */
  test("silence after an idle input leaves a chef exactly where it was", () => {
    const host = new Host();
    const id = host.join("Ann");
    host.enqueue(id, 1, move(1));
    for (let i = 0; i < 30; i++) host.advance(1 / 60);

    // One idle input, then nothing at all for a second — the client has gone
    // quiet because there is nothing to say.
    host.enqueue(id, 2, emptyInput());
    host.advance(1 / 60);
    const settled = { ...host.world.players[0]!.pos };
    for (let i = 0; i < 60; i++) host.advance(1 / 60);

    expect(host.world.players[0]!.pos).toEqual(settled);
  });

  test("silence after a moving input keeps the chef moving", () => {
    const host = new Host();
    const id = host.join("Ann");
    host.enqueue(id, 1, move(1));
    host.advance(1 / 60);
    const after = host.world.players[0]!.pos.x;

    // A dropped packet should read as lag, not as a stumble.
    for (let i = 0; i < 30; i++) host.advance(1 / 60);
    expect(host.world.players[0]!.pos.x).toBeGreaterThan(after);
  });

  test("idle is exactly zero, so it is detectable without a threshold", () => {
    expect(isIdleInput(emptyInput())).toBe(true);
    expect(isIdleInput(move(1))).toBe(false);
    expect(isIdleInput({ ...emptyInput(), grab: true })).toBe(false);
    expect(isIdleInput({ ...emptyInput(), menu: true })).toBe(false);
    // A stick nudged inside its deadzone has already been zeroed upstream.
    expect(isIdleInput({ ...emptyInput(), move: { x: 0.0001, y: 0 } })).toBe(false);
  });

  test("a kitchen nobody touched is identical to a fresh one, so it is never written", () => {
    const a = new Host();
    const b = new Host();
    a.join("Ann");
    for (let i = 0; i < 120; i++) a.advance(1 / 60);
    // Playing does not, by itself, change anything a save contains.
    expect(saveSignature(a.world)).toBe(saveSignature(b.world));
  });
});

describe("frames must not be shared between worlds", () => {
  /**
   * The client applies each frame to *two* worlds: the one it draws, and the
   * one it predicts its own chefs in. Handing both the same arrays meant the
   * prediction world's `step()` — which spawns customers, logs events and
   * queues effects — was writing straight into what was being rendered.
   *
   * The symptom was an order flashing into view and vanishing on the next
   * frame, and it got worse with latency: more unacknowledged input means more
   * prediction ticks replayed, so more chances to invent a customer.
   */
  test("applying one frame to two worlds does not alias their state", () => {
    const host = new Host();
    host.join("Ann");
    host.world.customers.push(customer(1, "salad"));

    const frame = encodeFrame(host.world, host.acks);
    const drawn = new Host().world;
    const predicted = new Host().world;
    applyLayout(drawn, encodeLayout(host.world));
    applyLayout(predicted, encodeLayout(host.world));
    applyFrame(drawn, frame);
    applyFrame(predicted, frame);

    const before = {
      customers: drawn.customers.length,
      events: drawn.events.length,
      effects: drawn.effects.length,
    };

    // Whatever the prediction world does to itself must stay there.
    predicted.customers.push(customer(2, "fries"));
    predicted.events.push({ text: "speculative", ttl: 1 });
    predicted.effects.push({ id: 900, ttl: 1, kind: "served", playerId: 0, amount: 99 });

    expect(drawn.customers.length).toBe(before.customers);
    expect(drawn.events.length).toBe(before.events);
    expect(drawn.effects.length).toBe(before.effects);
  });

  test("a predicted tick cannot invent a customer in the world being drawn", () => {
    const host = new Host();
    const id = host.join("Ann");
    const frame = encodeFrame(host.world, host.acks);

    const drawn = new Host().world;
    const predicted = new Host();
    applyLayout(drawn, encodeLayout(host.world));
    applyFrame(drawn, frame);
    applyFrame(predicted.world, frame);

    // Replay a second of input, exactly as reconciliation does on a slow link.
    predicted.world.nextArrivalIn = 0.05;
    for (let i = 0; i < 60; i++) predicted.advance(1 / 60);

    expect(predicted.world.customers.length).toBeGreaterThan(0);
    expect(drawn.customers.length).toBe(0);
    void id;
  });
});

/** A customer sitting at no table, which is all these tests need of one. */
function customer(id: number, recipeId: string): Customer {
  return {
    id,
    state: "ordering",
    pos: { x: 1, y: 1 },
    prevPos: { x: 1, y: 1 },
    facing: { x: 1, y: 0 },
    table: null,
    seat: null,
    recipeId,
    path: [],
    timer: 0,
    remaining: 30,
    patience: 60,
    tip: 0,
  };
}
