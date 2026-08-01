import { LEVEL, type LevelDef } from "../data/level";
import { restockCards, setUnlocked } from "../sim/cards";
import { restockStall } from "../sim/shop";
import { DT, step } from "../sim/step";
import { restartDay } from "../sim/day";
import type { Inputs, PlayerInput, World } from "../sim/types";
import {
  addPlayer,
  createWorld,
  emptyInput,
  log,
  pause,
  playerById,
  removePlayer,
  resume,
} from "../sim/world";
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

/**
 * How deep a queue is allowed to sit before we start catching up on it.
 *
 * Left alone, the depth is a ratchet. A client produces one input per tick and
 * we consume one per tick, so nothing shortens the queue except *starving* it,
 * which only happens at zero — and every dropped client frame, network burst or
 * hair of clock drift leaves an extra tick in there for good. Measured, three
 * dropped frames put three ticks of latency in front of everything that player
 * did afterwards, and only standing still took them back out. So it degraded
 * over a session, worst during the busiest minute of a service, invisibly.
 *
 * One above zero, rather than zero, so ordinary jitter still has a tick of
 * cushion and the catching-up below stays rare.
 */
export const TARGET_QUEUE = 1;

/**
 * What the pause menu can do to a room.
 *
 * Opening and closing the *restaurant* used to be here too. They are the sign
 * by the door now — a menu item that opens the restaurant is the same
 * keypress-with-nothing-behind-it the sign replaced, one layer further away
 * from the room.
 *
 * Opening and closing the *menu* is here for the opposite reason. A pause used
 * to be a thing a client did to itself, and a client can only ever pause its
 * own chef: the day carried on, the fryer carried on, and reading the controls
 * during a rush cost you the rush. It is a fact about the room now, so it has
 * to travel like one.
 */
export type MenuAction = "restartDay" | "pause" | "resume";

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

/**
 * Fold an input we have no tick left for into the one behind it.
 *
 * The movement is simply lost, and that is the point: the client sent more
 * ticks than there are ticks, and the extra one has to go. It costs 0.07 tiles
 * of walking, which the client's own smoothing absorbs in a few frames.
 *
 * The **buttons are not lost**, because the tick being discarded might be the
 * one where somebody pressed grab, and a press that evaporates is a player
 * pressing it again and getting two. Or-ing them into the tick behind keeps the
 * edge exactly one tick later than it was meant to be.
 */
/**
 * Is this the tick a button went down on?
 *
 * `menu` is missing on purpose: it opens a menu on one person's screen and the
 * kitchen carries on without them, so it is not news for anybody else.
 */
function edge(now: PlayerInput, prev: PlayerInput): boolean {
  return (now.grab && !prev.grab) || (now.use && !prev.use) || (now.start && !prev.start);
}

function fold(skipped: PlayerInput, onto: PlayerInput): PlayerInput {
  return {
    move: onto.move,
    grab: onto.grab || skipped.grab,
    use: onto.use || skipped.use,
    start: onto.start || skipped.start,
    menu: onto.menu || skipped.menu,
  };
}

export class Host {
  world: World;
  /** Last input sequence number actually applied, per player. */
  readonly acks = new Map<number, number>();

  /** Players whose connection dropped but whose seat is still being held. */
  private away = new Set<number>();
  private queues = new Map<number, Queued[]>();
  private last = new Map<number, PlayerInput>();
  private accumulator = 0;
  private pressed = false;

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
    this.restored = save ? restore(this.world, save, level) : null;
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
      // Nobody may hold a room paused from behind a dropped connection: the
      // menu that would let them let go of it is on a screen that has gone.
      if (this.world.pausedBy === id) resume(this.world);
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

