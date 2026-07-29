import { describe, expect, test } from "bun:test";
import type { Frame } from "./protocol";
import { PLAYOUT_DELAY, SnapshotBuffer } from "./snapshots";

/**
 * The received timeline, driven with synthetic arrival times.
 *
 * None of this could be tested while it was six private fields inside a
 * 562-line `NetGame` that opens a WebSocket in its constructor — which is why
 * the playout clock spent years unable to rebuild its own jitter budget.
 */

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
    today: { day: 1, earned: 0, tips: 0, rent: 0, served: 0, lost: {} },
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

/** One chef walking right, one frame every `gap` ms. */
function feed(buffer: SnapshotBuffer, count: number, gap: number, from = 1000): number {
  let at = from;
  for (let i = 0; i < count; i++) {
    buffer.push(frame(i, [{ id: 0, x: i, y: 0 }]), at);
    at += gap;
  }
  return at - gap;
}

describe("the playout clock", () => {
  test("starts one delay behind the first frame", () => {
    const buffer = new SnapshotBuffer();
    expect(buffer.push(frame(0), 1000)).toBe(true);
    expect(buffer.playout).toBe(1000 - PLAYOUT_DELAY);
  });

  test("only the first frame reports as the first", () => {
    const buffer = new SnapshotBuffer();
    expect(buffer.push(frame(0), 1000)).toBe(true);
    expect(buffer.push(frame(1), 1050)).toBe(false);
  });

  test("rebuilds its lead after a stall", () => {
    // The bug this class was extracted to fix. The clock used to advance at
    // exactly 1x and be *clamped* at the newest frame, so a stall long enough
    // to reach that clamp spent the jitter budget permanently — frames resume
    // at 1x, the clock advances at 1x, and the lead stays at zero for ever.
    // Reading exactly at the newest frame leaves no headroom for the next bit
    // of jitter, which is what the delay exists to absorb.
    const buffer = new SnapshotBuffer();
    let at = feed(buffer, 5, 50);

    // Stall: no frames, the clock runs on until it hits the newest one.
    for (let i = 0; i < 24; i++) buffer.advance(1000 / 60);
    expect(at - buffer.playout).toBe(0);

    // Frames resume at their normal cadence. The lead comes back on its own.
    for (let i = 0; i < 900; i++) {
      buffer.advance(1000 / 60);
      if (i % 3 === 0) {
        at += 50;
        buffer.push(frame(6 + i, [{ id: 0, x: 6 + i, y: 0 }]), at);
      }
    }
    // Not exactly PLAYOUT_DELAY: the lead sawtooths by one tick between
    // arrivals, because the clock advances every tick and frames land every
    // third one. Recovering to within a tick of the target is the property.
    const lead = at - buffer.playout;
    expect(lead).toBeGreaterThan(PLAYOUT_DELAY - 1000 / 60 - 1);
    expect(lead).toBeLessThanOrEqual(PLAYOUT_DELAY);
  });

  test("never reads past the newest frame", () => {
    // There is nothing there to interpolate towards, and extrapolating is how a
    // chef slides through a wall.
    const buffer = new SnapshotBuffer();
    const at = feed(buffer, 3, 50);
    for (let i = 0; i < 600; i++) buffer.advance(1000 / 60);
    expect(buffer.playout).toBeLessThanOrEqual(at);
  });

  test("jumps rather than slews out of a very long stall", () => {
    const buffer = new SnapshotBuffer();
    feed(buffer, 2, 50);
    // Ten seconds later, a frame arrives. Slewing 5% would take minutes.
    buffer.push(frame(99, [{ id: 0, x: 99, y: 0 }]), 11_000);
    buffer.advance(1000 / 60);
    expect(buffer.playout).toBeGreaterThan(11_000 - PLAYOUT_DELAY - 100);
  });
});

describe("sampling", () => {
  test("interpolates between the two frames that bracket the moment", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(frame(0, [{ id: 0, x: 0, y: 0 }]), 1000);
    buffer.push(frame(1, [{ id: 0, x: 10, y: 20 }]), 1100);
    expect(buffer.sample("players", 0, 1050)).toEqual({ x: 5, y: 10 });
    expect(buffer.sample("players", 0, 1000)).toEqual({ x: 0, y: 0 });
    expect(buffer.sample("players", 0, 1100)).toEqual({ x: 10, y: 20 });
  });

  test("two points a tick apart differ while an entity is moving", () => {
    // This is what the walk cycle is derived from: if `prevPos === pos`, a
    // sliding chef animates as if standing still.
    const buffer = new SnapshotBuffer();
    feed(buffer, 20, 50);
    // Far enough in that the clock is inside the timeline rather than still
    // behind its first frame, which is where it deliberately starts.
    for (let i = 0; i < 30; i++) buffer.advance(1000 / 60);

    const now = buffer.sample("players", 0, buffer.playout);
    const before = buffer.sample("players", 0, buffer.playout - 1000 / 60);
    expect(now).not.toBeNull();
    expect(before).not.toBeNull();
    expect(now?.x).not.toBeCloseTo(before?.x ?? 0, 6);
  });

  test("an entity in only one of the two frames uses the frame that has it", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(frame(0, []), 1000);
    buffer.push(frame(1, [{ id: 7, x: 3, y: 4 }]), 1100);
    expect(buffer.sample("players", 7, 1050)).toEqual({ x: 3, y: 4 });
  });

  test("an entity in neither frame is absent, not an origin", () => {
    // Returning {0,0} would park a departed chef in the corner of the kitchen.
    const buffer = new SnapshotBuffer();
    buffer.push(frame(0, [{ id: 0, x: 5, y: 5 }]), 1000);
    expect(buffer.sample("players", 99, 1000)).toBeNull();
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
    feed(buffer, 10, 50);
    expect(buffer.size).toBe(10);

    buffer.push(frame(0, [{ id: 0, x: 99, y: 99 }]), 2000);
    expect(buffer.size).toBe(1);
    expect(buffer.sample("players", 0, 2000)).toEqual({ x: 99, y: 99 });
  });

  test("an ordinary frame does not drop the timeline", () => {
    const buffer = new SnapshotBuffer();
    feed(buffer, 10, 50);
    buffer.push(frame(10, [{ id: 0, x: 10, y: 0 }]), 2000);
    expect(buffer.size).toBe(11);
  });

  test("clear returns it to un-started", () => {
    const buffer = new SnapshotBuffer();
    feed(buffer, 4, 50);
    expect(buffer.started).toBe(true);
    buffer.clear();
    expect(buffer.started).toBe(false);
    expect(buffer.newest).toBeNull();
    expect(buffer.push(frame(0), 5000)).toBe(true);
  });

  test("holds a bounded number of frames", () => {
    const buffer = new SnapshotBuffer();
    feed(buffer, 500, 50);
    expect(buffer.size).toBeLessThanOrEqual(40);
  });
});
