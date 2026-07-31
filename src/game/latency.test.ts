import { describe, expect, test } from "bun:test";
import { LEVEL } from "../data/level";
import { DT } from "../sim/step";
import { beginDay } from "../sim/day";
import type { Appliance, Effect, Inputs, Player, PlayerInput, World } from "../sim/types";
import { mintPlate } from "../sim/plates";
import { wallBetween } from "../sim/walls";
import { emptyInput, playerById } from "../sim/world";
import { Host, TARGET_QUEUE } from "./host";
import { LocalGame } from "./local";
import { NetGame } from "./net";
import { OPEN, type Socket } from "./connection";
import {
  SEND_EVERY,
  encodeFrame,
  encodeLayout,
  layoutVersion,
  type Frame,
  type ServerMessage,
} from "./protocol";
import { decode, parseClientMessage } from "./wire";

/**
 * How long the game takes to answer you, in milliseconds, measured.
 *
 * "It feels laggy at 200ms" is not a number anybody can improve against, and
 * playing it to find out is both slow and unrepeatable. So this drives the
 * **real client** — `NetGame`, its reconciler, its playout buffer — against the
 * **real `Host`** the server runs, with a virtual clock and a pipe between them
 * that costs whatever latency we ask for. Nothing here reimplements the netcode;
 * the two seams (a socket that is not a `WebSocket`, a clock that is not the
 * wall) exist for this and nothing else.
 *
 * What it measures is the only thing a player can perceive: the time between
 * pressing a button and the **drawn world** — `game.world`, what `View` is
 * handed — showing the result. Everything before that is bookkeeping.
 *
 * The two answers are deliberately different, and that difference is the whole
 * finding: movement is predicted and costs one tick, handling is not and costs
 * a round trip. See `docs/multiplayer.md`.
 */

const TICK_MS = DT * 1000;

/**
 * The client's frame loop and the server's are free-running and unrelated, so
 * starting them half a tick apart is a fairer guess than starting them together
 * — which would give the input queue a perfect alignment it never has in life.
 */
const PHASE = TICK_MS / 2;

/** Mirrors the server's own floor on bringing a frame forward. */
const EARLY_AFTER = 2;

/** Give up on a measurement after this long. A failure, not a result. */
const PATIENCE = 3000;

// --- the wire ----------------------------------------------------------------

/**
 * One direction of the link.
 *
 * Arrival times are forced to be monotonic because this is TCP underneath: a
 * WebSocket does not reorder, it stalls. Modelling delay as "each message
 * independently late" would quietly invent a network nobody has.
 */
class Pipe {
  private queue: { at: number; data: string }[] = [];
  private last = 0;

  constructor(private readonly delay: number) {}

  send(now: number, data: string): void {
    this.last = Math.max(this.last, now + this.delay);
    this.queue.push({ at: this.last, data });
  }

  due(now: number): string[] {
    const arrived: string[] = [];
    while (this.queue.length > 0 && (this.queue[0]?.at ?? Infinity) <= now) {
      arrived.push(this.queue.shift()!.data);
    }
    return arrived;
  }
}

/** The five members of `WebSocket` that `Connection` actually uses. */
class FakeSocket implements Socket {
  readyState = OPEN;
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  constructor(private readonly out: (data: string) => void) {}

  send(data: string): void {
    this.out(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void,
    options?: { signal?: AbortSignal },
  ): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
    options?.signal?.addEventListener("abort", () => set.delete(listener));
  }

  emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/**
 * The kitchen server, minus everything a client cannot feel.
 *
 * Rooms, saves, seat reclaim and rate limiting are all absent on purpose —
 * `server.test.ts` covers those against a real process. What is kept is exactly
 * what sits in the latency path: the handshake, one `Host`, and the broadcast
 * schedule, early frames and all.
 */
class Server {
  readonly host = new Host(null, LEVEL);
  private readonly seats = new Map<Wire, number[]>();
  private sinceFrame = 0;
  private layout = layoutVersion(this.host.world);