  /**
   * How many ticks of input are waiting to be applied for this player.
   *
   * Every entry is a tick of latency between pressing something and the server
   * acting on it — and, since the client is predicting locally, a tick of
   * staleness in what everybody *else* sees them doing. Reported by `/health`,
   * because a number that climbs is the first sign of a room on a bad link.
   */
  queueDepth(id: number): number {
    return this.queues.get(id)?.length ?? 0;
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
    this.pressed = false;
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

  /**
   * Did the last `advance` apply a press — a grab, a use, a day being opened?
   *
   * Read by the server to decide whether this is a moment worth telling people
   * about now rather than on the next of twenty frames a second. It is
   * deliberately about the *input* and not about what came of it: asking "did
   * anything change" means rebuilding and comparing a description of the world
   * every tick for every room, which is exactly what `layoutVersion` exists to
   * avoid. A press that turned out to do nothing costs one frame nobody needed.
   */
  get acted(): boolean {
    return this.pressed;
  }

  private nextInputs(): Inputs {
    const inputs: Inputs = {};
    for (const player of this.world.players) {
      if (this.away.has(player.id)) {
        inputs[player.id] = emptyInput();
        continue;
      }
      const queue = this.queues.get(player.id);
      // Catch up on a queue that has ratcheted, one tick at a time. Doing it in
      // one go would hand the client a correction the size of the whole backlog
      // to absorb; a tick at a time is 0.07 tiles apiece, and gone in a few
      // frames.
      if (queue && queue.length > TARGET_QUEUE) {
        const skipped = queue.shift()!;
        const head = queue[0]!;
        head.input = fold(skipped.input, head.input);
      }
      const next = queue?.shift();
      if (next) {
        this.last.set(player.id, next.input);
        this.acks.set(player.id, next.seq);
      }
      // Starved queue: hold the last input rather than stopping dead. A dropped
      // packet should look like a moment of lag, not like a stumble.
      const applied = this.last.get(player.id) ?? emptyInput();
      inputs[player.id] = applied;
      // `player.prev` is still last tick's, because `step` has not run yet, so
      // this is exactly the edge the simulation is about to see.
      if (edge(applied, player.prev)) this.pressed = true;
    }
    return inputs;
  }

  // --- shell actions ---------------------------------------------------------

  /**
   * `by` is the player who pressed it, which only the pause needs: it is the
   * one action whose result is a sentence on everybody else's screen.
   */
  menu(action: MenuAction, by?: number): void {
    switch (action) {
      case "restartDay":
        restartDay(this.world);
        return;
      case "pause": {
        const player = by === undefined ? this.world.players[0] : playerById(this.world, by);
        if (player) pause(this.world, player.id, player.name);
        return;
      }
      case "resume":
        resume(this.world, by);
        return;
      default: {
        const never: never = action;
        void never;
      }
    }
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
    // The menu survives. A reset un-wrecks the *layout* — it puts the walls
    // back where the level says and undoes whatever the room has done to
    // itself — and the recipes a room bought are not part of that: they are its
    // history, and days were spent on them. What a reset does take away is the
    // equipment those cards delivered, which is exactly what it takes away from
    // everything else somebody bought, and the same shop is standing outside.
    //
    // **Unless the run is over.** A repossessed kitchen has reset as its only
    // way forward, so this is where a new run begins, and a new run that
    // inherited the old menu would open on day one with customers ordering
    // pizza in a kitchen that has no oven and no takings to buy one with.
    const evicted = this.world.evicted;
    const unlocked = this.world.unlocked;
    const unlockedDay = this.world.unlockedDay;
    const paused = this.world.pausedBy;
    const pausedName = this.world.pausedName;
    this.world = createWorld(this.level, 0);
    // A fresh world already starts on the salad, which is where a new run
    // belongs.
    if (!evicted) setUnlocked(this.world, unlocked, unlockedDay);
    restockStall(this.world);
    restockCards(this.world);
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
    // Whoever reset the kitchen did it from an open menu, and that menu is
    // still open. A new world that came back running would leave them looking
    // at a paused screen over a kitchen that was not.
    if (paused !== null) pause(this.world, paused, pausedName);

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
