import { describe, expect, test } from "bun:test";
import { Host, TARGET_QUEUE } from "./host";
import { applyFrame, applyLayout, encodeFrame, encodeLayout, layoutVersion } from "./protocol";
import { PLAYER_SPEED, addPlayer, createWorld, emptyInput, isIdleInput } from "../sim/world";
import { predict, step } from "../sim/step";
import { beginDay, endDay } from "../sim/day";
import { platesInWorld, unshelvePlate } from "../sim/plates";
import { LEVEL } from "../data/level";
import { saveSignature } from "../save";
import type { Customer, Inputs, Player, PlayerInput, World } from "../sim/types";

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

    // Arriving as they were sent — one a tick — they are applied one a tick, and
    // the ack names exactly the one that was. That is what the client predicts
    // against and prunes its history on. (A *backlog* is caught up on faster;
    // see "a queue deeper than it should be".)
    for (let seq = 1; seq <= 3; seq++) {
      host.enqueue(id, seq, move(1));
      host.advance(1 / 60);
      expect(host.acks.get(id)).toBe(seq);
    }
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
    // Not zero: the plate stack is holding the kitchen's plates, and a pile of
    // plates is an item like any other. Everything *else* is idle.
    const quiet = encodeFrame(host.world, host.acks);
    expect(quiet.appliances.length).toBe(1);

    const board = [...host.world.appliances.values()].find((a) => a.kind === "counter")!;
    board.item = { id: 1, base: "tomato", processes: [], contents: [] };
    expect(encodeFrame(host.world, host.acks).appliances.length).toBe(2);
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
    endDay(host.world);
    const player = host.world.players[0]!;
    const board = [...host.world.appliances.values()].find((a) => a.kind === "counter")!;
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

  test("...and whenever the morning changes what a slot or a stand is holding", () => {
    // The server resends the layout only when the version moves, so a change
    // the version misses is a change no client is ever told about. Morning two
    // is the first chance to get this wrong: `endDay` re-rolls the stall and
    // rolls the cards without touching a single tile, and a client that was not
    // told read yesterday's "Plate" off a slot the host had already restocked
    // with a bin — and was handed the bin.
    //
    // One-directional on purpose: a version that moves while the layout stands
    // still costs one redundant message a morning, and a version that stands
    // still while the layout moves costs a client the truth until somebody
    // happens to pick something up.
    const host = new Host();
    host.join("Ann");
    let changes = 0;
    for (let flip = 0; flip < 10; flip++) {
      const layout = JSON.stringify(encodeLayout(host.world));
      const version = layoutVersion(host.world);
      if (host.world.phase === "build") beginDay(host.world);
      else endDay(host.world);
      if (JSON.stringify(encodeLayout(host.world)) === layout) continue;
      changes++;
      expect(layoutVersion(host.world)).not.toBe(version);
    }
    // Five days of opening and closing move the layout at least once, or the
    // loop above proved nothing at all.
    expect(changes).toBeGreaterThan(0);
  });

  test("layout carries what a crate dispenses", () => {
    const host = new Host();
    const layout = encodeLayout(host.world);
    const crate = layout.appliances.find((a) => a.kind === "crate");
    expect(crate?.source?.base).toBeTruthy();
  });

  test("layout carries the menu and the cards on the stand", () => {
    // The menu is what customers order from, so a client that had it wrong
    // would draw order bubbles for dishes this kitchen has never unlocked. It
    // rides the layout rather than the frame because it changes every third
    // morning and never during service — the same kind of fact as a counter.
    const host = new Host();
    while (host.world.day < 2) {
      beginDay(host.world);
      endDay(host.world);
    }
    host.world.unlocked = ["salad", "fries"];
    host.world.unlockedDay = 2;

    const layout = encodeLayout(host.world);
    expect(layout.unlocked).toEqual(["salad", "fries"]);
    expect(layout.unlockedDay).toBe(2);
    expect(layout.appliances.filter((a) => a.kind === "cards" && a.card !== null)).not.toEqual([]);

    // Copied on the way out, never aliased: one layout is applied to two worlds
    // and one of them is replayed over.
    const client = new Host().world;
    applyLayout(client, layout);
    expect(client.unlocked).toEqual(["salad", "fries"]);
    expect(client.unlocked).not.toBe(host.world.unlocked);
    expect(client.unlockedDay).toBe(2);
  });
});