  receive(from: Wire, raw: string): void {
    const message = decode(raw, parseClientMessage);
    if (!message) return;
    switch (message.t) {
      case "hello": {
        const you = [this.host.join(message.name)];
        this.seats.set(from, you);
        from.deliver({
          t: "welcome",
          room: "TEST",
          level: this.host.level.id,
          you,
          layout: encodeLayout(this.host.world),
          frame: this.frame(),
        });
        break;
      }
      case "input": {
        // A connection may only move its own chefs, exactly as the real one
        // insists — which matters here because there is now more than one.
        const mine = this.seats.get(from) ?? [];
        for (const [id, input] of Object.entries(message.inputs)) {
          if (mine.includes(Number(id))) this.host.enqueue(Number(id), message.seq, input);
        }
        break;
      }
      case "ping":
        from.deliver({ t: "pong", sent: message.sent });
        break;
    }
  }

  seatsOf(wire: Wire): number[] {
    return this.seats.get(wire) ?? [];
  }

  tick(elapsed: number): void {
    const ticks = this.host.advance(elapsed, { maxTicks: 8 });
    this.sinceFrame += Math.max(1, ticks);
    const version = layoutVersion(this.host.world);
    if (version !== this.layout) {
      this.layout = version;
      this.broadcast({ t: "layout", layout: encodeLayout(this.host.world) });
    }
    // A press brings the next frame forward; see `EARLY_AFTER` in the server.
    const early = this.host.acted && this.sinceFrame >= EARLY_AFTER;
    if (this.sinceFrame >= SEND_EVERY || early) {
      this.sinceFrame = 0;
      this.frames++;
      this.broadcast({ t: "frame", frame: this.frame() });
    }
  }

  /** How many frames this server has sent, for the bandwidth question. */
  frames = 0;

  private broadcast(message: ServerMessage): void {
    for (const wire of this.seats.keys()) wire.deliver(message);
  }

  private frame(): Frame {
    return encodeFrame(this.host.world, this.host.acks);
  }
}

/** One connection, from the server's side of it. */
type Wire = { deliver(message: ServerMessage): void };

// --- the harness -------------------------------------------------------------

/**
 * One player's browser: a socket, a pipe each way, and the real client.
 *
 * Its frame loop is driven by the `Link` rather than owning a clock, so two of
 * these can be run against one server with a different round trip each — which
 * is how "Ann grabs a plate, when does Bea see it" becomes a number.
 */
class Peer implements Wire {
  readonly game: NetGame;
  readonly socket: FakeSocket;
  /** Payload bytes over this connection, for the question of what it all costs. */
  down = 0;
  up = 0;
  private readonly pipe: Pipe;
  private next: number;
  private held = emptyInput();

  constructor(
    private readonly link: Link,
    readonly name: string,
    readonly rtt: number,
    phase: number,
  ) {
    const up = new Pipe(rtt / 2);
    this.pipe = new Pipe(rtt / 2);
    this.next = phase;
    this.socket = new FakeSocket((data) => {
      this.up += data.length;
      up.send(link.now, data);
    });
    this.game = new NetGame("ws://test/ws", "TEST", name, 1, `token-${name}`, () => {}, LEVEL, {
      open: () => this.socket,
      now: () => link.now,
    });
    link.uplink(this, up);
    this.socket.emit("open", {});
  }

  deliver(message: ServerMessage): void {
    const data = JSON.stringify(message);
    this.down += data.length;
    this.pipe.send(this.link.now, data);
  }

  /** Called once per millisecond of virtual time by the `Link`. */
  step(now: number): void {
    for (const data of this.pipe.due(now)) this.socket.emit("message", { data });
    if (now < this.next) return;
    this.next += TICK_MS;
    this.game.update(DT, () => this.inputs());
  }

  /**
   * A dropped frame: the browser misses one turn of its loop and runs the two
   * ticks it owes on the next. Ordinary on any machine, and the cheapest way to
   * put a second input into the server's queue in one go.
   */
  hiccup(): void {
    this.next += TICK_MS;
    this.link.advance(TICK_MS);
    this.game.update(DT * 2, () => this.inputs());
  }

  /** Hold a control down. Everything else is released. */
  press(control: Partial<PlayerInput>): void {
    this.held = { ...emptyInput(), ...control };
  }

  release(): void {
    this.held = emptyInput();
  }

  /** Our own chef, as this browser's renderer would find them. */
  me(): Player | undefined {
    return this.sees(this.game.localIds[0] ?? -1);
  }

