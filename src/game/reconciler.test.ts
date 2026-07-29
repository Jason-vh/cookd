import { describe, expect, test } from "bun:test";
import { LEVEL } from "../data/level";
import { Host } from "./host";
import { encodeFrame, type Frame } from "./protocol";
import { Reconciler } from "./reconciler";
import type { Inputs } from "../sim/types";
import { emptyInput } from "../sim/world";

/**
 * Prediction and correction, without a socket.
 *
 * A `Host` stands in for the server: it is the same class the real one runs, so
 * a frame produced here is a frame produced there.
 */

function walking(id: number, x = 1): Inputs {
  return { [id]: { ...emptyInput(), move: { x, y: 0 } } };
}

function idle(id: number): Inputs {
  return { [id]: emptyInput() };
}

/** A server with one player, already ticking. */
function server(): { host: Host; id: number; frame: () => Frame } {
  const host = new Host();
  const id = host.join("Ann");
  return { host, id, frame: () => encodeFrame(host.world, host.acks) };
}

describe("sending input", () => {
  test("standing still is only said once", () => {
    // The server's queue starves gracefully by holding the last input it was
    // given, so repeating "idle" sixty times a second only restates it.
    const reconciler = new Reconciler(LEVEL);
    expect(reconciler.record(idle(0))).not.toBeNull();
    for (let i = 0; i < 30; i++) expect(reconciler.record(idle(0))).toBeNull();
  });

  test("but the first idle after moving is, because it means stop", () => {
    const reconciler = new Reconciler(LEVEL);
    reconciler.record(walking(0));
    expect(reconciler.record(idle(0))).not.toBeNull();
    expect(reconciler.record(idle(0))).toBeNull();
  });

  test("movement is always sent", () => {
    const reconciler = new Reconciler(LEVEL);
    for (let i = 0; i < 10; i++) expect(reconciler.record(walking(0))).not.toBeNull();
  });

  test("sequence numbers only advance for what was sent", () => {
    const reconciler = new Reconciler(LEVEL);
    const first = reconciler.record(walking(0));
    reconciler.record(idle(0));
    for (let i = 0; i < 5; i++) reconciler.record(idle(0));
    const next = reconciler.record(walking(0));
    expect(next?.seq).toBe((first?.seq ?? 0) + 2);
  });

  test("a new seat forces the whole payload to be restated", () => {
    // Otherwise a freshly joined chef goes unmentioned until somebody moves.
    const reconciler = new Reconciler(LEVEL);
    reconciler.record(idle(0));
    expect(reconciler.record(idle(0))).toBeNull();
    reconciler.restate();
    expect(reconciler.record(idle(0))).not.toBeNull();
  });

  test("predicting moves our chef immediately", () => {
    const reconciler = new Reconciler(LEVEL);
    const { host, id } = server();
    reconciler.reconcile(encodeFrame(host.world, host.acks), [id]);
    const before = reconciler.prediction.players[0]!.pos.x;
    for (let i = 0; i < 30; i++) reconciler.record(walking(id));
    expect(reconciler.prediction.players[0]!.pos.x).toBeGreaterThan(before + 1);
  });
});

describe("agreeing with the server", () => {
  test("a client that predicted correctly carries no error", () => {
    const { host, id } = server();
    const reconciler = new Reconciler(LEVEL);
    reconciler.reconcile(encodeFrame(host.world, host.acks), [id]);

    // Both sides run the same inputs, and the server acks each one.
    for (let i = 0; i < 30; i++) {
      const sent = reconciler.record(walking(id));
      const input = sent?.inputs[id];
      if (sent && input) host.enqueue(id, sent.seq, input);
      host.advance(1 / 60);
    }
    reconciler.reconcile(encodeFrame(host.world, host.acks), [id]);

    const error = reconciler.errorOf(id);
    expect(Math.hypot(error.x, error.y)).toBeLessThan(0.01);
  });

  test("unacknowledged input is replayed, so our chef stays ahead", () => {
    // The whole point on a slow link: the server has not seen the last few
    // ticks, so we re-run them on top of its answer rather than snapping back.
    const { host, id } = server();
    const reconciler = new Reconciler(LEVEL);
    const first = encodeFrame(host.world, host.acks);
    reconciler.reconcile(first, [id]);
    const start = reconciler.prediction.players[0]!.pos.x;

    // Thirty ticks of walking that the server has not seen at all.
    for (let i = 0; i < 30; i++) reconciler.record(walking(id));
    const predicted = reconciler.prediction.players[0]!.pos.x;
    expect(predicted).toBeGreaterThan(start);

    // A stale frame arrives, describing the chef still at the start line.
    reconciler.reconcile(first, [id]);
    expect(reconciler.prediction.players[0]!.pos.x).toBeCloseTo(predicted, 5);
  });
});

