import { describe, expect, test } from "bun:test";
import { DT } from "../sim/step";
import { SEND_EVERY, type Frame } from "./protocol";
import { MAX_DELAY, MIN_DELAY, SnapshotBuffer } from "./snapshots";

/**
 * The received timeline, driven with synthetic arrival times.
 *
 * None of this could be tested while it was six private fields inside a
 * 562-line `NetGame` that opens a WebSocket in its constructor — which is why
 * the playout clock spent years unable to rebuild its own jitter budget, and
 * years sized against a guess.
 */

/** How far apart, in server time, two frames sent on schedule are. */
const STEADY = SEND_EVERY * DT * 1000;

function frame(tick: number, players: { id: number; x: number; y: number }[] = []): Frame {
  return {
    tick,
    nextId: 1,
    phase: "service",
    day: 1,
    dayTime: 100,
    dayLength: 150,
    money: 0,
    served: 0,
    lost: 0,
    evicted: false,
    today: { day: 1, earned: 0, tips: 0, served: 0, lost: {}, rent: 0 },
    customers: [],
    events: [],
    effects: [],
    appliances: [],
    acks: {},
    players: players.map(({ id, x, y }) => ({
      id,
      name: "Ann",
      away: false,
      x,
      y,
      fx: 0,
      fy: 1,
      carried: null,
      carriedAppliance: null,
      workingOn: null,
    })),
  };
}

/**
 * A link with nothing wrong with it: one chef walking right, a frame every send
 * interval, every one taking exactly as long to arrive as the last. Returns
 * when the final frame turned up.
 */
function steady(buffer: SnapshotBuffer, count: number, from = 1000): number {
  let at = from;
  for (let i = 0; i < count; i++) {
    buffer.push(frame(i * SEND_EVERY, [{ id: 0, x: i, y: 0 }]), at);
    at += STEADY;
  }
  return at - STEADY;
}

/** The moment a tick happened, on the server's clock. */
function serverMs(tick: number): number {
  return tick * DT * 1000;
}

describe("how far behind to play", () => {
  test("a link with nothing wrong with it gets the smallest buffer there is", () => {
    // One send interval, plus a tick of slack. Below that there is routinely no
    // next frame to slide towards and a remote chef stops dead until one lands.
    const buffer = new SnapshotBuffer();
    const last = steady(buffer, 20);

    expect(buffer.delay).toBe(MIN_DELAY);
    expect(buffer.playoutAt(last)).toBeCloseTo(serverMs(19 * SEND_EVERY) - MIN_DELAY, 6);
  });

  test("a jittery one gets a bigger buffer, immediately", () => {
    // A frame that does not arrive in time is a chef who stutters, which is the
    // whole thing the buffer exists to prevent, so growing cannot wait.
    const buffer = new SnapshotBuffer();
    let at = steady(buffer, 10);

    at += STEADY + 60;
    buffer.push(frame(10 * SEND_EVERY, [{ id: 0, x: 10, y: 0 }]), at);
    expect(buffer.delay).toBeCloseTo(MIN_DELAY + 60, 6);
  });

  test("and gives it back slowly, because calm for a moment is not calm", () => {
    const buffer = new SnapshotBuffer();
    let at = steady(buffer, 10);
    at += STEADY + 60;
    buffer.push(frame(10 * SEND_EVERY, [{ id: 0, x: 10, y: 0 }]), at);
    const swollen = buffer.delay;

    // The late one ages out of the window, and the buffer walks back down.
    for (let i = 11; i < 60; i++) {
      at += STEADY;
      buffer.push(frame(i * SEND_EVERY, [{ id: 0, x: i, y: 0 }]), at);
    }
    expect(buffer.delay).toBeLessThan(swollen);
    expect(buffer.delay).toBeGreaterThanOrEqual(MIN_DELAY);
  });

  test("a link that is not jittery but broken is capped", () => {
    const buffer = new SnapshotBuffer();
    let at = steady(buffer, 4);
    at += 5000;
    buffer.push(frame(4 * SEND_EVERY, [{ id: 0, x: 4, y: 0 }]), at);
    expect(buffer.delay).toBe(MAX_DELAY);
  });

  test("sending early does not read as jitter", () => {
    // The server sends the moment somebody does something, so frames arrive one
    // tick apart rather than three. Measured against arrival times that is
    // indistinguishable from a bad link, and would inflate the buffer for
    // everybody every time anyone picked anything up. Measured against the
    // server's own clock it is simply a frame, on time.
    const buffer = new SnapshotBuffer();
    let at = 1000;
    let tick = 0;
    for (let i = 0; i < 30; i++) {
      const early = i % 4 === 3;
      tick += early ? 1 : SEND_EVERY;
      at += early ? DT * 1000 : STEADY;
      buffer.push(frame(tick, [{ id: 0, x: i, y: 0 }]), at);
    }
    expect(buffer.delay).toBeCloseTo(MIN_DELAY, 6);
  });
});

