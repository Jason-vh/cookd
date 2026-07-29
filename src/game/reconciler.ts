import { applyFrame, type Frame } from "./protocol";
import { predict } from "../sim/step";
import type { LevelDef } from "../data/level";
import type { Inputs, Player, PlayerInput, World } from "../sim/types";
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
 * The world this owns is the world the renderer is handed. It used to be a
 * second, private one whose chefs were copied across a field at a time, which
 * meant only the fields somebody had thought to copy were predicted — position
 * and facing — and everything else a press does, above all *what is in your
 * hands*, waited for the server. Measured, that was 44ms on a perfect link and
 * 212ms from another country, per grab (`latency.test.ts`).
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

/**
 * One tick of our own input, kept until the server acknowledges it.
 *
 * `prev` is what each of our chefs had latched *before* this tick — which is
 * what makes the tick replayable. Grab and use are edge-triggered, and a replay
 * starts from a world whose `prev` is whatever the last predicted tick left
 * there, so without this the second run of a press sees a button that was
 * already down and does nothing. Movement never noticed, because movement has
 * no edges; possession noticed immediately, by vanishing on the next frame.
 */
type Entry = { seq: number; inputs: Inputs; prev: Map<number, PlayerInput> };

/** What `record` decided: whether this tick is worth telling the server about. */
export type Recorded = { seq: number; inputs: Inputs } | null;

export class Reconciler {
  /** The world our own chefs live in, ahead of the server — and the one drawn. */
  private world: World;
  private history: Entry[] = [];
  private seq = 0;

  /**
   * Whether the last input we actually sent was an idle one. Reset whenever the
   * set of local chefs changes, so the next tick restates the whole payload for
   * its new shape rather than leaving a freshly joined seat unmentioned.
   */
  private sentIdle = false;

  /** Smoothed-away difference between where we predicted and where we are. */
  private readonly error = new Map<number, Point>();

  /** Where the chefs currently wearing a correction really are. See `show`. */
  private readonly shown = new Map<number, { pos: Point; prevPos: Point }>();

  constructor(level: LevelDef) {
    this.world = createWorld(level, 0);
    // Everything a replayed tick would otherwise say out loud, twenty times a
    // second, until the server says it too.
    this.world.predicting = true;
  }

  /** The world we predict in, which is also the world being drawn. */
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
    // Simulate from where our chefs actually are, not from where they are being
    // drawn. See `show`.
    this.hide();
    const idle = Object.values(inputs).every((input) => !input || isIdleInput(input));
    let sending: Recorded = null;

    if (!idle || !this.sentIdle) {
      this.seq++;
      this.history.push({
        seq: this.seq,
        inputs: structuredClone(inputs),
        prev: this.latched(inputs),
      });
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
    // A frame can land at any moment, including while the correction is written
    // into the world for the renderer's benefit. Comparing against *that* would
    // fold the offset into itself and never converge.
    this.hide();

    // Where we thought our chefs were, before the server got a word in.
    const believed = new Map<number, Point>();
    for (const id of localIds) {
      const player = this.find(id);
      if (player) believed.set(id, { x: player.pos.x, y: player.pos.y });
    }

    applyFrame(this.world, frame);
    // Only our own. A remote chef's position belongs to the playout clock, which
    // deliberately runs behind: planting them at the newest frame here as well
    // meant every frame yanked them forwards and the next tick walked them back,
    // which is a stutter waiting for the day a frame lands between a tick and a
    // repaint. They still need *somewhere* to be for collision, and where the
    // caller last drew them is a better answer than where they will be.
    for (const snapshot of frame.players) {
      if (!localIds.includes(snapshot.id)) continue;
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
    // Put the buttons back as they were before the first tick we are about to
    // re-run, or none of its edges happen a second time. See `Entry`.
    for (const [id, prev] of this.history[0]?.prev ?? []) {
      const player = this.find(id);
      if (player) player.prev = structuredClone(prev);
    }
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
   * Put the correction into the world, for the renderer to see.
   *
   * A correction is something we **draw**, not something we simulate. `pos` is
   * the honest predicted position right up until the frame is handed over, when
   * the outstanding error is added to it — and `hide` takes it straight back out
   * before anything simulates from it again. Leaving it in would feed the
   * correction into the next tick's movement and collision, which is a
   * correction applied twice and a chef who never quite arrives.
   *
   * The offset is applied at both ends of the tick and decayed between them, so
   * the renderer still sees a sensible one-tick step and the walk cycle does not
   * lurch while a correction is being absorbed.
   */
  show(localIds: readonly number[]): void {
    this.hide();
    for (const id of localIds) {
      const error = this.error.get(id);
      const player = this.find(id);
      if (!player || !error || (error.x === 0 && error.y === 0)) continue;

      this.shown.set(id, { pos: { ...player.pos }, prevPos: { ...player.prevPos } });
      player.prevPos = { x: player.prevPos.x + error.x, y: player.prevPos.y + error.y };
      error.x *= ERROR_DECAY;
      error.y *= ERROR_DECAY;
      player.pos = { x: player.pos.x + error.x, y: player.pos.y + error.y };
    }
  }

  /** Take the correction back out. Idempotent, and cheap when there is none. */
  hide(): void {
    for (const [id, truth] of this.shown) {
      const player = this.find(id);
      if (!player) continue;
      player.pos = truth.pos;
      player.prevPos = truth.prevPos;
    }
    this.shown.clear();
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
    this.shown.clear();
  }

  /** The set of local chefs changed, so the next payload must state it in full. */
  restate(): void {
    this.sentIdle = false;
  }

  forget(id: number): void {
    this.error.delete(id);
    this.shown.delete(id);
  }

  private find(id: number): Player | undefined {
    return this.world.players.find((player) => player.id === id);
  }

  /** What our chefs have latched right now, for a replay to start from. */
  private latched(inputs: Inputs): Map<number, PlayerInput> {
    const prev = new Map<number, PlayerInput>();
    for (const id of Object.keys(inputs)) {
      const player = this.find(Number(id));
      if (player) prev.set(player.id, structuredClone(player.prev));
    }
    return prev;
  }
}
