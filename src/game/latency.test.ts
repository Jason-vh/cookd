import { describe, expect, test } from "bun:test";
import { LEVEL } from "../data/level";
import { DT } from "../sim/step";
import type { Appliance, Effect, Inputs, Player, PlayerInput, World } from "../sim/types";
import { mintPlate } from "../sim/plates";
import { emptyInput, playerById } from "../sim/world";
import { Host } from "./host";
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
 * what sits in the latency path: the handshake, one `Host`, and a broadcast
 * every `SEND_EVERY` ticks.
 */
class Server {
  readonly host = new Host(null, LEVEL);
  players: number[] = [];
  private frames = 0;
  private layout = layoutVersion(this.host.world);

  constructor(private readonly out: (message: ServerMessage) => void) {}

  receive(raw: string): void {
    const message = decode(raw, parseClientMessage);
    if (!message) return;
    switch (message.t) {
      case "hello":
        this.players = [this.host.join("Ann")];
        this.out({
          t: "welcome",
          room: "TEST",
          level: this.host.level.id,
          you: this.players,
          layout: encodeLayout(this.host.world),
          frame: this.frame(),
        });
        break;
      case "input":
        for (const [id, input] of Object.entries(message.inputs)) {
          if (this.players.includes(Number(id))) this.host.enqueue(Number(id), message.seq, input);
        }
        break;
      case "ping":
        this.out({ t: "pong", sent: message.sent });
        break;
    }
  }

  tick(elapsed: number): void {
    this.host.advance(elapsed, { maxTicks: 8 });
    this.frames++;
    const version = layoutVersion(this.host.world);
    if (version !== this.layout) {
      this.layout = version;
      this.out({ t: "layout", layout: encodeLayout(this.host.world) });
    }
    if (this.frames % SEND_EVERY === 0) this.out({ t: "frame", frame: this.frame() });
  }

  private frame(): Frame {
    return encodeFrame(this.host.world, this.host.acks);
  }
}

// --- the harness -------------------------------------------------------------

/** A client, a server, and a link of a given round trip between them. */
class Link {
  now = 0;
  readonly server: Server;
  readonly game: NetGame;
  private readonly socket: FakeSocket;
  private readonly up: Pipe;
  private readonly down: Pipe;
  private nextClient = 0;
  private nextServer = PHASE;
  private held = emptyInput();

  constructor(readonly rtt: number) {
    this.up = new Pipe(rtt / 2);
    this.down = new Pipe(rtt / 2);
    this.server = new Server((message) => this.down.send(this.now, JSON.stringify(message)));
    this.socket = new FakeSocket((data) => this.up.send(this.now, data));
    this.game = new NetGame("ws://test/ws", "TEST", "Ann", 1, "token", () => {}, LEVEL, {
      open: () => this.socket,
      now: () => this.now,
    });
    this.socket.emit("open", {});
  }

  /** Run the virtual clock forward, a millisecond at a time. */
  advance(ms: number): void {
    const end = this.now + ms;
    while (this.now < end) {
      this.now++;
      for (const data of this.up.due(this.now)) this.server.receive(data);
      for (const data of this.down.due(this.now)) this.socket.emit("message", { data });
      if (this.now >= this.nextServer) {
        this.nextServer += TICK_MS;
        this.server.tick(DT);
      }
      if (this.now >= this.nextClient) {
        this.nextClient += TICK_MS;
        this.game.update(DT, () => this.inputs());
      }
    }
  }

  /**
   * A dropped frame: the client misses one turn of its loop and runs the two
   * ticks it owes on the next. Ordinary on any machine, and the cheapest way to
   * put a second input into the server's queue in one go.
   */
  hiccup(): void {
    this.nextClient += TICK_MS;
    this.advance(TICK_MS);
    this.game.update(DT * 2, () => this.inputs());
  }

  /** Hold a control down. Everything else is released. */
  press(control: Partial<PlayerInput>): void {
    this.held = { ...emptyInput(), ...control };
  }

  release(): void {
    this.held = emptyInput();
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

  /** Our chef, as the renderer would find them. */
  me(): Player | undefined {
    return this.game.world.players.find((player) => player.id === this.game.localIds[0]);
  }

  /** The same chef on the server, which is the one that is actually true. */
  theirs(): Player | undefined {
    const id = this.server.players[0];
    return id === undefined ? undefined : playerById(this.server.host.world, id);
  }

  queueDepth(): number {
    return this.server.host.queueDepth(this.server.players[0] ?? -1);
  }

  dispose(): void {
    this.game.dispose();
  }

  private inputs(): Inputs {
    const id = this.game.localIds[0];
    if (id === undefined) return {};
    return { [id]: { ...this.held, move: { ...this.held.move } } };
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

  link.server.host.menu("startDay");
  standFacing(link.server.host.world, link.theirs()!, facing);

  // Let the move and the phase reach the client, so the measurement that
  // follows is timing one action rather than the setup in front of it.
  link.advance(rtt + 200);
  expect(link.game.world.phase).toBe("service");
  expect(link.me()?.pos.x).toBeCloseTo(link.theirs()!.pos.x, 3);
  return link;
}

const isCrate = (appliance: Appliance): boolean => appliance.source !== null;

/** Put a chef on a free tile beside an appliance of this sort, looking at it. */
function standFacing(
  world: World,
  player: Player,
  wanted: (appliance: Appliance) => boolean,
): Appliance {
  for (const appliance of world.appliances.values()) {
    if (!wanted(appliance)) continue;
    for (const [dx, dy] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ]) {
      const x = appliance.tile.x + dx!;
      const y = appliance.tile.y + dy!;
      const tile = world.tiles[y * world.width + x];
      if (!tile || tile.wall || world.applianceAt[y * world.width + x]) continue;
      player.pos = { x: x + 0.5, y: y + 0.5 };
      player.prevPos = { ...player.pos };
      player.facing = { x: appliance.tile.x - x, y: appliance.tile.y - y };
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
    game.menu("startDay");
    standFacing(game.world, playerById(game.world, id)!, isCrate);

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
    standFacing(link.server.host.world, link.theirs()!, (a) => a.kind === "counter");
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
    const dirty = standFacing(link.server.host.world, link.theirs()!, (a) => a.kind === "table");
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

describe("the server's input queue", () => {
  test("every dropped client frame adds a tick of latency, and keeps it", () => {
    const link = ready(30);
    link.press({ move: { x: 1, y: 0 } });
    link.advance(500);
    const settled = link.queueDepth();

    for (let i = 0; i < 3; i++) link.hiccup();
    link.advance(2000);
    const after = link.queueDepth();

    // A queue read at exactly the rate it is written can only ever shrink by
    // running dry, and one being kept full never does. So each dropped frame's
    // extra input is still sitting in front of everything the player presses
    // next — 16ms apiece, for as long as they keep moving.
    expect(settled).toBe(0);
    expect(after).toBe(3);

    // Standing still is what clears it, because that is the one thing that
    // stops the client refilling it. Which means the cost is invisible in any
    // test that lets go of the controls, and worst during the busiest minute of
    // a service, when nobody does.
    link.release();
    link.advance(500);
    expect(link.queueDepth()).toBe(0);
    link.dispose();

    console.log(`\nserver input queue: ${settled} settled, ${after} after 3 dropped frames\n`);
  });
});
