/**
 * The one pseudo-random number generator in the game.
 *
 * mulberry32: small, fast, and good enough for deciding which chair somebody
 * sits in. What matters is that it is *deterministic* — the simulation replays
 * from an input log, and the scenery has to be scattered identically on every
 * client or the park becomes a per-machine opinion.
 *
 * It lived in two places, `sim/world.ts` and `render/environment.ts`, the second
 * carrying the comment "Same PRNG as the simulation, so scattered scenery is
 * reproducible" — a claim about another file that nothing could check, and that
 * would have gone silently false the day either copy was touched.
 */

/** Advance a state and return both the next state and a value in [0, 1). */
export function nextRandom(state: number): { state: number; value: number } {
  const next = (state + 0x6d2b79f5) | 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { state: next, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

/**
 * A self-contained generator, for anything that is not the simulation.
 *
 * The simulation keeps its state on the `World` instead, so that a save, a
 * replay and a network snapshot all carry it — see `random(world)`.
 */
export function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    const next = nextRandom(state);
    state = next.state;
    return next.value;
  };
}