describe("disagreeing with the server", () => {
  test("a correction is carried as an offset, not a teleport", () => {
    // The server can legitimately refuse input we already predicted: a stalled
    // link that dumps half a second at once has its oldest dropped, because
    // that time has passed. Snapping would fling the chef across the kitchen
    // mid-stride.
    const { host, id } = server();
    const reconciler = new Reconciler(LEVEL);
    reconciler.reconcile(encodeFrame(host.world, host.acks), [id]);

    // We walk; the server never hears about it and acks everything anyway.
    for (let i = 0; i < 20; i++) reconciler.record(walking(id));
    const believed = reconciler.prediction.players[0]!.pos.x;

    const frame = encodeFrame(host.world, host.acks);
    frame.acks[id] = 999;
    reconciler.reconcile(frame, [id]);

    // The prediction world snaps to the server's answer...
    const corrected = reconciler.prediction.players[0]!.pos.x;
    expect(corrected).toBeLessThan(believed - 1);

    // ...but the error absorbs most of it, so what gets *drawn* stays where the
    // player last saw their chef. One frame of decay is applied immediately, so
    // it is not exactly `believed` — the property is that it is far nearer to
    // that than to the place the server just insisted on.
    reconciler.show([id]);
    const drawn = reconciler.prediction.players[0]!.pos.x;
    expect(believed - drawn).toBeLessThan((believed - corrected) * 0.25);

    // And the correction is only ever *drawn*: taking it back out leaves the
    // simulation standing exactly where the server put it, or the next tick
    // would move from a position that was never true and correct it twice.
    reconciler.hide();
    expect(reconciler.prediction.players[0]!.pos.x).toBe(corrected);
  });

  test("the offset decays to nothing", () => {
    const { host, id } = server();
    const reconciler = new Reconciler(LEVEL);
    reconciler.reconcile(encodeFrame(host.world, host.acks), [id]);
    for (let i = 0; i < 20; i++) reconciler.record(walking(id));

    const frame = encodeFrame(host.world, host.acks);
    frame.acks[id] = 999;
    reconciler.reconcile(frame, [id]);
    const initial = Math.hypot(reconciler.errorOf(id).x, reconciler.errorOf(id).y);
    expect(initial).toBeGreaterThan(0.1);

    // ~200ms of drawing walks it off.
    for (let i = 0; i < 30; i++) reconciler.show([id]);
    expect(Math.hypot(reconciler.errorOf(id).x, reconciler.errorOf(id).y)).toBeLessThan(0.01);
  });

  test("an error too big to walk off is snapped instead", () => {
    // Past the cap something has gone badly wrong — a reset, a very long
    // stall — and being in the right place matters more than being smooth.
    const { host, id } = server();
    const reconciler = new Reconciler(LEVEL);
    reconciler.reconcile(encodeFrame(host.world, host.acks), [id]);

    for (let i = 0; i < 400; i++) reconciler.record(walking(id));
    const frame = encodeFrame(host.world, host.acks);
    frame.acks[id] = 999;
    reconciler.reconcile(frame, [id]);

    expect(reconciler.errorOf(id)).toEqual({ x: 0, y: 0 });
  });
});

describe("a session ending", () => {
  test("reset throws away the history, so it cannot replay into a new world", () => {
    // A reconnect is a new session: new ids, acks back at zero, and a history
    // describing players that no longer exist.
    const { host, id } = server();
    const reconciler = new Reconciler(LEVEL);
    reconciler.reconcile(encodeFrame(host.world, host.acks), [id]);
    for (let i = 0; i < 100; i++) reconciler.record(walking(id));

    reconciler.reset();
    const frame = encodeFrame(host.world, host.acks);
    reconciler.reconcile(frame, [id]);

    // Nothing outstanding, so the prediction is exactly the server's word.
    expect(reconciler.prediction.players[0]!.pos.x).toBeCloseTo(host.world.players[0]!.pos.x, 6);
    expect(reconciler.errorOf(id)).toEqual({ x: 0, y: 0 });
  });

  test("a seat we no longer drive is forgotten", () => {
    const reconciler = new Reconciler(LEVEL);
    reconciler.forget(0);
    expect(reconciler.errorOf(0)).toEqual({ x: 0, y: 0 });
  });

  test("drawing a chef the prediction does not know about is a no-op", () => {
    const reconciler = new Reconciler(LEVEL);
    expect(() => {
      reconciler.show([7]);
      reconciler.hide();
    }).not.toThrow();
  });
});