describe("sampling", () => {
  test("interpolates on the server's clock, not on when packets turned up", () => {
    // Two frames three ticks apart, the second of them held up by 200ms. The
    // chef was halfway between them halfway through those three *ticks* —
    // arrival times have nothing to say about it.
    const buffer = new SnapshotBuffer();
    buffer.push(frame(0, [{ id: 0, x: 0, y: 0 }]), 1000);
    buffer.push(frame(SEND_EVERY, [{ id: 0, x: 10, y: 20 }]), 1250);

    expect(buffer.sample("players", 0, serverMs(0))).toEqual({ x: 0, y: 0 });
    expect(buffer.sample("players", 0, serverMs(SEND_EVERY))).toEqual({ x: 10, y: 20 });
    const half = buffer.sample("players", 0, serverMs(SEND_EVERY) / 2);
    expect(half?.x).toBeCloseTo(5, 6);
    expect(half?.y).toBeCloseTo(10, 6);
  });

  test("two points a tick apart differ while an entity is moving", () => {
    // This is what the walk cycle is derived from: if `prevPos === pos`, a
    // sliding chef animates as if standing still.
    const buffer = new SnapshotBuffer();
    const last = steady(buffer, 20);
    const playout = buffer.playoutAt(last);

    const now = buffer.sample("players", 0, playout);
    const before = buffer.sample("players", 0, playout - DT * 1000);
    expect(now).not.toBeNull();
    expect(before).not.toBeNull();
    expect(now?.x).not.toBeCloseTo(before?.x ?? 0, 6);
  });

  test("never reads past the newest frame", () => {
    // Nothing there to interpolate towards, and extrapolating is how a chef
    // slides through a wall. A silent link holds them at the last thing seen.
    const buffer = new SnapshotBuffer();
    const last = steady(buffer, 5);
    const stalled = buffer.sample("players", 0, buffer.playoutAt(last + 10_000));
    expect(stalled).toEqual({ x: 4, y: 0 });
  });

  test("an entity in only one of the two frames uses the frame that has it", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(frame(0, []), 1000);
    buffer.push(frame(SEND_EVERY, [{ id: 7, x: 3, y: 4 }]), 1050);
    expect(buffer.sample("players", 7, serverMs(1))).toEqual({ x: 3, y: 4 });
  });

  test("an entity in neither frame is absent, not an origin", () => {
    // Returning {0,0} would park a departed chef in the corner of the kitchen.
    const buffer = new SnapshotBuffer();
    buffer.push(frame(0, [{ id: 0, x: 5, y: 5 }]), 1000);
    expect(buffer.sample("players", 99, 0)).toBeNull();
  });

  test("an empty buffer samples nothing", () => {
    expect(new SnapshotBuffer().sample("players", 0, 0)).toBeNull();
  });

  test("facing comes from the newest frame, not an average", () => {
    // Averaging two directions through a turn points somewhere the entity never
    // faced.
    const buffer = new SnapshotBuffer();
    buffer.push(frame(0, [{ id: 0, x: 0, y: 0 }]), 1000);
    expect(buffer.facing("players", 0)).toEqual({ x: 0, y: 1 });
    expect(buffer.facing("players", 42)).toBeNull();
  });
});

describe("a world that restarts", () => {
  test("a reset drops the timeline instead of interpolating across it", () => {
    // `Host.reset` rebuilds the world, so `tick` returns to zero *and*
    // appliance ids restart at 1 — the ids collide rather than obviously
    // mismatching, so stale frames look valid and get interpolated. For the
    // length of the playout delay, chefs slide towards pre-reset positions.
    const buffer = new SnapshotBuffer();
    steady(buffer, 10);
    expect(buffer.size).toBe(10);

    buffer.push(frame(0, [{ id: 0, x: 99, y: 99 }]), 2000);
    expect(buffer.size).toBe(1);
    expect(buffer.sample("players", 0, 0)).toEqual({ x: 99, y: 99 });
  });

  test("an ordinary frame does not drop the timeline", () => {
    const buffer = new SnapshotBuffer();
    steady(buffer, 10);
    buffer.push(frame(10 * SEND_EVERY, [{ id: 0, x: 10, y: 0 }]), 2000);
    expect(buffer.size).toBe(11);
  });

  test("clear returns it to un-started, buffer and all", () => {
    const buffer = new SnapshotBuffer();
    let at = steady(buffer, 4);
    at += STEADY + 90;
    buffer.push(frame(4 * SEND_EVERY, [{ id: 0, x: 4, y: 0 }]), at);
    expect(buffer.started).toBe(true);
    expect(buffer.delay).toBeGreaterThan(MIN_DELAY);

    buffer.clear();
    expect(buffer.started).toBe(false);
    expect(buffer.newest).toBeNull();
    // A new session is not the old one's link. Carrying the swollen buffer over
    // would make a reconnect start by watching a quarter-second of history.
    expect(buffer.delay).toBe(MIN_DELAY);
  });

  test("holds a bounded number of frames", () => {
    const buffer = new SnapshotBuffer();
    steady(buffer, 500);
    expect(buffer.size).toBeLessThanOrEqual(40);
  });
});