  /** Anybody's chef, as this browser sees them. */
  sees(id: number): Player | undefined {
    return this.game.world.players.find((player) => player.id === id);
  }

  get id(): number {
    return this.game.localIds[0] ?? -1;
  }

  private inputs(): Inputs {
    const id = this.game.localIds[0];
    if (id === undefined) return {};
    return { [id]: { ...this.held, move: { ...this.held.move } } };
  }
}

/** A server, and the browsers connected to it. */
class Link {
  now = 0;
  readonly server = new Server();
  readonly peers: Peer[] = [];
  private readonly ups: { peer: Peer; pipe: Pipe }[] = [];
  private nextServer = PHASE;

  constructor(readonly rtt: number) {
    this.join("Ann", rtt);
  }

  /** Another browser in the same kitchen, on a link of its own. */
  join(name: string, rtt = this.rtt): Peer {
    // Started a third of a tick apart, because two browsers are not in step
    // with each other any more than either is with the server.
    const peer = new Peer(this, name, rtt, (this.peers.length * TICK_MS) / 3);
    this.peers.push(peer);
    return peer;
  }

  /** Registered by a `Peer` as it is built; the link pumps it. */
  uplink(peer: Peer, pipe: Pipe): void {
    this.ups.push({ peer, pipe });
  }

  /** Run the virtual clock forward, a millisecond at a time. */
  advance(ms: number): void {
    const end = this.now + ms;
    while (this.now < end) {
      this.now++;
      for (const { peer, pipe } of this.ups) {
        for (const data of pipe.due(this.now)) this.server.receive(peer, data);
      }
      if (this.now >= this.nextServer) {
        this.nextServer += TICK_MS;
        this.server.tick(DT);
      }
      for (const peer of this.peers) peer.step(this.now);
    }
  }

  /** The first browser, which most of these tests only need one of. */
  get first(): Peer {
    return this.peers[0]!;
  }

  get game(): NetGame {
    return this.first.game;
  }

  press(control: Partial<PlayerInput>): void {
    this.first.press(control);
  }

  release(): void {
    this.first.release();
  }

  hiccup(): void {
    this.first.hiccup();
  }

  /** Run until the drawn world says so, and report how long that took. */
  waitFor(done: () => boolean, limit = PATIENCE): number {
    const start = this.now;
    while (this.now - start < limit) {
      this.advance(1);
      if (done()) return this.now - start;
    }
    return Infinity;
  }

  /** Our chef, as the first browser's renderer would find them. */
  me(): Player | undefined {
    return this.first.me();
  }

  /** A chef on the server, which is the one that is actually true. */
  theirs(peer: Peer = this.first): Player | undefined {
    return peer.id < 0 ? undefined : playerById(this.server.host.world, peer.id);
  }

  queueDepth(peer: Peer = this.first): number {
    return this.server.host.queueDepth(peer.id);
  }

  dispose(): void {
    for (const peer of this.peers) peer.game.dispose();
  }
}

/**
 * A chef standing at a crate, in an open kitchen, with both ends agreeing.
 *
 * The day is opened on the server rather than by pressing `Start`, and the chef
 * is placed rather than walked, because neither is what is being measured and
 * both would add a round trip of setup to every case.
 */
function ready(rtt: number, facing: (appliance: Appliance) => boolean = isCrate): Link {
  const link = new Link(rtt);
  link.advance(rtt + 200);
  expect(link.game.status).toBe("online");

  beginDay(link.server.host.world);
  standFacing(link.server.host.world, link.theirs()!, facing, new Set());

  // Let the move and the phase reach the client, so the measurement that
  // follows is timing one action rather than the setup in front of it.
  link.advance(rtt + 200);
  expect(link.game.world.phase).toBe("service");
  expect(link.me()?.pos.x).toBeCloseTo(link.theirs()!.pos.x, 3);
  return link;
}

const isCrate = (appliance: Appliance): boolean => appliance.source !== null;

/**
 * Put a chef on a free tile beside an appliance of this sort, looking at it.
 *
 * `taken` keeps two chefs from being posted to the same crate, which they
 * otherwise would be: the search is deterministic and would hand both the first
 * one it found, and two chefs on one tile is a shove, not a setup.
 */
function standFacing(
  world: World,
  player: Player,
  wanted: (appliance: Appliance) => boolean,
  taken: Set<number>,
): Appliance {
  for (const appliance of world.appliances.values()) {
    if (!wanted(appliance) || taken.has(appliance.id)) continue;
    for (const [dx, dy] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ]) {
      const x = appliance.tile.x + dx!;
      const y = appliance.tile.y + dy!;
      const tile = world.tiles[y * world.width + x];
      if (!tile || world.applianceAt[y * world.width + x]) continue;
      if (wallBetween(world, appliance.tile, { x, y })) continue;
      player.pos = { x: x + 0.5, y: y + 0.5 };
      player.prevPos = { ...player.pos };
      player.facing = { x: appliance.tile.x - x, y: appliance.tile.y - y };
      taken.add(appliance.id);
      return appliance;
    }
  }
  throw new Error("no such appliance with room to stand at it");
}

