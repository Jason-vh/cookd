import { LEVEL, type LevelDef } from "../data/level";
import { DT, beginDay, endDay, restartDay, step } from "../sim/step";
import type { Inputs, PlayerInput, World } from "../sim/types";
import { addPlayer, createWorld, emptyInput, log, playerById, removePlayer } from "../sim/world";
import { restore, type RestoreResult, type Save } from "../save";

/**
 * Owns a running game: one world, one clock, one set of players.
 *
 * There is exactly one of these per kitchen, and it does not care whether it is
 * running in a browser tab or on a server in Frankfurt. That is the whole
 * point — local play and hosted play must not become two implementations of
 * the rules that drift apart. `sim/` stays pure; this is the thing that *turns
 * the handle*.
 *
 * No DOM, no three.js, no `performance.now()`: time arrives as a parameter,
 * exactly like inputs do.
 */

/**
 * How many queued inputs we keep for a player before dropping the oldest.
 *
 * Dropping is the *correct* response to a flood, not a compromise. If half a
 * second of input arrives at once because a link stalled, the server has
 * already lived through that half second — it cannot go back and spend it
 * again, and replaying it would put the player half a second in the past and
 * keep them there. The lost time is genuinely lost.
 *
 * The client is what has to cope, and it does: it smooths the correction rather
 * than snapping (see `net.ts`). This number only needs to be big enough that
 * ordinary jitter never trips it — a third of a second of headroom.
 */
const MAX_QUEUE = 20;

export type MenuAction = "startDay" | "endDay" | "restartDay";

/**
 * Options rather than positional arguments: `advance(elapsed, 8)` used to mean
 * "eight ticks" and silently became "eight is your input function" when polling
 * arrived. Named fields make that mistake unrepresentable.
 */
export type AdvanceOptions = {
  /** Called once per tick to collect local input. Omitted when input arrives over a network. */
  poll?: () => Inputs;
  maxTicks?: number;
};

type Queued = { seq: number; input: PlayerInput };

export class Host {
  world: World;
  /** Last input sequence number actually applied, per player. */
  readonly acks = new Map<number, number>();

  /** Players whose connection dropped but whose seat is still being held. */
  private away = new Set<number>();
  private queues = new Map<number, Queued[]>();
  private last = new Map<number, PlayerInput>();
  private accumulator = 0;

  readonly level: LevelDef;

  /**
   * Why the save was not used, if there was one and it was not.
   *
   * The result used to be discarded, which combined badly with the server
   * marking a room dirty and overwriting: a save we refused to read was
   * replaced by the default kitchen within seconds, silently. The caller now
   * has to look at this to decide whether writing over the file is allowed.
   */
  readonly restored: RestoreResult | null;

  constructor(save?: Save | null, level: LevelDef = LEVEL) {
    this.level = level;
    this.world = createWorld(level, 0);
    this.restored = save ? restore(this.world, save, level.id) : null;
  }

  // --- players ---------------------------------------------------------------

  join(name: string): number {
    const player = addPlayer(this.world, this.level, name);
    this.queues.set(player.id, []);
    this.last.set(player.id, emptyInput());
    this.acks.set(player.id, 0);
    if (name) log(this.world, `${name} joined`);
    return player.id;
  }

  leave(id: number): void {
    removePlayer(this.world, id);
    this.away.delete(id);
    this.queues.delete(id);
    this.last.delete(id);
    this.acks.delete(id);
  }

  /**
   * Hold or release a seat.
   *
   * An away chef stands perfectly still rather than being deleted, so a player
   * whose connection blinks comes back to the pizza they were building instead
   * of to an empty kitchen. Their input is forced empty and their queue
   * dropped — without that, `nextInputs` would helpfully repeat their last
   * input and walk them into a wall for twenty seconds.
   */
  setAway(id: number, away: boolean): void {
    if (!this.queues.has(id)) return;
    if (away) {
      this.away.add(id);
      this.queues.set(id, []);
      this.last.set(id, emptyInput());
    } else {
      this.away.delete(id);
    }
    const player = playerById(this.world, id);
    if (player) player.away = away;
  }

  isAway(id: number): boolean {
    return this.away.has(id);
  }

  has(id: number): boolean {
    return this.queues.has(id);
  }

  get playerCount(): number {
    return this.world.players.length;
  }

