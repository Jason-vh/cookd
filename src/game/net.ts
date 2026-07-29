import { LEVEL, type LevelDef } from "../data/level";
import { DT, predict } from "../sim/step";
import type { Inputs, PlayerInput, World } from "../sim/types";
import { createWorld, emptyInput, isIdleInput } from "../sim/world";
import type { Game } from "./game";
import type { MenuAction } from "./host";
import {
  PROTOCOL_VERSION,
  applyFrame,
  applyLayout,
  type ClientMessage,
  type Frame,
  type Layout,
  type ServerMessage,
} from "./protocol";
import { decode, parseServerMessage } from "./wire";
import { SnapshotBuffer } from "./snapshots";

/**
 * The networked client.
 *
 * Three clocks have to be reconciled here, and keeping them straight is most of
 * the difficulty:
 *
 *  - the **server's** clock, which is authoritative and arrives ~20 times a
 *    second, late and jittery;
 *  - the **playout** clock, deliberately held a little behind the newest frame
 *    so there is always a pair of frames to interpolate between;
 *  - the **prediction** clock, which runs our own chefs *now*, because on a
 *    ~180ms link (Europe to South Africa) waiting for the server to confirm
 *    every step would make walking feel like steering a boat.
 *
 * Everything is sampled onto tick boundaries before it reaches the renderer, so
 * `View` still receives a plain `World` plus one `alpha` and cannot tell the
 * difference between this and local play.
 */

const HISTORY = 240;

/**
 * Per-tick decay of prediction error, and the point at which we give up and
 * snap instead.
 *
 * The server can legitimately refuse to apply input we already predicted — if a
 * stalled link dumps half a second of input at once it drops the oldest, since
 * that time has already passed (see `host.ts`). Our chef is then simply wrong,
 * by as much as two tiles, and hard-correcting teleports them across the
 * kitchen mid-stride.
 *
 * So the correction is carried as an offset that decays to nothing over ~200ms.
 * You keep control the whole time; the chef just slides back into place. Beyond
 * the cap something has gone badly wrong (a reset, a very long stall) and being
 * in the right place matters more than being smooth about it.
 */
const ERROR_DECAY = 0.8;
const MAX_ERROR = 2.5;

/**
 * Reconnect backoff.
 *
 * This used to be a flat 1500ms with no ceiling and no terminal state, which is
 * fine for one tab and a blip and actively harmful for the case it was actually
 * used in: a deploy. Every tab that was open when we shipped a protocol bump
 * retried forever, at the same instant, against the box that had just
 * restarted — and the server's "refresh the page" error was consumed by a
 * `console.warn` nobody was reading.
 *
 * Jitter matters as much as the ceiling. Without it, backing off in lockstep
 * just makes a slower thundering herd.
 */
const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 20_000;

function reconnectDelay(attempt: number): number {
  const capped = Math.min(RECONNECT_MAX, RECONNECT_BASE * 2 ** attempt);
  return capped * (0.5 + Math.random() * 0.5);
}

/**
 * `Inputs` allows a missing seat (`PlayerInput | undefined`) because the sim
 * tolerates one; the wire does not, because "absent" and "present but
 * undefined" are the same thing in JSON and only one of them is meant.
 */
function definedInputs(inputs: Inputs): Record<number, PlayerInput> {
  const out: Record<number, PlayerInput> = {};
  for (const [id, input] of Object.entries(inputs)) {
    if (input) out[Number(id)] = input;
  }
  return out;
}

export class NetGame implements Game {
  readonly world: World;
  localIds: number[] = [];
  ping: number | null = null;
  status: Game["status"] = "connecting";
  alpha = 0;

  private socket: WebSocket | null = null;
  private listeners: AbortController | null = null;
  private readonly url: string;
  private readonly room: string;
  private name: string;
  private readonly token: string;
  private wantedPlayers: number;

  /** The received timeline and the clock that reads it. */
  private readonly snapshots = new SnapshotBuffer();

  /** Our own chefs, run ahead of the server. */
  private prediction: World;
  private history: { seq: number; inputs: Inputs }[] = [];
  private seq = 0;
  /**
   * Whether the last input we actually sent was an idle one. Reset whenever the
   * set of local chefs changes, so the next tick restates the whole payload for
   * its new shape rather than leaving a freshly joined seat unmentioned.
   */
  private sentIdle = false;
  private accumulator = 0;