// --- measuring ---------------------------------------------------------------

/** The links worth caring about: a LAN, a country away, and a continent away. */
const LADDER = [0, 30, 180];

/**
 * Press something, and say how the drawn world will show that it happened.
 *
 * One function rather than two so it can read the world *at the moment of the
 * press* — "has our chef moved" is a question about where they were.
 */
type Action = (link: Link) => () => boolean;

const MOVING: Action = (link) => {
  const before = link.me()!.pos.x;
  link.press({ move: { x: 1, y: 0 } });
  return () => Math.abs(link.me()!.pos.x - before) > 0.001;
};

const GRABBING: Action = (link) => {
  link.press({ grab: true });
  return () => link.me()?.carried != null;
};

type Spread = { min: number; mean: number; max: number };

/**
 * The same action at every phase of the broadcast cycle.
 *
 * A single press is worth very little as a number: at 20Hz it can land just
 * before a frame goes out or just after one did, which is 50ms of difference
 * that says nothing about the link. What a player feels over an evening is this
 * spread, so this is what gets reported — and `max` is the honest one, because
 * the worst case is the one that makes an interaction feel unreliable.
 */
function sweep(rtt: number, action: Action): Spread {
  const results: number[] = [];
  for (let offset = 0; offset < SEND_EVERY * TICK_MS; offset += 5) {
    const link = ready(rtt);
    link.advance(offset);
    const seen = action(link);
    results.push(link.waitFor(seen));
    link.dispose();
  }
  const total = results.reduce((sum, ms) => sum + ms, 0);
  return {
    min: Math.min(...results),
    mean: Math.round(total / results.length),
    max: Math.max(...results),
  };
}

function table(title: string, rows: [number, Spread][]): string {
  const lines = rows.map(
    ([rtt, s]) =>
      `  ${String(rtt).padStart(3)}ms link -> ${String(s.min).padStart(3)} / ` +
      `${String(s.mean).padStart(3)} / ${String(s.max).padStart(3)} ms`,
  );
  return `\n${title}  (min / mean / worst)\n${lines.join("\n")}\n`;
}

// --- what it says ------------------------------------------------------------

describe("responding to a button", () => {
  test("offline, everything lands on the very next tick", () => {
    // The floor, and what prediction exists to reach: no round trip, so the
    // only wait is for the tick that reads the button.
    const game = new LocalGame(null, 1);
    const id = game.localIds[0]!;
    beginDay(game.world);
    standFacing(game.world, playerById(game.world, id)!, isCrate, new Set());

    const grabbing: Inputs = { [id]: { ...emptyInput(), grab: true } };
    game.update(DT, () => grabbing);
    expect(playerById(game.world, id)?.carried).not.toBeNull();
  });

  test("moving lands within a tick, whatever the link is doing", () => {
    const rows = LADDER.map((rtt): [number, Spread] => [rtt, sweep(rtt, MOVING)]);
    console.log(table("move -> the chef moves", rows));
    for (const [, spread] of rows) {
      // One tick to poll the press, one to act on it — and the link does not
      // appear in the number at all. This is what prediction bought, and it is
      // the bar the rest of the interactions are being held to.
      expect(spread.max).toBeLessThanOrEqual(2 * TICK_MS + 1);
    }
  });

  test("handling lands within a tick as well, which it did not used to", () => {
    const rows = LADDER.map((rtt): [number, Spread] => [rtt, sweep(rtt, GRABBING)]);
    console.log(table("grab -> the item is in your hands", rows));
    for (const [, spread] of rows) {
      // This was the whole round trip plus a wait for the next broadcast — 44ms
      // on a perfect link and 212ms from another country — because possession was
      // the server's word and nothing else's. Now the world being drawn *is* the
      // predicted one, so a grab is as immediate as a step.
      expect(spread.max).toBeLessThanOrEqual(2 * TICK_MS + 1);
    }
  });
});