describe("frames rebuild the world faithfully", () => {
  test("a client that only ever sees frames ends up with the same kitchen", () => {
    const host = new Host();
    const id = host.join("Ann");

    // Do some real work so there is state worth carrying: put a tomato on the
    // board, chop it, and take the kitchen into the build phase.
    const board = [...host.world.appliances.values()].find((a) => a.kind === "counter")!;
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
    // The plate stack is not one of them: it is holding the kitchen's plates.
    const idle = [...client.appliances.values()].filter(
      (a) => a.id !== board.id && a.kind !== "plates",
    );
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

  test("a queue deeper than it should be is caught up on, a tick at a time", () => {
    // The depth is otherwise a ratchet: production and consumption are both
    // 60Hz, so nothing shortens it except running dry, and every dropped client
    // frame leaves a tick in there for good. Each one is 16ms between a player
    // pressing something and this server acting on it.
    const host = new Host();
    const id = host.join("Ann");
    for (let seq = 1; seq <= 12; seq++) host.enqueue(id, seq, move(1));
    expect(host.queueDepth(id)).toBe(12);

    // Two per tick while it is over the target, so a backlog is absorbed as a
    // series of 0.07-tile corrections rather than one lurch across the kitchen.
    host.advance(1 / 60);
    expect(host.queueDepth(id)).toBe(10);

    for (let i = 0; i < 11; i++) host.advance(1 / 60);
    expect(host.queueDepth(id)).toBeLessThanOrEqual(TARGET_QUEUE);
  });

  test("catching up costs a tick of walking, never a press", () => {
    // The tick being skipped may be the one somebody pressed grab on, and a
    // press that evaporates is a player pressing it again and getting two. So
    // the buttons are folded into the tick behind rather than going with it.
    const host = new Host();
    const id = host.join("Ann");
    const grab: PlayerInput = { ...emptyInput(), grab: true };
    host.enqueue(id, 1, grab);
    for (let seq = 2; seq <= 6; seq++) host.enqueue(id, seq, emptyInput());

    host.advance(1 / 60);

    // Seq 1 was skipped for its movement and kept for its button: the applied
    // input carried the grab, and the ack covers both so the client prunes
    // exactly what was dealt with.
    expect(host.world.players[0]!.prev.grab).toBe(true);
    expect(host.acks.get(id)).toBe(2);
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

  test("restarting after an eviction is a new run, menu and all", () => {
    // Reset normally keeps the recipes: days were spent on them. A repossessed
    // kitchen has reset as its only way forward, so it is where a *new run*
    // begins — and one that inherited the old menu would open on day one with
    // customers ordering pizza in a kitchen with no oven and no money for one.
    const host = new Host();
    host.join("Ann");
    host.world.unlocked = ["salad", "fries", "pizza"];
    host.world.evicted = true;
    host.world.money = -40;

    host.reset("Ann");

    expect(host.world.evicted).toBe(false);
    expect(host.world.unlocked).toEqual(["salad"]);
    expect(host.world.money).toBe(0);
    expect(host.world.day).toBe(1);
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

  test("a predicted grab cannot take a plate out of the world being drawn", () => {
    // Items were the one part of a frame still being shared, and it was
    // survivable only while every rule rewrote an item *in place*. A pile of
    // plates is an item that moves its contents into another item, so one
    // predicted grab at the plate stack was enough to empty the pile the
    // player was actually looking at.
    const host = new Host();
    host.join("Ann");
    const frame = encodeFrame(host.world, host.acks);

    const drawn = new Host().world;
    const predicted = new Host().world;
    applyLayout(drawn, encodeLayout(host.world));
    applyLayout(predicted, encodeLayout(host.world));
    applyFrame(drawn, frame);
    applyFrame(predicted, frame);

    const stack = [...predicted.appliances.values()].find((a) => a.kind === "plates")!;
    const before = platesInWorld(drawn);
    expect(before).toBe(LEVEL.plates);

    predicted.players[0]!.carried = unshelvePlate(stack);
    expect(platesInWorld(predicted)).toBe(before);
    expect(platesInWorld(drawn)).toBe(before);
    expect(drawn.players[0]!.carried).toBeNull();
  });

  test("a predicted tick cannot invent a customer in the world being drawn", () => {
    const host = new Host();
    const id = host.join("Ann");
    // Open the day: rooms wake into the morning now, and nobody walks in then.
    beginDay(host.world);
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
    party: 0,
    plate: null,
    recipeId,
    kind: "regular",
    path: [],
    timer: 0,
    remaining: 30,
    patience: 60,
    tip: 0,
  };
}

/**
 * Stand a chef in front of the sign by the door, facing it.
 *
 * Found rather than hard-coded: which wall tile a level hangs its sign on is
 * that level's business, and a test that knew the coordinate would be testing
 * the level file.
 */
function faceSign(world: World, player: Player): void {
  const sign = [...world.appliances.values()].find((a) => a.kind === "sign")!;
  player.pos = { x: sign.tile.x + 1.5, y: sign.tile.y + 0.5 };
  player.prevPos = { ...player.pos };
  player.facing = { x: -1, y: 0 };
}

describe("what a client is allowed to guess at", () => {
  test("prediction never changes the phase", () => {
    // Opening the day is a grab at the sign by the door, and a predicted grab
    // would otherwise flip the *prediction* world into service while the server
    // was still in build — whereupon `interactionSystem` takes the service
    // branch for a round trip, so a grab held across the transition predicts an
    // entirely different action, and `workingOn` is drawn.
    //
    // A world wakes in the build phase, which is exactly the state this is
    // about: the morning of day one, waiting for somebody to open it.
    const world = createWorld(LEVEL, 0);
    const player = addPlayer(world, LEVEL, "Ann");
    expect(world.phase).toBe("build");
    faceSign(world, player);

    const pressing: Inputs = { [player.id]: { ...emptyInput(), grab: true } };
    for (let i = 0; i < 10; i++) predict(world, pressing);
    expect(world.phase).toBe("build");
    expect(world.day).toBe(1);

    // The authoritative tick still opens the day, which is the whole point of
    // the split: the server decides, the client draws. Released first, because
    // `predict` latched the held button — which is itself the behaviour the
    // third test below pins down.
    step(world, { [player.id]: emptyInput() });
    step(world, pressing);
    expect(world.phase).toBe("service");
  });

  test("...nor closes the kitchen out from under the server", () => {
    // The same rule from the other side. Service *is* predicted, so the sign is
    // the one thing in it a guess may not touch: a client replays every
    // unacknowledged tick, so a predicted flip would call last orders twenty
    // times a second on a kitchen the server still has open.
    const world = createWorld(LEVEL, 0);
    const player = addPlayer(world, LEVEL, "Ann");
    beginDay(world);
    faceSign(world, player);
    const clock = world.dayTime;

    // What a client's prediction world is: the same simulation, flagged as a
    // guess. `predict` alone cannot express this one — service interaction *is*
    // predicted, so the sign has to refuse on its own account.
    world.predicting = true;
    const pressing: Inputs = { [player.id]: { ...emptyInput(), grab: true } };
    for (let i = 0; i < 10; i++) predict(world, pressing);
    expect(world.dayTime).toBeCloseTo(clock, 5);

    world.predicting = false;
    step(world, { [player.id]: emptyInput() });
    step(world, pressing);
    expect(world.dayTime).toBeLessThanOrEqual(0);
  });

  test("prediction spawns no customers and burns no randomness", () => {
    // Predicted customers are overwritten by the next frame, so producing them
    // costs a grid flood fill per tick for nothing — and advancing the shared
    // RNG stream guarantees the client diverges from the server permanently.
    const world = createWorld(LEVEL, 0);
    const id = addPlayer(world, LEVEL, "Ann").id;
    const seed = world.rngState;

    const walking: Inputs = { [id]: { ...emptyInput(), move: { x: 1, y: 0 } } };
    for (let i = 0; i < 600; i++) predict(world, walking);

    expect(world.customers).toEqual([]);
    expect(world.rngState).toBe(seed);
    // ...but it does move the chef, which is the part a client owns.
    expect(world.players[0]!.pos.x).toBeGreaterThan(11);
  });

  test("prediction still latches buttons, so a held grab fires once", () => {
    // Without the latch a held button re-fires on every replayed tick, and a
    // replay can be 240 of them.
    const world = createWorld(LEVEL, 0);
    // In service: a build-phase grab lifts appliances, and this is about food.
    world.phase = "service";
    const player = addPlayer(world, LEVEL, "Ann");
    const crate = [...world.appliances.values()].find((a) => a.source?.base === "tomato")!;
    player.pos = { x: crate.tile.x + 0.5, y: crate.tile.y + 1.5 };
    player.facing = { x: 0, y: -1 };

    const holding: Inputs = { [player.id]: { ...emptyInput(), grab: true } };
    predict(world, holding);
    const first = player.carried;
    expect(first).not.toBeNull();

    // Still held: the same item, not a fresh one off the crate.
    for (let i = 0; i < 20; i++) predict(world, holding);
    expect(player.carried).toBe(first);
  });
});

/**
 * A pause is a fact about the room, so it travels — and so it has to be
 * survivable when whoever set it stops being in the room.
 */
describe("pausing a room", () => {
  test("the clock stops for everybody, and starts again", () => {
    const host = new Host();
    host.join("Ann");
    beginDay(host.world);
    const clock = host.world.dayTime;

    host.menu("pause", 0);
    host.advance(1);
    expect(host.world.pausedName).toBe("Ann");
    expect(host.world.dayTime).toBe(clock);

    host.menu("resume");
    host.advance(1);
    expect(host.world.dayTime).toBeLessThan(clock);
  });

  test("a dropped connection does not leave the room paused behind it", () => {
    // The menu that would let them let go of it is on a screen that has gone,
    // so a pause that outlived its owner would be a kitchen nobody can play and
    // nobody can fix.
    const host = new Host();
    const ann = host.join("Ann");
    host.join("Bo");
    beginDay(host.world);

    host.menu("pause", ann);
    host.setAway(ann, true);
    expect(host.world.pausedBy).toBeNull();

    host.menu("pause", ann);
    host.leave(ann);
    expect(host.world.pausedBy).toBeNull();
  });

  test("resetting from an open menu comes back paused", () => {
    // Reset is reached *through* the menu, and that menu is still open when the
    // new world arrives. Coming back running would leave the player looking at
    // a paused screen over a kitchen that was not.
    const host = new Host();
    const ann = host.join("Ann");
    host.menu("pause", ann);
    host.reset("Ann");
    expect(host.world.pausedBy).toBe(ann);
    expect(host.world.pausedName).toBe("Ann");
  });
});
