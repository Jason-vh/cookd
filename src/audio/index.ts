import type { World } from "../sim/types";
import { SoundWatcher } from "./cues";
import { Synth } from "./synth";

/**
 * The kitchen, heard.
 *
 * An observer of the world exactly like the renderer is: it reads, it never
 * writes, and the simulation has no idea it exists. `sync` is called once a
 * frame with the world being drawn.
 *
 * Muting stops the *playing*, not the *watching*. Toggling sound back on must
 * not fire a backlog of everything that happened while it was off, and the
 * watcher's job is to notice edges — so it keeps running and its answers are
 * thrown away. Cheaper than it sounds, and the alternative is a burst of eleven
 * noises the moment somebody presses `M`.
 */
export class KitchenAudio {
  private readonly watcher = new SoundWatcher();
  private readonly synth = new Synth();

  constructor(private mutedNow: boolean) {}

  get muted(): boolean {
    return this.mutedNow;
  }

  sync(world: World, local: number[]): void {
    const sounds = this.watcher.listen(world, local);
    if (this.mutedNow) return;
    for (const sound of sounds) this.synth.play(sound);
  }

  /** Returns the new state, for whoever has to save and announce it. */
  toggleMute(): boolean {
    this.mutedNow = !this.mutedNow;
    if (!this.mutedNow) this.synth.unlock();
    return this.mutedNow;
  }

  /** A real gesture: the join screen's first click. See `Synth.unlock`. */
  unlock(): void {
    if (!this.mutedNow) this.synth.unlock();
  }

  /**
   * A different kitchen: forget what the last one was doing.
   *
   * Without this, swapping between offline and online play would compare a
   * fresh world's appliances against the previous world's, and a room that
   * happened to be mid-bake would announce itself as a fresh burn.
   */
  reset(): void {
    this.watcher.clear();
  }

  dispose(): void {
    this.synth.dispose();
  }
}
