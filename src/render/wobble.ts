/**
 * Deterministic pseudo-randomness, in [-0.5, 0.5], from two integers.
 *
 * The food has always been built with this and the furniture never was, and the
 * difference showed: the ingredients look handmade and the kitchen looked like
 * CAD. Perfect alignment is the strongest programmer-art signal left after hard
 * edges, because nothing in a real room is square to anything else — slats sit
 * a degree off, chairs get pushed back and never quite returned, a board is put
 * down at whatever angle the hand let go at.
 *
 * It has to be *deterministic* rather than random for two reasons. Online, two
 * clients that disagree about which way a slat leans are two clients drawing
 * different rooms. And a mesh is rebuilt whenever its item state changes, so a
 * `Math.random()` wobble would twitch every time a tomato was chopped.
 *
 * The one-line hash is the usual sin/fract trick from shader code: no state, no
 * seeding ceremony, and stable across engines because it is plain float maths.
 */
export function wobble(seed: number, index: number): number {
  const value = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return value - Math.floor(value) - 0.5;
}

/**
 * A jitter function bound to one thing's seed: `nudge(0, 0.02)` is "up to two
 * centimetres, and always the same two centimetres for this crate".
 *
 * Passed down into builders rather than re-derived by each, so every part of
 * one appliance draws from the same sequence and two parts cannot accidentally
 * share an index and move together.
 */
export type Jitter = (index: number, amount: number) => number;

export function jitter(seed: number): Jitter {
  return (index, amount) => wobble(seed, index) * amount;
}