/**
 * Two chefs in one kitchen, both settled, standing at crates of their own.
 *
 * The day is opened and the chefs are placed on the server rather than walked
 * there, for the same reason `ready` does it: neither is what is being
 * measured, and both would add a round trip of setup to every case.
 */
function pair(rttA: number, rttB: number): { link: Link; ann: Peer; bea: Peer } {
  const link = new Link(rttA);
  const bea = link.join("Bea", rttB);
  const slowest = Math.max(rttA, rttB);
  link.advance(slowest + 300);

  beginDay(link.server.host.world);
  const taken = new Set<number>();
  for (const peer of link.peers) {
    standFacing(link.server.host.world, link.theirs(peer)!, isCrate, taken);
  }
  link.advance(slowest + 300);

  const ann = link.first;
  expect(ann.game.status).toBe("online");
  expect(bea.game.status).toBe("online");
  // Each has to be able to see the other, or the measurement below is timing a
  // chef who is not there.
  expect(bea.sees(ann.id)).toBeDefined();
  expect(ann.sees(bea.id)).toBeDefined();
  return { link, ann, bea };
}

describe("watching somebody else cook", () => {
  test("their grab reaches you a round trip and a broadcast later", () => {
    // The other half of a co-op game. Your own hands are instant now; this is
    // the number that decides whether you can work a pass with somebody.
    const rows: [number, Spread][] = [];
    for (const rtt of LADDER) {
      const results: number[] = [];
      for (let offset = 0; offset < SEND_EVERY * TICK_MS; offset += 5) {
        const { link, ann, bea } = pair(rtt, rtt);
        link.advance(offset);
        ann.press({ grab: true });
        results.push(link.waitFor(() => bea.sees(ann.id)?.carried != null));
        link.dispose();
      }
      const total = results.reduce((sum, ms) => sum + ms, 0);
      rows.push([
        rtt,
        {
          min: Math.min(...results),
          mean: Math.round(total / results.length),
          max: Math.max(...results),
        },
      ]);
    }
    console.log(table("Ann grabs -> Bea sees it", rows));

    for (const [rtt, spread] of rows) {
      // Half a round trip up, the server's tick, the wait for the next of
      // twenty frames a second, and half a round trip back down.
      expect(spread.min).toBeGreaterThanOrEqual(rtt * 0.5);
    }
  });

  test("their first step reaches you later still, by the playout delay", () => {
    // Possession is read off the newest frame; *positions* are played back
    // deliberately late, so there is always a next frame to slide towards. That
    // cushion is the jitter budget, and it is charged to every remote step.
    const rows: [number, Spread][] = [];
    for (const rtt of LADDER) {
      const results: number[] = [];
      for (let offset = 0; offset < SEND_EVERY * TICK_MS; offset += 5) {
        const { link, ann, bea } = pair(rtt, rtt);
        link.advance(offset);
        const before = bea.sees(ann.id)!.pos.x;
        ann.press({ move: { x: 1, y: 0 } });
        results.push(link.waitFor(() => Math.abs(bea.sees(ann.id)!.pos.x - before) > 0.001));
        link.dispose();
      }
      const total = results.reduce((sum, ms) => sum + ms, 0);
      rows.push([
        rtt,
        {
          min: Math.min(...results),
          mean: Math.round(total / results.length),
          max: Math.max(...results),
        },
      ]);
    }
    console.log(table("Ann steps -> Bea sees her move", rows));
    for (const [, spread] of rows) expect(spread.min).toBeGreaterThan(0);
  });
});

/** A kitchen with `count` chefs in it, service open, each stood at something. */
function kitchenOf(count: number): Link {
  const link = new Link(30);
  for (const name of ["Bea", "Cal", "Dev"].slice(0, count - 1)) link.join(name);
  link.advance(500);
  beginDay(link.server.host.world);

  // A new kitchen owns two crates, so any more than two stand at counters.
  // Which is what four people in a one-dish kitchen actually do.
  const taken = new Set<number>();
  for (const peer of link.peers) {
    const at = (a: Appliance): boolean => isCrate(a) || a.kind === "counter";
    standFacing(link.server.host.world, link.theirs(peer)!, at, taken);
  }
  link.advance(500);
  expect(link.server.host.world.players).toHaveLength(count);
  return link;
}

