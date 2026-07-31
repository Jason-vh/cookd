import { LEVEL, type LevelDef, levelById } from "../data/level";
import { DT } from "../sim/step";
import type { Inputs, PlayerInput, World } from "../sim/types";
import { emptyInput } from "../sim/world";
import type { Game } from "./game";
import type { MenuAction } from "./host";
import {
  PROTOCOL_VERSION,
  applyLayout,
  type Frame,
  type Layout,
  type ServerMessage,
} from "./protocol";
import { SnapshotBuffer } from "./snapshots";
import { Reconciler } from "./reconciler";
import { Connection, type Socket } from "./connection";

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
 *
 * **There is one world**, and it is the reconciler's: the server's last word
 * with our own unacknowledged input replayed on top. Remote chefs and customers
 * are then written over it from the playout clock, because nobody predicts
 * those. It used to be two — one drawn, one predicted — with a handful of
 * fields copied from the second into the first, which meant that everything
 * nobody had thought to copy waited for the round trip. `carried` was one of
 * them, so *picking anything up* cost 44ms on a perfect link and 212ms from
 * another country (`latency.test.ts`), for an action whose whole job is to feel
 * like a button.
 */

/**
 * `Inputs` allows a missing seat (`PlayerInput | undefined`) because the sim
 * tolerates one; the wire does not, because "absent" and "present but
 * undefined" are the same thing in JSON and only one of them is meant.
 */
/**
 * The two things here that are not pure: the socket, and the clock.
 *
 * Injectable so the whole client can be driven at synthetic latency with no
 * browser and no server — which is the only way to *measure* how long the game
 * takes to answer, rather than playing it and forming an opinion. See
 * `latency.test.ts`.
 */
