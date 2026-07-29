import type { Frame } from "./protocol";

/**
 * The received timeline, and the clock that reads it.
 *
 * Server frames arrive ~20 times a second, late and jittery. The renderer wants
 * a position *every* tick, so this keeps a short buffer of what has arrived and
 * a **playout clock** deliberately held behind the newest frame, giving it a
 * pair of frames to interpolate between at any moment.
 *
 * Pulled out of `net.ts` because it is the one part of the three-clock problem
 * that is pure given `(frames, arrival times)` — everything here can be driven
 * with synthetic timings, which is what the slew behaviour below needs and
 * never had.
 */

/**
 * How far behind the newest frame we render, in ms.
 *
 * This is the jitter budget: if a frame is late by less than this, nobody sees
 * anything. Too small and remote chefs stutter; too large and everyone is
 * watching the past. Two frame intervals is the usual starting point, and a
 * long-haul link wants the headroom.
 */
export const PLAYOUT_DELAY = 110;

/** Jump the clock rather than slewing if it falls further behind than this. */
const MAX_DRIFT = 400;

/**
 * How much faster or slower than real time the playout clock may run while it
 * corrects its lead.
 *
 * The clock used to advance at exactly 1x and be *clamped* at both ends, which
 * meant the jitter budget was spent once and never rebuilt. Any inter-arrival
 * gap longer than the steady-state sawtooth pinned it to the newest frame, and
 * from then on the lead was whatever the last gap happened to be. Pinned there,
 * `sample(playout)` and `sample(playout - one tick)` both resolve to the same
 * frame, so `prevPos === pos` — and remote chefs' walk cycles stop while they
 * are still visibly sliding, which is the exact thing the two-point sampling
 * exists to prevent.
 *
 * 5% is slow enough that nobody can see the correction happening.
 */
const SLEW = 0.05;

/** Frames older than this many are dropped; ~2 seconds at 20Hz. */
const CAPACITY = 40;

type Timed = { frame: Frame; at: number };
type Point = { x: number; y: number };
type Kind = "players" | "customers";

export class SnapshotBuffer {
  private frames: Timed[] = [];
  private clock = 0;
  private running = false;

  /** Where the playout clock currently is, on the arrival-time scale. */
  get playout(): number {
    return this.clock;
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

  /**
   * Take a frame that arrived at `at`. Returns true if this was the first one,
   * which is the caller's cue to seed its worlds from it.
   */
  push(frame: Frame, at: number): boolean {
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

    if (this.running) return false;
    this.running = true;
    this.clock = at - PLAYOUT_DELAY;
    return true;
  }

  /**
   * Walk the clock forward one tick, slewing gently toward the intended lead.
   *
   * `dt` is in milliseconds, matching the arrival-time scale.
   */
  advance(dt: number): void {
    const newest = this.frames.at(-1);
    if (!newest) {
      this.clock += dt;
      return;
    }

    const target = newest.at - PLAYOUT_DELAY;
    // A long stall is not something to slew out of; take the jump and rebuild
    // the lead from there.
    if (this.clock < target - MAX_DRIFT) {
      this.clock = target;
      return;
    }

    // Behind the target: run a little fast to catch up. Ahead of it: run a
    // little slow to fall back. Either way the correction is invisible.
    const rate = this.clock < target ? 1 + SLEW : this.clock > target ? 1 - SLEW : 1;
    this.clock += dt * rate;

    // Never read past the newest frame: there is nothing there to interpolate
    // towards, and extrapolating is how a chef slides through a wall.
    if (this.clock > newest.at) this.clock = newest.at;
  }

  /**
   * Where an entity was on the received timeline at a given moment.
   *
   * Linear between the two frames that bracket `at`. An entity present in only
   * one of them (it just arrived, or just left) uses whichever has it.
   */
  sample(kind: Kind, id: number, at: number): Point | null {
    if (this.frames.length === 0) return null;

    let before = this.frames[0]!;
    let after = this.frames.at(-1)!;
    for (let i = 0; i < this.frames.length - 1; i++) {
      const lower = this.frames[i]!;
      const upper = this.frames[i + 1]!;
      if (lower.at <= at && upper.at >= at) {
        before = lower;
        after = upper;
        break;
      }
    }

    const a = before.frame[kind].find((entity) => entity.id === id);
    const b = after.frame[kind].find((entity) => entity.id === id);
    const only = a ?? b;
    if (!a || !b) return only ? { x: only.x, y: only.y } : null;

    const span = after.at - before.at;
    const t = span > 0 ? clamp01((at - before.at) / span) : 1;
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
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
