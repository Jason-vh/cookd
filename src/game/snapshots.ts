import { DT } from "../sim/step";
import { SEND_EVERY, type Frame } from "./protocol";

/**
 * The received timeline, and the clock that reads it.
 *
 * Server frames arrive ~20 times a second, late and jittery. The renderer wants
 * a position *every* tick, so this keeps a short buffer of what has arrived and
 * a **playout clock** deliberately held behind the newest frame, giving it a
 * pair of frames to interpolate between at any moment.
 *
 * The timeline is the **server's own clock**, not the order things turned up
 * in. Every frame says which tick it is, and ticks are exactly 1/60s apart, so
 * "where was this chef 80ms ago" has an exact answer that does not care when the
 * packet carrying it arrived. Interpolating on arrival times instead assumes
 * frames are evenly spaced, which is false twice over: a bad link bunches them,
 * and the server deliberately sends early when somebody does something.
 *
 * Arrival times still matter, but for the one thing they can actually tell us:
 * how late this link is running, and how much that varies. That is the size the
 * buffer needs to be, and it is now measured rather than guessed.
 *
 * Pulled out of `net.ts` because it is the one part of the three-clock problem
 * that is pure given `(frames, arrival times)` — everything here can be driven
 * with synthetic timings.
 */

/**
 * The least we will ever run behind, in ms.
 *
 * One send interval is the floor that matters: below it there is routinely no
 * next frame to interpolate towards, and a remote chef stops dead until one
 * arrives. The extra tick is slack for the client's own frame timing.
 */
export const MIN_DELAY = (SEND_EVERY + 1) * DT * 1000;

/**
 * The most we will run behind. Past this the link is not jittery, it is broken,
 * and watching a quarter of a second of history is already unpleasant enough
 * that adding more does not help anybody.
 */
export const MAX_DELAY = 250;

/**
 * How fast the buffer is allowed to shrink, in ms per frame received.
 *
 * Growing is immediate — a frame that does not arrive in time is a chef who
 * stutters, and that is the thing the buffer exists to prevent. Shrinking is
 * slow, at ~20ms per second, because a link that has been calm for a moment is
 * not the same as a link that is calm.
 */
const FALL = 1;

/** Frames older than this many are dropped; ~2 seconds at 20Hz. */
const CAPACITY = 40;

type Timed = { frame: Frame; at: number };
type Point = { x: number; y: number };
type Kind = "players" | "customers";

/** The moment the server made this frame, on the server's own clock. */
function serverMs(frame: Frame): number {
  return frame.tick * DT * 1000;
}

export class SnapshotBuffer {
  private frames: Timed[] = [];
  private running = false;

  /**
   * The smallest gap seen between a frame's own moment and its arrival: the
   * clock offset between the two machines, plus however long the fastest packet
   * in the window took. Constant enough to subtract, which is all we need.
   */
  private base = 0;

  /** How far behind the freshest possible content we are playing, in ms. */
  private lead = MIN_DELAY;

  get delay(): number {
    return this.lead;
  }

  get newest(): Frame | null {
    return this.frames.at(-1)?.frame ?? null;
  }

  get started(): boolean {
    return this.running;
  }

  get size(): number {
    return this.frames.length;
  }

  /** Take a frame that arrived at `at`. */
  push(frame: Frame, at: number): void {
    // A tick that goes backwards means the world restarted — somebody hit
    // reset, and `createWorld` starts the counter over. Everything buffered
    // describes a kitchen that no longer exists, and because appliance ids
    // restart at 1 too, the ids *collide* rather than obviously mismatching:
    // the frames look valid and get interpolated across the boundary, so for
    // the length of the playout delay chefs and customers slide towards
    // positions from before the reset.
    const newest = this.frames.at(-1);
    if (newest && frame.tick < newest.frame.tick) this.clear();

    this.frames.push({ frame, at });
    while (this.frames.length > CAPACITY) this.frames.shift();
    this.running = true;
    this.resize();
  }

  /**
   * Where the playout clock is, on the server's timeline.
   *
   * Derived from the wall clock rather than integrated tick by tick. A buffer
   * that counted its own ticks had to be slewed back into place whenever the
   * two drifted, and could be pinned by a single long gap — which collapsed
   * `sample(now)` and `sample(now - one tick)` onto the same frame and stopped
   * every remote walk cycle while its chef was still visibly sliding.
   */
  playoutAt(now: number): number {
    return now - this.base - this.lead;
  }

  /**
   * Where an entity was at a given moment of server time.
   *
   * Linear between the two frames that bracket it. An entity present in only
   * one of them (it just arrived, or just left) uses whichever has it.
   */
  sample(kind: Kind, id: number, at: number): Point | null {
    if (this.frames.length === 0) return null;

    let before = this.frames[0]!;
    let after = this.frames.at(-1)!;
    for (let i = 0; i < this.frames.length - 1; i++) {
      const lower = this.frames[i]!;
      const upper = this.frames[i + 1]!;
      if (serverMs(lower.frame) <= at && serverMs(upper.frame) >= at) {
        before = lower;
        after = upper;
        break;
      }
    }

    const a = before.frame[kind].find((entity) => entity.id === id);
    const b = after.frame[kind].find((entity) => entity.id === id);
    const only = a ?? b;
    if (!a || !b) return only ? { x: only.x, y: only.y } : null;

    const span = serverMs(after.frame) - serverMs(before.frame);
    const t = span > 0 ? clamp01((at - serverMs(before.frame)) / span) : 1;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  /**
   * Facing comes from the newest frame rather than being interpolated: it is a
   * direction, and averaging two of them through a turn points somewhere the
   * entity never faced.
   */
  facing(kind: Kind, id: number): Point | null {
    const latest = this.frames.at(-1)?.frame[kind].find((entity) => entity.id === id);
    return latest ? { x: latest.fx, y: latest.fy } : null;
  }

  /**
   * Throw the timeline away.
   *
   * A reconnect is a new session, and a reset renumbers the world — in both
   * cases the frames still in here describe entities that no longer exist, and
   * interpolating across that boundary drags chefs towards stale positions.
   */
  clear(): void {
    this.frames.length = 0;
    this.running = false;
    this.lead = MIN_DELAY;
  }

  /**
   * Fit the buffer to the link, from what the last couple of seconds did.
   *
   * The spread between the earliest and latest arrival — measured against the
   * server's own clock, so sending early does not read as jitter — is exactly
   * how far behind we have to sit for a late frame to still be in hand.
   */
  private resize(): void {
    let earliest = Infinity;
    let latest = -Infinity;
    for (const entry of this.frames) {
      const late = entry.at - serverMs(entry.frame);
      if (late < earliest) earliest = late;
      if (late > latest) latest = late;
    }
    this.base = earliest;

    const wanted = Math.min(MAX_DELAY, Math.max(MIN_DELAY, latest - earliest + MIN_DELAY));
    this.lead = wanted > this.lead ? wanted : Math.max(wanted, this.lead - FALL);
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
