/**
 * Every sound the kitchen makes, as data.
 *
 * There are no audio files. A cooking game's sounds are short, tonal and
 * percussive, and a hundred lines of oscillator envelope buys all of them
 * without a single asset to load, license, or keep in sync with the art. The
 * same argument as the models: primitives get you a coherent whole, and the day
 * a real sound designer turns up this table is what they replace.
 *
 * A voice is deliberately *not* a function. Kept as rows, the sounds can be
 * reasoned about side by side — a bin is lower than a plate, a refusal is the
 * only buzz — and the synth stays a thing that plays voices rather than a
 * hundred branches of `ctx.createOscillator()`.
 */

export type Voice = {
  /** An oscillator shape, or filtered noise for anything percussive. */
  source: "sine" | "triangle" | "square" | "sawtooth" | "noise";
  /** Starting pitch, in Hz. Noise reads it as the filter's cutoff. */
  from: number;
  /** Pitch it glides to over the sound's life. Absent means it holds. */
  to?: number;
  /** Seconds. Everything here is a beat or less: this is feedback, not music. */
  duration: number;
  /** Peak level, 0..1, before the master volume. */
  gain: number;
  /** A second voice a fifth or an octave up, for anything that should ring. */
  harmonic?: number;
};

export const VOICES = {
  // --- hands ---
  // Two soft clicks, a fifth apart: up when something comes into your hands,
  // down when it leaves them. Quiet on purpose — they happen constantly, and a
  // sound you hear a thousand times a day has to be nearly nothing.
  pickup: { source: "triangle", from: 520, to: 640, duration: 0.06, gain: 0.16 },
  place: { source: "triangle", from: 420, to: 320, duration: 0.07, gain: 0.16 },

  // --- work ---
  /** A cycle of prep, frying or baking finished. The kitchen's metronome. */
  done: { source: "sine", from: 880, to: 1040, duration: 0.1, gain: 0.2, harmonic: 1.5 },
  /** Something has burnt. The one unpleasant sound in the game, and it earns it. */
  burn: { source: "noise", from: 1800, to: 300, duration: 0.5, gain: 0.34 },

  // --- the dining room ---
  /** Somebody walked in. A door chime, so a rush is heard before it is seen. */
  arrive: { source: "sine", from: 1320, to: 1320, duration: 0.16, gain: 0.14, harmonic: 2 },
  /** A dish delivered: the sound the whole loop is for, so it is the brightest. */
  serve: { source: "sine", from: 780, to: 1170, duration: 0.22, gain: 0.3, harmonic: 1.5 },
  /** Coins on a table. */
  tip: { source: "triangle", from: 1560, to: 1960, duration: 0.14, gain: 0.22, harmonic: 2 },
  /** Somebody gave up and left. Falls, and does not resolve. */
  walkout: { source: "sawtooth", from: 420, to: 190, duration: 0.42, gain: 0.2 },

  // --- the morning ---
  /** Money going out at the stall. */
  spend: { source: "square", from: 620, to: 440, duration: 0.12, gain: 0.18 },
  /** The stall said no. The only buzz, because refusal must not read as a purchase. */
  refuse: { source: "square", from: 180, to: 140, duration: 0.16, gain: 0.2 },
  /** Scraped into the bin: a dull thud with no pitch to it. */
  bin: { source: "noise", from: 420, to: 160, duration: 0.16, gain: 0.24 },

  // --- the day ---
  open: { source: "sine", from: 660, to: 990, duration: 0.5, gain: 0.28, harmonic: 2 },
  close: { source: "sine", from: 660, to: 440, duration: 0.6, gain: 0.26, harmonic: 1.5 },
} as const satisfies Record<string, Voice>;

export type SoundName = keyof typeof VOICES;

export function voice(name: SoundName): Voice {
  return VOICES[name];
}