export type NetWiring = {
  open?: (url: string) => Socket;
  now?: () => number;
  /**
   * The room turned out to be a different kitchen from the one we loaded.
   *
   * Handed back to the *shell* rather than dealt with here, because which
   * level is running is the shell's decision: `View` bakes the walls and the
   * floor into one static batch when it is built, so the answer is a new game
   * and a new view, not a patch to this one.
   */
  onLevel?: (id: string) => void;
  /**
   * We are *making* this kitchen, so our level is a request rather than a
   * guess. Joining an existing room sends no opinion: the room's own save is
   * the answer, and a preference that can only ever be ignored should not be
   * on the wire.
   */
  creating?: boolean;
};

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

  private readonly room: string;
  private name: string;
  private readonly token: string;
  private wantedPlayers: number;

  /** The received timeline and the clock that reads it. */
  private readonly snapshots = new SnapshotBuffer();

  /** Our own chefs, run ahead of the server, and corrected when it disagrees. */
  private readonly reconciler: Reconciler;
  private accumulator = 0;

  private layoutIds = new Set<number>();

  private connection!: Connection;

  /** Arrival times for the playout clock. Wall time in the browser. */
  private readonly now: () => number;

  /** Told what went wrong, so the shell can put it in front of the player. */
  readonly onError: (message: string, fatal: boolean) => void;

  readonly level: LevelDef;

  /** Told when the room turns out to be a different kitchen. See `NetWiring`. */
  private readonly onLevel?: (id: string) => void;

  /** See `NetWiring.creating`. */
  private readonly creating: boolean;

  constructor(
    url: string,
    room: string,
    name: string,
    players: number,
    token: string,
    onError: (message: string, fatal: boolean) => void = () => {},
    level: LevelDef = LEVEL,
    wiring: NetWiring = {},
  ) {
    this.room = room;
    this.name = name;
    this.token = token;
    this.onError = onError;
    this.level = level;
    this.wantedPlayers = Math.max(1, players);
    this.onLevel = wiring.onLevel;
    this.creating = wiring.creating ?? false;
    this.now = wiring.now ?? (() => performance.now());
    this.reconciler = new Reconciler(level);
    this.world = this.reconciler.prediction;
    this.connection = new Connection(
      url,
      {
        message: (message) => this.receive(message),
        status: (status) => {
          this.status = status;
        },
        hello: () => ({
          t: "hello",
          version: PROTOCOL_VERSION,
          room: this.room,
          name: this.name,
          players: this.wantedPlayers,
          token: this.token,
          // Only heeded when this room does not exist yet: a kitchen that has
          // been played keeps its own level, and we load whatever it says.
          level: this.creating ? this.level.id : "",
        }),
        hadFrames: () => this.snapshots.size > 0,
      },
      { open: wiring.open },
    );
  }

  // --- messages --------------------------------------------------------------

  private receive(message: ServerMessage): void {
    switch (message.t) {
      case "welcome":
        // Back to a clean slate: the next drop should retry promptly rather
        // than inheriting the backoff from whatever went wrong before.
        this.connection.settled();
        // The server names its kitchen, and we may be drawing a different one.
        //
        // Rebuilding the world here would not be enough: `View` bakes the walls
        // and floor into one static batch at construction, so which level is
        // running is the shell's decision, not ours. Saying so plainly beats
        // playing on with somebody else's floor plan — which is what happened
        // before, silently, because the client simply assumed the one level it
        // was compiled with.
        if (message.level !== this.level.id) {
          // Somebody else made this room, and they chose a different kitchen.
          // Load theirs: a room code is an invitation to *their* restaurant,
          // and the alternative is telling the guest they picked wrong.
          if (this.onLevel && levelById(message.level)) {
            this.onLevel(message.level);
            return;
          }
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
        this.reconciler.reset();
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
        this.reconciler.restate();
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
    this.layoutIds = new Set(layout.appliances.map((a) => a.id));
  }

  /** Stop trying, and say why. */
  private die(message: string): void {
    this.connection.giveUp();
    this.onError(message, true);
  }

  private pushFrame(frame: Frame): void {
    // Frames and layout must agree on which appliances exist; if they don't we
    // are between a reset and its layout message, so wait for it.
    if (frame.appliances.some((a) => !this.layoutIds.has(a.id))) return;

    this.snapshots.push(frame, this.now());
    // Which both applies the frame and replays everything the server has not
    // acknowledged yet on top of it.
    this.reconciler.reconcile(frame, this.localIds);
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
    const sending = this.reconciler.record(mine);
    if (sending) {
      this.connection.send({ t: "input", seq: sending.seq, inputs: definedInputs(sending.inputs) });
    }

    // 2. Where on the server's timeline we are drawing, which is a little
    //    behind the newest thing we have been told.
    const playout = this.snapshots.playoutAt(this.now());

    // 3. Remote chefs are sampled at this tick and the one before it, so the
    //    renderer's own interpolation and its walk-cycle speed both still work.
    //    `predict` has just walked them along with our own, since it cannot tell
    //    them apart; this is what puts them back where they were seen.
    for (const player of this.world.players) {
      if (this.localIds.includes(player.id)) continue;
      const now = this.snapshots.sample("players", player.id, playout);
      const before = this.snapshots.sample("players", player.id, playout - DT * 1000);
      if (now && before) {
        player.prevPos = before;
        player.pos = now;
      }
      const facing = this.snapshots.facing("players", player.id);
      if (facing) player.facing = facing;
    }

    // Customers are nobody's chef, so they are always sampled — never
    // predicted. The last frame to arrive planted them where the server last
    // saw them; walking them back onto the playout clock is what keeps them in
    // step with the remote chefs moving around them.
    for (const customer of this.world.customers) {
      const now = this.snapshots.sample("customers", customer.id, playout);
      const before = this.snapshots.sample("customers", customer.id, playout - DT * 1000);
      if (now && before) {
        customer.prevPos = before;
        customer.pos = now;
      }
      const facing = this.snapshots.facing("customers", customer.id);
      if (facing) customer.facing = facing;
    }

    // 4. Last of all, because it is the only thing here that is about drawing
    //    rather than about being right.
    this.reconciler.show(this.localIds);
  }

  /**
   * How far this chef's prediction was from the server's answer, in tiles.
   *
   * The honest measure of desync: comparing the drawn chef against the server's
   * chef says nothing, because prediction runs half a round trip *ahead* on
   * purpose. What a player feels is the part we got wrong and are sliding back
   * off. Read by `latency.test.ts`.
   */
  correctionOf(id: number): number {
    const error = this.reconciler.errorOf(id);
    return Math.hypot(error.x, error.y);
  }

  // --- shell actions ----------------------------------------------------------

  addLocalPlayer(name: string): number | null {
    this.connection.send({ t: "join", name });
    return null; // the server answers with "joined"
  }

  removeLocalPlayer(id: number): void {
    this.connection.send({ t: "leave", id });
    this.localIds = this.localIds.filter((other) => other !== id);
    this.reconciler.restate();
    this.reconciler.forget(id);
  }

  menu(action: MenuAction): void {
    this.connection.send({ t: "menu", action });
  }

  reset(): void {
    this.connection.send({ t: "reset" });
  }

  dispose(): void {
    this.connection.dispose();
  }
}
