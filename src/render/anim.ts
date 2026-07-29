import type { ChefMotion, Motion } from "../sim/types";

/**
 * The arithmetic behind the animation, with no three.js in it.
 *
 * This is here so it can be *tested*. The chop cycle is a piecewise function
 * with three segments and two constants that have to agree with each other; get
 * one boundary wrong and the knife hangs at the bottom or teleports to the top,
 * which is the kind of thing nobody notices in review and everybody notices in
 * play. It used to be module-private inside `view.ts`, a file that touches
 * `window` at import time, so none of it could be imported by a test at all.
 *
 * Nothing in here holds state or allocates.
 */

export const TAU = Math.PI * 2;

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Frame-rate independent easing: the fraction of the remaining distance to
 * cover this frame.
 *
 * The render layer had two conventions for this. The camera used this one; the
 * dials, bubbles and ghosts used `Math.min(1, rate * dt)`, which is *not*
 * independent of frame rate — at 144Hz a dial eased in visibly slower than at
 * 60. That mattered here more than it does in most codebases, because
 * `shouldRender` deliberately varies the frame rate: the same dial eased at two
 * different speeds depending on whether the window had focus.
 *
 * One convention, used everywhere. `rate` is how much of the gap is closed per
 * second, so larger is snappier.
 */
export function ease(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/** Cycles per second for each action. */
export const WORK_RATE: Record<Motion, number> = {
  chop: 3.8,
  knead: 1.1,
  mix: 1.8,
  fry: 1.7,
  bake: 0.45,
};

const CHEF_MOTIONS: ReadonlySet<Motion> = new Set<Motion>(["chop", "knead", "mix"]);

/** Fryers and ovens cook by themselves; standing at one is not an action. */
export function isChefMotion(motion: Motion | null | undefined): motion is ChefMotion {
  return motion !== null && motion !== undefined && CHEF_MOTIONS.has(motion);
}

/**
 * One shared phase per appliance drives the chef's arms, the knife and the food
 * together, so the whole action lands on the same beat. Offsetting by id keeps
 * two chefs working side by side from looking like a chorus line.
 */
export function workPhase(motion: Motion | null, id: number, time: number): number {
  const rate = motion ? WORK_RATE[motion] : 0;
  return time * rate * TAU + id * 1.7;
}

/** Fractions of one chop cycle: lift, strike, then rest. */
export const CHOP_RAISE = 0.55;
export const CHOP_FALL = 0.17;
export const CHOP_RECOIL = 0.22;

/**
 * A chop is not a sine wave. It lifts slowly, hangs at the top, then falls
 * *fast* and stays down while the chef resets — the pause at the bottom is what
 * makes the next strike read as a strike. 0 = knife on the board, 1 = top of
 * the swing.
 */
export function chopLift(phase: number): number {
  const u = cycle(phase);
  if (u < CHOP_RAISE) {
    const t = u / CHOP_RAISE;
    return 1 - (1 - t) * (1 - t); // ease out into the hang
  }
  if (u < CHOP_RAISE + CHOP_FALL) {
    const t = (u - CHOP_RAISE) / CHOP_FALL;
    return 1 - t * t; // ease in: the strike accelerates
  }
  return 0;
}

/**
 * 1 on the frame the knife lands, decaying fast. Drives the chef's recoil and
 * the food's squash, so the hit lands on both at once.
 */
export function chopImpact(phase: number): number {
  const since = cycle(phase) - (CHOP_RAISE + CHOP_FALL);
  if (since < 0 || since > CHOP_RECOIL) return 0;
  return 1 - since / CHOP_RECOIL;
}

/**
 * Position within one cycle, 0..1.
 *
 * `%` alone is not enough: it keeps the sign of its left operand, so a negative
 * phase — which `workPhase` cannot produce today but a per-customer offset
 * easily could — would land outside every branch of `chopLift` and return 0
 * for the whole first cycle.
 */
function cycle(phase: number): number {
  const u = (phase / TAU) % 1;
  return u < 0 ? u + 1 : u;
}