type Cost = { down: number; up: number; frame: number; customers: number };

/** Bytes over the wire per player per second, and what a frame weighs. */
function bandwidth(link: Link, busy: boolean, seconds = 10): Cost {
  const from = link.peers.map((peer) => ({ down: peer.down, up: peer.up }));
  const frames = link.server.frames;

  for (let tick = 0; tick < seconds * 60; tick++) {
    if (busy) {
      const phase = Math.floor(tick / 12) % 2;
      for (const peer of link.peers) {
        peer.press({ move: { x: phase ? 1 : -1, y: 0 }, grab: tick % 24 === 0 });
      }
    }
    link.advance(TICK_MS);
  }

  const mean = (of: (peer: Peer, i: number) => number): number =>
    Math.round(link.peers.reduce((sum, peer, i) => sum + of(peer, i), 0) / link.peers.length);
  const sent = link.server.frames - frames;
  return {
    down: mean((peer, i) => (peer.down - from[i]!.down) / seconds),
    up: mean((peer, i) => (peer.up - from[i]!.up) / seconds),
    frame: Math.round(mean((peer, i) => peer.down - from[i]!.down) / Math.max(1, sent)),
    customers: link.server.host.world.customers.length,
  };
}

describe("what it costs to keep everybody in step", () => {
  test("the wire budget, measured rather than remembered", () => {
    // Two documents disagreed about this by a factor of two for months, because
    // it was measured once, under conditions nobody wrote down, and then
    // appliances stopped repeating "still empty, still zero" twenty times a
    // second. Payload bytes, JSON, no compression: what `Bun.serve` puts on the
    // wire.
    //
    // Chefs are what the frame grows with — ~130 bytes each, and every client is
    // sent all of them — so the number worth quoting names how many are in the
    // kitchen. A single figure for "per player" is the thing that went wrong
    // here twice.
    const rows: string[] = [];
    let worst = 0;

    for (const [chefs, busy] of [
      [1, false],
      [4, false],
      [4, true],
    ] as const) {
      const link = kitchenOf(chefs);
      // A day already under way: customers walking in, sitting, ordering.
      link.advance(4000);
      const cost = bandwidth(link, busy);
      worst = Math.max(worst, cost.frame);

      rows.push(
        `  ${chefs} chef${chefs > 1 ? "s" : ""}, ${cost.customers} in the room, ` +
          `${busy ? "cooking " : "standing"} -> ${String(cost.frame).padStart(4)} B/frame,` +
          ` down ${String(cost.down).padStart(5)} B/s, up ${String(cost.up).padStart(4)} B/s`,
      );
      link.dispose();
    }

    console.log(`\nper player, payload bytes:\n${rows.join("\n")}\n`);

    // The budget a frame is held to, and the one `host.test.ts` asserts against
    // a bare world. Over it means a frame has quietly started carrying
    // something; far under it means the documented figures have drifted again.
    expect(worst).toBeLessThan(1500);
  });
});

describe("bringing a frame forward", () => {
  test("a press is broadcast sooner, and costs no frames at all", () => {
    // Not an extra frame — the next one, moved. A press restarts the schedule
    // from where it lands, so the long-run rate is the rate it always was.
    const { link, ann } = pair(0, 0);
    link.advance(1000);

    const quietFrom = link.server.frames;
    link.advance(1000);
    const quiet = link.server.frames - quietFrom;

    const busyFrom = link.server.frames;
    for (let i = 0; i < 10; i++) {
      ann.press({ grab: true });
      link.advance(50);
      ann.release();
      link.advance(50);
    }
    const busy = link.server.frames - busyFrom;

    expect(quiet).toBeGreaterThan(15);
    expect(busy).toBeLessThanOrEqual(quiet + 1);
    link.dispose();
  });

  test("and cannot be used to make the server shout", () => {
    // A button going down every other tick is as fast as an edge can be
    // produced. Without a floor under how early "early" may be, that is a
    // broadcast every tick — to everybody in the room, from one person mashing.
    const { link, ann } = pair(0, 0);
    link.advance(500);

    const from = link.server.frames;
    for (let i = 0; i < 60; i++) {
      ann.press({ grab: i % 2 === 0 });
      link.advance(TICK_MS);
    }
    const sent = link.server.frames - from;

    // Twenty a second normally, and never more than one per `EARLY_AFTER`
    // ticks — half again the ordinary rate, and that is the ceiling.
    expect(sent).toBeLessThanOrEqual(1 / (EARLY_AFTER * DT) + 1);
    link.dispose();
  });
});

