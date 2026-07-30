import { type SoundName, type Voice, voice } from "./voices";

/**
 * The part that actually makes a noise: a voice in, an oscillator out.
 *
 * Everything here is created per sound and freed by the browser when it stops —
 * WebAudio nodes are one-shot by design, and the graph is three nodes deep, so
 * there is nothing to pool. The one long-lived object is the context itself.
 *
 * **The context cannot exist before a gesture.** Browsers start an
 * `AudioContext` suspended unless it was created in response to a click or a
 * keypress, and a suspended context swallows everything silently. So it is
 * built lazily on the first sound and `resume()`d on every play: by then the
 * player has pressed something, because nothing in this game makes a sound
 * before they do.
 */
export class Synth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  /** 0..1, applied to everything. */
  constructor(private readonly volume = 0.7) {}

  play(name: SoundName): void {
    const ctx = this.context();
    if (!ctx || !this.master) return;
    // A tab that has been in the background comes back suspended.
    if (ctx.state === "suspended") void ctx.resume();
    render(ctx, this.master, voice(name), this.noise);
  }

  /**
   * Wake the audio hardware from a real gesture.
   *
   * Called from the join screen's first click. Without it the first sound of a
   * session is the one that opens the context, and on Safari that one is lost.
   */
  unlock(): void {
    const ctx = this.context();
    if (ctx?.state === "suspended") void ctx.resume();
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.noise = null;
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof AudioContext === "undefined") return null; // headless, or very old
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    this.noise = noiseBuffer(this.ctx);
    return this.ctx;
  }
}

/** One second of white noise, shared by every percussive voice. */
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * One voice, played now.
 *
 * The envelope is the whole trick: a few milliseconds of attack so nothing
 * clicks, then an exponential fall to silence. `exponentialRampToValueAtTime`
 * cannot reach zero, hence the small floor — a linear ramp instead sounds like
 * a sound being switched off, which is exactly what it is.
 */
function render(ctx: AudioContext, master: GainNode, spec: Voice, noise: AudioBuffer | null): void {
  const now = ctx.currentTime;
  const end = now + spec.duration;

  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, now);
  envelope.gain.exponentialRampToValueAtTime(spec.gain, now + 0.008);
  envelope.gain.exponentialRampToValueAtTime(0.0001, end);
  envelope.connect(master);

  if (spec.source === "noise") {
    if (!noise) return;
    const source = ctx.createBufferSource();
    source.buffer = noise;
    // Noise is pitched by a filter rather than by a frequency: sweeping the
    // cutoff down is what turns a hiss into a thud, and it is the same gesture
    // a burning pan and a closing bin lid both make.
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(spec.from, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, spec.to ?? spec.from), end);
    source.connect(filter);
    filter.connect(envelope);
    source.start(now);
    source.stop(end);
    return;
  }

  for (const [ratio, level] of [
    [1, 1] as const,
    ...(spec.harmonic ? [[spec.harmonic, 0.4]] : []),
  ]) {
    const osc = ctx.createOscillator();
    osc.type = spec.source;
    osc.frequency.setValueAtTime(spec.from * ratio, now);
    osc.frequency.exponentialRampToValueAtTime((spec.to ?? spec.from) * ratio, end);
    // Partials ride their own gain so the fundamental stays the loudest thing
    // in the sound; without it a chime's fifth is as present as its root and
    // the whole kitchen sounds like a doorbell.
    const mix = ctx.createGain();
    mix.gain.value = level ?? 1;
    osc.connect(mix);
    mix.connect(envelope);
    osc.start(now);
    osc.stop(end);
  }
}
