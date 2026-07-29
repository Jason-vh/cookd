import { applyFrame, type Frame } from "./protocol";
import { predict } from "../sim/step";
import type { LevelDef } from "../data/level";
import type { Inputs, Player, World } from "../sim/types";
import { createWorld, isIdleInput } from "../sim/world";

/**
 * Our own chefs, run ahead of the server, and put back in their place when it
 * disagrees.
 *
 * On a 180ms link, waiting for the server to confirm each step makes walking
 * feel like steering a boat. So local chefs move immediately in a world of
 * their own, every input is kept, and when a frame arrives everything the
 * server has not yet seen is replayed on top of its answer.
 *
 * The interesting part is what happens when the replay lands somewhere other
 * than where we had drawn. The server can legitimately refuse input we already
 * predicted — a stalled link that dumps half a second at once has its oldest
 * dropped, because that time has passed and cannot be spent again. Our chef is
 * then simply wrong, by as much as two tiles, and hard-correcting teleports
 * them across the kitchen mid-stride. So the difference is carried as an offset
 * that decays to nothing over about 200ms: you keep control the whole time and
 * the chef slides back into place.
 *
 * Pulled out of `net.ts` because all of it is pure given a `World`, a `Frame`
 * and `predict` — no socket, no clock, no DOM.
 */

/**
 * Per-tick decay of prediction error, and the point at which we give up and
 * snap instead. Beyond the cap something has gone badly wrong (a reset, a very
 * long stall) and being in the right place matters more than being smooth.
 */
const ERROR_DECAY = 0.8;
const MAX_ERROR = 2.5;

/** How many ticks of input we keep for replay. Four seconds at 60Hz. */
const HISTORY = 240;

type Point = { x: number; y: number };

/** What `record` decided: whether this tick is worth telling the server about. */
export type Recorded = { seq: number; inputs: Inputs } | null;

export class Reconciler {
  /** The world our own chefs live in, ahead of the server. */
  private world: World;
  private history: { seq: number; inputs: Inputs }[] = [];
  private seq = 0;

  /**
   * Whether the last input we actually sent was an idle one. Reset whenever the
   * set of local chefs changes, so the next tick restates the whole payload for
   * its new shape rather than leaving a freshly joined seat unmentioned.
   */
  private sentIdle = false;

  /** Smoothed-away difference between where we predicted and where we are. */
  private readonly error = new Map<number, Point>();

  constructor(level: LevelDef) {
    this.world = createWorld(level, 0);
  }

  /** The prediction world, for the caller to apply layouts to. */
  get prediction(): World {
    return this.world;
  }

  /**
   * Advance our chefs by one tick.
   *
   * Returns the input to send, or null when there is nothing worth saying.
   * Standing still is not news: the server's queue starves gracefully by
   * holding the last input it was given, so once we have told it we are idle,
   * repeating that sixty times a second only restates it. A stationary chef
   * also cannot drift — the server integrates the same zero velocity we do.
   *
   * Only *runs* of idle collapse. The first idle tick after moving is still
   * sent, because that one is the instruction to stop.
   */
  record(inputs: Inputs): Recorded {
    const idle = Object.values(inputs).every((input) => !input || isIdleInput(input));
    let sending: Recorded = null;

    if (!idle || !this.sentIdle) {
      this.seq++;
      this.history.push({ seq: this.seq, inputs: structuredClone(inputs) });
      while (this.history.length > HISTORY) this.history.shift();
      this.sentIdle = idle;
      sending = { seq: this.seq, inputs };
    }

    predict(this.world, inputs);
    return sending;
  }

  /**
   * Re-run our own inputs on top of the server's latest word.
   *
   * The server tells us the last input sequence it applied. Everything we have
   * sent since then it has not seen yet, so we replay it locally — that is what
   * keeps our chef under our thumb on a slow link while still ending up exactly
   * where the server says.
   */
  reconcile(frame: Frame, localIds: readonly number[]): void {
    // Where we thought our chefs were, before the server got a word in.
    const believed = new Map<number, Point>();
    for (const id of localIds) {
      const player = this.find(id);
      if (player) believed.set(id, { x: player.pos.x, y: player.pos.y });
    }

    applyFrame(this.world, frame);
    for (const snapshot of frame.players) {
      const player = this.find(snapshot.id);
      if (!player) continue;
      player.pos = { x: snapshot.x, y: snapshot.y };
      player.prevPos = { x: snapshot.x, y: snapshot.y };
      player.facing = { x: snapshot.fx, y: snapshot.fy };
    }

    // A seat the server has not acked *anything* for is not "acked at zero" —
    // it is a seat with nothing outstanding. Reading it as zero meant adding a
    // second local player mid-session replayed all 240 history entries on one
    // frame, and a seat leaving `acks` without a fresh `welcome` pinned it
    // there for ever.
    const acked = Math.min(this.seq, ...localIds.map((id) => frame.acks[id] ?? this.seq));
    this.history = this.history.filter((entry) => entry.seq > acked);
    for (const entry of this.history) predict(this.world, entry.inputs);

    // Whatever we got wrong becomes an offset to be walked off, not a teleport.
    for (const [id, was] of believed) {
      const player = this.find(id);
      if (!player) continue;
      const carried = this.error.get(id) ?? { x: 0, y: 0 };
      const next = {
        x: carried.x + (was.x - player.pos.x),
        y: carried.y + (was.y - player.pos.y),
      };
      this.error.set(id, Math.hypot(next.x, next.y) > MAX_ERROR ? { x: 0, y: 0 } : next);
    }
  }

  /**
   * Write a predicted chef into the world being drawn, carrying the correction.
   *
   * The offset is applied at both ends of the tick and decayed between them, so
   * the renderer still sees a sensible one-tick step and the walk cycle does not
   * lurch while a correction is being absorbed.
   */
  draw(into: Player): boolean {
    const predicted = this.find(into.id);
    if (!predicted) return false;

    const error = this.error.get(into.id) ?? { x: 0, y: 0 };
    const before = { ...error };
    error.x *= ERROR_DECAY;
    error.y *= ERROR_DECAY;
    this.error.set(into.id, error);

    into.prevPos = { x: predicted.prevPos.x + before.x, y: predicted.prevPos.y + before.y };
    into.pos = { x: predicted.pos.x + error.x, y: predicted.pos.y + error.y };
    into.facing = { ...predicted.facing };
    into.workingOn = predicted.workingOn;
    return true;
  }

  /** How far this chef still is from where the server put them. */
  errorOf(id: number): Point {
    return this.error.get(id) ?? { x: 0, y: 0 };
  }

  /**
   * A reconnect is a *new session*: new ids, acks back at zero, and a history
   * describing players that no longer exist. Replaying any of it would push the
   * entire input log into the new world on the first reconcile.
   */
  reset(): void {
    this.history.length = 0;
    this.seq = 0;
    this.sentIdle = false;
    this.error.clear();
  }

  /** The set of local chefs changed, so the next payload must state it in full. */
  restate(): void {
    this.sentIdle = false;
  }

  forget(id: number): void {
    this.error.delete(id);
  }

  private find(id: number): Player | undefined {
    return this.world.players.find((player) => player.id === id);
  }
}