  // --- input -----------------------------------------------------------------

  /**
   * Queue one tick of input. Inputs are consumed one per tick rather than
   * "latest wins" so that the server applies exactly the sequence the client
   * predicted against — otherwise a client's local movement and the server's
   * would drift apart under jitter and never reconcile cleanly.
   */
  enqueue(id: number, seq: number, input: PlayerInput): void {
    const queue = this.queues.get(id);
    if (!queue) return;
    queue.push({ seq, input });
    // A client running ahead (or a burst after a stall) must not build a
    // backlog we then replay in slow motion; drop the oldest instead.
    while (queue.length > MAX_QUEUE) queue.shift();
  }

  /** Drive a single player directly, for local play with no network in between. */
  setInput(id: number, input: PlayerInput): void {
    this.last.set(id, input);
    const queue = this.queues.get(id);
    if (queue) queue.length = 0;
  }

  // --- the clock -------------------------------------------------------------

  /**
   * Advance by `elapsed` seconds, in whole fixed ticks.
   *
   * Ticks are capped so a stalled server or a backgrounded tab resumes rather
   * than trying to catch up on a minute of simulation at once.
   */
  advance(elapsed: number, options: AdvanceOptions = {}): number {
    const { poll, maxTicks = 5 } = options;
    this.accumulator += Math.min(0.25, elapsed);
    let ticks = 0;
    while (this.accumulator >= DT && ticks < maxTicks) {
      // Polled per tick, never per frame — see the note on `Game.update`.
      if (poll) {
        const polled = poll();
        for (const id of Object.keys(polled)) {
          const input = polled[Number(id)];
          if (input) this.setInput(Number(id), input);
        }
      }
      step(this.world, this.nextInputs());
      this.accumulator -= DT;
      ticks++;
    }
    if (this.accumulator > DT) this.accumulator = DT;
    return ticks;
  }

  /** How far we are between the last tick and the next, for interpolation. */
  get alpha(): number {
    return this.accumulator / DT;
  }

  private nextInputs(): Inputs {
    const inputs: Inputs = {};
    for (const player of this.world.players) {
      if (this.away.has(player.id)) {
        inputs[player.id] = emptyInput();
        continue;
      }
      const queue = this.queues.get(player.id);
      const next = queue?.shift();
      if (next) {
        this.last.set(player.id, next.input);
        this.acks.set(player.id, next.seq);
      }
      // Starved queue: hold the last input rather than stopping dead. A dropped
      // packet should look like a moment of lag, not like a stumble.
      inputs[player.id] = this.last.get(player.id) ?? emptyInput();
    }
    return inputs;
  }

  // --- shell actions ---------------------------------------------------------

  menu(action: MenuAction): void {
    if (action === "endDay") endDay(this.world);
    else if (action === "restartDay") restartDay(this.world);
    else if (action === "startDay") beginDay(this.world);
  }

  /**
   * Restart the whole instance, keeping everyone who is connected. Their ids
   * survive so nobody's gamepad ends up driving somebody else's chef.
   */
  reset(by?: string): void {
    const players = this.world.players.map((player) => ({
      id: player.id,
      name: player.name,
      away: this.away.has(player.id),
    }));
    this.world = createWorld(this.level, 0);
    this.accumulator = 0;
    for (const { id, name, away } of players) {
      const player = addPlayer(this.world, this.level, name);
      // addPlayer hands out a fresh id; force the old one back so connections,
      // gamepads and input queues all still point at the right chef.
      player.id = id;
      // `addPlayer` builds everyone present and correct. Somebody whose
      // connection had dropped is still gone, and the `away` set still says so —
      // so without this the server kept feeding them empty input (right) while
      // every client drew them as a live chef standing perfectly still (wrong).
      player.away = away;
    }
    this.world.nextPlayerId = Math.max(0, ...players.map((p) => p.id + 1));

    // Queued and held inputs belong to the kitchen that just stopped existing.
    // Without this, whoever was mid-grab when someone hit reset immediately
    // re-fires that grab in the new one, and a backed-up queue replays into it.
    for (const id of this.queues.keys()) {
      this.queues.set(id, []);
      this.last.set(id, emptyInput());
      this.acks.set(id, this.acks.get(id) ?? 0);
    }
    if (by) log(this.world, `${by} reset the kitchen`);
  }
}