describe("guessing, and being right", () => {
  test("what we picked up stays picked up while the server catches up", () => {
    // Appearing quickly is worth nothing if it then blinks. Every frame that
    // lands re-runs our unacknowledged input from scratch, so this is the whole
    // reconciliation path asked the same question 600 times: is it still there?
    const link = ready(180);
    link.press({ grab: true });
    link.waitFor(() => link.me()?.carried != null);
    link.release();

    const ids = new Set<number>();
    let emptyHanded = 0;
    for (let i = 0; i < 600; i++) {
      link.advance(1);
      const carried = link.me()?.carried;
      if (carried) ids.add(carried.id);
      else emptyHanded++;
    }
    expect(emptyHanded).toBe(0);
    expect(link.me()?.carried?.base).toBe(link.theirs()!.carried!.base);
    // The renderer keys an item's mesh by its id and rebuilds when it changes,
    // so a guess that is re-minted on every frame is a mesh thrown away twenty
    // times a second for an item that never moved.
    expect(ids.size).toBeLessThanOrEqual(2);
    link.dispose();
  });
});

describe("what is not guessed at", () => {
  test("the morning, because guessing at it would invent appliances", () => {
    // Build-phase interaction mints entities and rewrites the layout, and a
    // client guessing at that hands out ids the server will never agree with —
    // once per replayed tick, twenty times a second, until the layout arrives.
    // Waiting costs nothing: the morning has no clock.
    const link = new Link(180);
    link.advance(380);
    expect(link.game.world.phase).toBe("build");
    standFacing(link.server.host.world, link.theirs()!, (a) => a.kind === "counter", new Set());
    link.advance(400);

    const appliances = link.game.world.appliances.size;
    link.press({ grab: true });
    link.advance(TICK_MS * 2);
    expect(link.me()?.carriedAppliance ?? null).toBeNull();

    link.advance(600);
    expect(link.me()?.carriedAppliance ?? null).not.toBeNull();
    expect(link.game.world.appliances.size).toBe(appliances);
    link.dispose();
  });
});

describe("guessing, and being wrong", () => {
  test("a grab the server refuses is taken back", () => {
    // The price of predicting possession: sometimes the kitchen was not as we
    // thought. Here the chef turns away before the press lands — which is what
    // somebody else emptying the counter first looks like from in here.
    const link = ready(180);
    link.press({ grab: true });
    link.advance(TICK_MS * 2);
    expect(link.me()?.carried).not.toBeNull();

    link.theirs()!.facing = { x: 0, y: 1 };
    link.advance(600);

    // Not "eventually": the server's answer replaces the guess wholesale, and
    // what is left has to agree with it exactly.
    expect(link.me()?.carried ?? null).toBeNull();
    expect(link.me()?.carried ?? null).toEqual(link.theirs()?.carried ?? null);
    link.dispose();
  });

  test("a predicted tick says nothing out loud, however often it is replayed", () => {
    // A replayed tick is re-run from scratch every time a frame lands. Anything
    // it *announces* would therefore be announced twenty times a second until
    // the server caught up — so a prediction may move things and may not talk.
    const link = ready(180, (appliance) => appliance.kind === "table");
    const dirty = standFacing(
      link.server.host.world,
      link.theirs()!,
      (a) => a.kind === "table",
      new Set(),
    );
    dirty.item = mintPlate(link.server.host.world);
    dirty.tip = 7;
    link.advance(400);

    link.press({ grab: true });
    link.advance(TICK_MS * 2);
    // The plate is in hand and the money is already ours, one tick after the
    // press and long before the server has heard about either.
    expect(link.me()?.carried).not.toBeNull();
    expect(link.game.world.money).toBe(link.server.host.world.money + 7);
    expect(cues(link, "tipped")).toBe(0);

    link.advance(600);
    // And when the server does say it, it says it once.
    expect(cues(link, "tipped")).toBe(1);
    expect(link.game.world.money).toBe(link.server.host.world.money);
    link.dispose();
  });
});