  /** Smoothed-away difference between where we predicted and where we are. */
  private error = new Map<number, { x: number; y: number }>();
  private layoutIds = new Set<number>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private attempts = 0;

  /**
   * Set when the server has told us not to come back. A version mismatch or a
   * full server is not fixed by trying again, and pretending otherwise is how
   * one deploy becomes a self-inflicted denial of service.
   */
  private fatal: string | null = null;

  /** Told what went wrong, so the shell can put it in front of the player. */
  readonly onError: (message: string, fatal: boolean) => void;

  readonly level: LevelDef;

  constructor(
    url: string,
    room: string,
    name: string,
    players: number,
    token: string,
    onError: (message: string, fatal: boolean) => void = () => {},
    level: LevelDef = LEVEL,
  ) {
    this.url = url;
    this.room = room;
    this.name = name;
    this.token = token;
    this.onError = onError;
    this.level = level;
    this.wantedPlayers = Math.max(1, players);
    this.world = createWorld(level, 0);
    this.prediction = createWorld(level, 0);
    this.connect();
  }

  // --- connection ------------------------------------------------------------

  private connect(): void {
    if (this.disposed || this.fatal) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    // Detach whatever came before. Without this a reconnect can leave the old
    // socket alive, which keeps its room occupied and interleaves its frames
    // with the new one's. An AbortController rather than nulling `on*` handlers:
    // one signal removes every listener this socket ever had, and cannot be
    // half-applied the way three separate assignments can.
    if (this.socket) this.closeSocket();

    this.status = this.snapshots.size > 0 ? "offline" : "connecting";
    const socket = new WebSocket(this.url);
    const listeners = new AbortController();
    const { signal } = listeners;
    this.socket = socket;
    this.listeners = listeners;

    socket.addEventListener(
      "open",
      () => {
        this.send({
          t: "hello",
          version: PROTOCOL_VERSION,
          room: this.room,
          name: this.name,
          players: this.wantedPlayers,
          token: this.token,
        });
        this.pingTimer = setInterval(() => this.send({ t: "ping", sent: Date.now() }), 2000);
      },
      { signal },
    );

    socket.addEventListener(
      "message",
      (event) => {
        // Validated, not cast. "The server is trustworthy" is an assumption
        // about a deployment rather than about a socket, and a half-upgraded
        // server mid-deploy is the ordinary way it stops being true.
        const message = decode(event.data, parseServerMessage);
        if (message) this.receive(message);
      },
      { signal },
    );

    // Browsers fire `error` *and then* `close` for the same failed socket, so
    // this must only ever run once — otherwise two reconnects are scheduled and
    // the client ends up with two live connections and two sets of chefs.
    let dropped = false;
    const drop = (): void => {
      if (dropped) return;
      dropped = true;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.disposed || this.socket !== socket) return;
      this.status = "offline";
      if (this.fatal) return;
      // Keep playing what we have and try again; a dropped connection should
      // look like the kitchen freezing, not like the game crashing.
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), reconnectDelay(this.attempts++));
    };
    socket.addEventListener("close", drop, { signal });
    socket.addEventListener("error", drop, { signal });
  }

  private closeSocket(): void {
    this.listeners?.abort();
    this.listeners = null;
    try {
      this.socket?.close();
    } catch {
      /* already gone */
    }
    this.socket = null;
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private receive(message: ServerMessage): void {
    switch (message.t) {
      case "welcome":
        // Back to a clean slate: the next drop should retry promptly rather
        // than inheriting the backoff from whatever went wrong before.
        this.attempts = 0;
        // The server names its kitchen, and we may be drawing a different one.
        //
        // Rebuilding the world here would not be enough: `View` bakes the walls
        // and floor into one static batch at construction, so which level is
        // running is the shell's decision, not ours. Saying so plainly beats
        // playing on with somebody else's floor plan — which is what happened
        // before, silently, because the client simply assumed the one level it
        // was compiled with.
        if (message.level !== this.level.id) {
          this.die(`This kitchen is "${message.level}" — refresh to load it`);
          return;
        }
        // A reconnect is a *new session*: new ids, acks back at zero, and the
        // old frames describe players that no longer exist. Carrying any of it
        // over would replay the entire input history into the new world on the
        // first reconcile and interpolate chefs towards stale positions.
        this.localIds = message.you;
        this.wantedPlayers = message.you.length;
        this.snapshots.clear();
        this.history.length = 0;
        this.sentIdle = false;
        this.error.clear();
        this.seq = 0;
        this.applyLayout(message.layout);
        this.pushFrame(message.frame);
        this.status = "online";
        break;
      case "layout":
        this.applyLayout(message.layout);
        break;
      case "frame":
        this.pushFrame(message.frame);
        this.status = "online";
        break;
      case "joined":
        if (!this.localIds.includes(message.id)) this.localIds.push(message.id);
        // A new seat changes the shape of the input payload, so the next tick
        // has to state it in full even if everyone is standing still.
        this.sentIdle = false;
        break;
      case "pong":
        this.ping = Date.now() - message.sent;
        break;
      case "error":
        if (message.fatal) this.die(message.message);
        else this.onError(message.message, false);
        break;
    }
  }

  // --- applying server state --------------------------------------------------

  private applyLayout(layout: Layout): void {
    applyLayout(this.world, layout);
    applyLayout(this.prediction, layout);
    this.layoutIds = new Set(layout.appliances.map((a) => a.id));
  }

  /** Stop trying, and say why. */
  private die(message: string): void {
    this.fatal = message;
    this.status = "offline";
    this.closeSocket();
    this.onError(message, true);
  }

  private pushFrame(frame: Frame): void {
    // Frames and layout must agree on which appliances exist; if they don't we
    // are between a reset and its layout message, so wait for it.
    if (frame.appliances.some((a) => !this.layoutIds.has(a.id))) return;

    if (this.snapshots.push(frame, performance.now())) {
      applyFrame(this.world, frame);
      applyFrame(this.prediction, frame);
      for (const snapshot of frame.players) this.seedPlayer(this.world, snapshot.id, snapshot);
    }
    this.reconcile(frame);
  }

  private seedPlayer(world: World, id: number, at: { x: number; y: number }): void {
    const player = world.players.find((p) => p.id === id);
    if (!player) return;
    player.pos = { x: at.x, y: at.y };
    player.prevPos = { x: at.x, y: at.y };
  }

  /**
   * Re-run our own inputs on top of the server's latest word.
   *
   * The server tells us the last input sequence it applied. Everything we have
   * sent since then it has not seen yet, so we replay it locally — that is what
   * keeps our chef under our thumb on a slow link while still ending up exactly
   * where the server says.
   */
  private reconcile(frame: Frame): void {
    // Where we thought our chefs were, before the server got a word in.
    const believed = new Map<number, { x: number; y: number }>();
    for (const id of this.localIds) {
      const player = this.prediction.players.find((p) => p.id === id);
      if (player) believed.set(id, { x: player.pos.x, y: player.pos.y });
    }

    applyFrame(this.prediction, frame);
    for (const snapshot of frame.players) {
      this.seedPlayer(this.prediction, snapshot.id, snapshot);
      const player = this.prediction.players.find((p) => p.id === snapshot.id);
      if (player) player.facing = { x: snapshot.fx, y: snapshot.fy };
    }

    // A seat the server has not acked *anything* for is not "acked at zero" —
    // it is a seat with nothing outstanding. Reading it as zero meant that
    // adding a second local player mid-session retained the entire history and
    // replayed all 240 entries through the simulation on a single frame, which
    // is a visible hitch; and if a seat ever left `acks` without a fresh
    // `welcome`, it pinned the replay at 240 ticks per frame, forever.
    const acked = Math.min(this.seq, ...this.localIds.map((id) => frame.acks[id] ?? this.seq));
    this.history = this.history.filter((entry) => entry.seq > acked);
    for (const entry of this.history) predict(this.prediction, entry.inputs);

    // Whatever we got wrong becomes an offset to be walked off, not a teleport.
    for (const [id, was] of believed) {
      const player = this.prediction.players.find((p) => p.id === id);
      if (!player) continue;
      const carried = this.error.get(id) ?? { x: 0, y: 0 };
      const next = {
        x: carried.x + (was.x - player.pos.x),
        y: carried.y + (was.y - player.pos.y),
      };
      const size = Math.hypot(next.x, next.y);
      this.error.set(id, size > MAX_ERROR ? { x: 0, y: 0 } : next);
    }
  }

  // --- the frame loop ---------------------------------------------------------

  update(elapsed: number, poll: () => Inputs): void {
    this.accumulator += Math.min(0.25, elapsed);
    let ticks = 0;
    while (this.accumulator >= DT && ticks < 5) {
      this.tick(poll());
      this.accumulator -= DT;
      ticks++;
    }
    if (this.accumulator > DT) this.accumulator = DT;
    this.alpha = this.accumulator / DT;
  }

  private tick(inputs: Inputs): void {
    if (!this.snapshots.started) return;

    // 1. Our own chefs move immediately, and the inputs are kept so they can be
    //    replayed when the server's answer arrives.
    const mine: Inputs = {};
    for (const id of this.localIds) mine[id] = inputs[id] ?? emptyInput();

    // Standing still is not news. The server's queue already starves gracefully
    // by holding the last input it was given (see `Host.nextInputs`), so once we
    // have told it we are idle, repeating that 60 times a second only restates
    // it. A stationary chef also cannot drift apart: the server integrates the
    // same zero velocity we do, so there is nothing to reconcile.
    //
    // Only *runs* of idle collapse. The first idle tick after moving is still
    // sent, because that one is the instruction to stop.
    const idle = Object.values(mine).every((input) => !input || isIdleInput(input));
    if (!idle || !this.sentIdle) {
      this.seq++;
      this.history.push({ seq: this.seq, inputs: structuredClone(mine) });
      while (this.history.length > HISTORY) this.history.shift();
      this.send({ t: "input", seq: this.seq, inputs: definedInputs(mine) });
      this.sentIdle = idle;
    }
    predict(this.prediction, mine);

    // 2. The playout clock walks forward one tick and samples the timeline.
    this.snapshots.advance(DT * 1000);
    const latest = this.snapshots.newest;
    if (latest) applyFrame(this.world, latest);

    // 3. Remote chefs are sampled at this tick and the one before it, so the
    //    renderer's own interpolation and its walk-cycle speed both still work.
    for (const player of this.world.players) {
      if (this.localIds.includes(player.id)) {
        const predicted = this.prediction.players.find((p) => p.id === player.id);
        if (predicted) {
          // The offset is applied at both ends of the tick, decayed, so the
          // renderer still sees a sensible one-tick step and the walk cycle
          // doesn't lurch while a correction is being absorbed.
          const error = this.error.get(player.id) ?? { x: 0, y: 0 };
          const before = { ...error };
          error.x *= ERROR_DECAY;
          error.y *= ERROR_DECAY;
          this.error.set(player.id, error);

          player.prevPos = { x: predicted.prevPos.x + before.x, y: predicted.prevPos.y + before.y };
          player.pos = { x: predicted.pos.x + error.x, y: predicted.pos.y + error.y };
          player.facing = { ...predicted.facing };
          player.workingOn = predicted.workingOn;
        }
        continue;
      }
      const now = this.snapshots.sample("players", player.id, this.snapshots.playout);
      const before = this.snapshots.sample(
        "players",
        player.id,
        this.snapshots.playout - DT * 1000,
      );
      if (now && before) {
        player.prevPos = before;
        player.pos = now;
      }
      const facing = this.snapshots.facing("players", player.id);
      if (facing) player.facing = facing;
    }

    // Customers are nobody's chef, so they are always sampled — never
    // predicted. `applyFrame` has just planted them at the newest frame's
    // position; walking them back onto the playout clock is what keeps them in
    // step with the remote chefs moving around them.
    for (const customer of this.world.customers) {
      const now = this.snapshots.sample("customers", customer.id, this.snapshots.playout);
      const before = this.snapshots.sample(
        "customers",
        customer.id,
        this.snapshots.playout - DT * 1000,
      );
      if (now && before) {
        customer.prevPos = before;
        customer.pos = now;
      }
      const facing = this.snapshots.facing("customers", customer.id);
      if (facing) customer.facing = facing;
    }
  }

  // --- shell actions ----------------------------------------------------------

  addLocalPlayer(name: string): number | null {
    this.send({ t: "join", name });
    return null; // the server answers with "joined"
  }

  removeLocalPlayer(id: number): void {
    this.send({ t: "leave", id });
    this.localIds = this.localIds.filter((other) => other !== id);
    this.sentIdle = false;
    this.error.delete(id);
  }

  menu(action: MenuAction): void {
    this.send({ t: "menu", action });
  }

  reset(): void {
    this.send({ t: "reset" });
  }

  dispose(): void {
    this.disposed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.closeSocket();
  }
}