function cues(link: Link, kind: Effect["kind"]): number {
  return link.game.world.effects.filter((cue) => cue.kind === kind).length;
}

/**
 * Two chefs walking into each other, and how far the drawn one is from the
 * truth while they do it.
 *
 * Bodies are the one thing a client cannot predict: our own chef is simulated
 * *now*, everybody else is drawn on the playout clock a broadcast and half a
 * round trip in the past. So a shove resolved against a chef who is not
 * standing where we think produces a correction every single frame — which is
 * what "we desync when we walk through each other" is a description of.
 */
function shoving(rtt: number): { peak: number; mean: number } {
  const link = new Link(rtt);
  const bea = link.join("Bea", rtt);
  link.advance(rtt + 400);
  beginDay(link.server.host.world);

  // Facing each other down an empty aisle, three tiles apart.
  const world = link.server.host.world;
  const places = [
    { x: 13.5, y: 6.5 },
    { x: 16.5, y: 6.5 },
  ];
  link.peers.forEach((peer, i) => {
    const player = playerById(world, peer.id)!;
    player.pos = { ...places[i]! };
    player.prevPos = { ...places[i]! };
  });
  link.advance(rtt + 400);

  link.first.press({ move: { x: 1, y: 0 } });
  bea.press({ move: { x: -1, y: 0 } });

  let peak = 0;
  let total = 0;
  let samples = 0;
  for (let i = 0; i < 2000; i++) {
    link.advance(1);
    for (const peer of link.peers) {
      const off = peer.game.correctionOf(peer.id);
      peak = Math.max(peak, off);
      total += off;
      samples++;
    }
  }
  link.dispose();
  return { peak, mean: total / Math.max(1, samples) };
}

describe("walking into each other", () => {
  test("a shove does not put the drawn chef somewhere else", () => {
    const rows = LADDER.map((rtt) => [rtt, shoving(rtt)] as const);
    console.log(
      `\nchef pressed against chef  (correction carried, tiles)\n${rows
        .map(
          ([rtt, e]) =>
            `  ${String(rtt).padStart(3)}ms link -> mean ${e.mean.toFixed(3)}, worst ${e.peak.toFixed(3)}`,
        )
        .join("\n")}\n`,
    );
    for (const [, error] of rows) {
      // Nothing to walk off at all. While chefs shoved each other in the
      // simulation this was 0.21 tiles on a perfect link and 0.47 — one and a
      // half body widths — from another country, every frame the two of them
      // were touching.
      expect(error.peak).toBeLessThan(0.05);
    }
  });
});

describe("the server's input queue", () => {
  test("dropped client frames no longer pile up in it", () => {
    // Read at exactly the rate it is written, a queue can only shrink by
    // running dry, and one being kept full never does — so each dropped frame
    // used to leave a tick of latency in front of everything that player did
    // afterwards, for as long as they kept moving. Ten of them, ten ticks, and
    // only standing still took them back out.
    const link = ready(30);
    link.press({ move: { x: 1, y: 0 } });
    link.advance(500);
    const settled = link.queueDepth();

    let peak = settled;
    for (let i = 0; i < 10; i++) {
      link.hiccup();
      peak = Math.max(peak, link.queueDepth());
      link.advance(20);
      peak = Math.max(peak, link.queueDepth());
    }
    link.advance(1000);
    const after = link.queueDepth();

    expect(settled).toBeLessThanOrEqual(TARGET_QUEUE);
    // A dropped frame delivers its two ticks between two of the server's, so
    // the depth spikes by two and is walked back down — rather than settling
    // one higher than it started, ten times over.
    expect(peak).toBeLessThanOrEqual(TARGET_QUEUE + 2);
    expect(after).toBeLessThanOrEqual(TARGET_QUEUE);
    link.dispose();

    console.log(
      `\nserver input queue across 10 dropped frames: ${settled} settled,` +
        ` ${peak} at worst, ${after} after\n`,
    );
  });
});
