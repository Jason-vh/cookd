import { specKey } from "../sim/items";
import type { EffectCue, Motion, World } from "../sim/types";
import type { SoundName } from "./voices";

/**
 * What the kitchen sounds like this frame, worked out from the world alone.
 *
 * Pure: no `AudioContext`, no DOM, nothing that cannot run in a test. The synth
 * is the part that has to touch the browser, and it is deliberately stupid —
 * it plays the names this file returns. Every *decision* about when a sound
 * happens lives here, which is the same split as `render/anim.ts` having no
 * three.js in it.
 *
 * Two sources, and the difference between them matters:
 *
 * - **Effect cues** are things the simulation announced. They are suppressed
 *   inside a prediction (see `World.predicting`), so online they arrive with
 *   the frame that confirms them — right for money, tips and walkouts, which
 *   are facts about the room rather than about your hands.
 * - **Watched state** is everything else: what you are carrying, what is
 *   burning, who has walked in. This is read from the world being *drawn*,
 *   which is predicted locally, so your own pickup clicks the instant you press
 *   the button rather than a round trip later. A sound that lags your own hands
 *   is worse than no sound at all.
 */
export class SoundWatcher {
  /** The highest cue id already turned into a sound. */
  private lastEffectId = 0;
  /** Player id -> what they were holding, as a key. */
  private hands = new Map<number, string>();
  /** Appliances whose contents were already ruined, so a burn fires once. */
  private burnt = new Set<number>();
  private customers = new Set<number>();
  private phase: World["phase"] | null = null;
  /** Seeded on the first look, so joining a kitchen mid-day is not a fanfare. */
  private started = false;

  /**
   * The sounds to play now.
   *
   * `local` is this browser's player ids: hand sounds belong to *your* chef.
   * With four cooks in a kitchen, hearing everybody else's pickups is a rattle
   * with no information in it — the other three are on the screen, and what
   * they are doing is already visible.
   */
  listen(world: World, local: number[]): SoundName[] {
    const sounds: SoundName[] = [];
    const first = !this.started;
    this.started = true;

    this.listenToEffects(world, sounds, first);
    this.listenToHands(world, local, sounds, first);
    this.listenToAppliances(world, sounds, first);
    this.listenToCustomers(world, sounds, first);

    if (this.phase !== world.phase) {
      if (this.phase !== null) sounds.push(world.phase === "service" ? "open" : "close");
      this.phase = world.phase;
    }

    // One of each, however many caused it. Three customers arriving on the same
    // tick is one door chime: the same sample played three times a millisecond
    // apart is not three sounds, it is one loud, phased, unpleasant one.
    return [...new Set(sounds)];
  }

  /** Forget everything. For a reset, or swapping between kitchens. */
  clear(): void {
    this.lastEffectId = 0;
    this.hands.clear();
    this.burnt.clear();
    this.customers.clear();
    this.phase = null;
    this.started = false;
  }

  private listenToEffects(world: World, sounds: SoundName[], first: boolean): void {
    // A reset — or going online — hands us a world whose id counter starts
    // over. Keeping the old high-water mark would silently mute the kitchen
    // until the new world counted past it. Judged from the cues themselves,
    // exactly as the renderer does it: they are appended in id order.
    const newest = world.effects.at(-1);
    if (newest && newest.id < this.lastEffectId) this.lastEffectId = 0;

    for (const cue of world.effects) {
      if (cue.id <= this.lastEffectId) continue;
      this.lastEffectId = cue.id;
      if (first) continue; // whatever happened before we were listening is not news
      const sound = soundForCue(cue);
      if (sound) sounds.push(sound);
    }
  }

  private listenToHands(world: World, local: number[], sounds: SoundName[], first: boolean): void {
    for (const player of world.players) {
      const held = player.carried ? specKey(player.carried) : "";
      const before = this.hands.get(player.id) ?? "";
      this.hands.set(player.id, held);
      if (first || !local.includes(player.id) || held === before) continue;
      // Empty -> something is a pickup and something -> empty is a place. Both
      // full means the thing in your hands changed under you, which is a
      // combine, and the appliance it happened at says so itself.
      if (before === "") sounds.push("pickup");
      else if (held === "") sounds.push("place");
    }
    for (const id of this.hands.keys()) {
      if (!world.players.some((player) => player.id === id)) this.hands.delete(id);
    }
  }

  private listenToAppliances(world: World, sounds: SoundName[], first: boolean): void {
    for (const appliance of world.appliances.values()) {
      if (appliance.justFinished && !first) sounds.push("done");
      if (appliance.motion !== null && !first) {
        const sound = WORK_SOUND[appliance.motion];
        // Paced off the world's own tick and off the appliance's id, so a
        // kitchen with three things going at once is a rhythm rather than
        // three sounds landing on the same frame and phasing into one.
        if ((world.tick + appliance.id) % WORK_PERIOD[appliance.motion] === 0) sounds.push(sound);
      }

      const ruined = appliance.item?.processes.includes("burnt") === true;
      const was = this.burnt.has(appliance.id);
      if (ruined && !was && !first) sounds.push("burn");
      if (ruined) this.burnt.add(appliance.id);
      else this.burnt.delete(appliance.id);
    }
  }

  private listenToCustomers(world: World, sounds: SoundName[], first: boolean): void {
    const present = new Set<number>();
    for (const customer of world.customers) {
      present.add(customer.id);
      if (!this.customers.has(customer.id) && !first) sounds.push("arrive");
    }
    this.customers = present;
  }
}

/**
 * What each kind of work sounds like while it is being done.
 *
 * A `Record` over the union rather than a switch, so a new motion is a build
 * error naming the key instead of a silent appliance — the same reason
 * `wire.ts` lists its unions this way.
 */
const WORK_SOUND: Record<Motion, SoundName> = {
  chop: "chop",
  knead: "chop",
  mix: "chop",
  scrub: "scrub",
  fry: "sizzle",
  bake: "sizzle",
};

/**
 * How many ticks between one work sound and the next, per motion.
 *
 * In **ticks** rather than seconds because this file is pure and the world's
 * clock is the only one it has — which is also what makes it frame-rate
 * independent, and what makes a paused kitchen fall silent for free.
 *
 * Hand work is fast and unattended work is not: a knife knocks about five times
 * a second, and a fryer that hissed at that rate would be the loudest thing in
 * the room for the whole of its cycle.
 */
const WORK_PERIOD: Record<Motion, number> = {
  chop: 12,
  knead: 16,
  mix: 14,
  scrub: 18,
  fry: 22,
  bake: 30,
};

/**
 * One cue, as a sound.
 *
 * A `switch` with a `never` default, for the same reason the renderer's has
 * one: a new `EffectCue` kind should fail the build here rather than compile
 * cleanly and be silent forever.
 */
function soundForCue(cue: EffectCue): SoundName | null {
  switch (cue.kind) {
    case "served":
    case "paid":
      return "serve";
    case "tipped":
      return "tip";
    case "binned":
      return "bin";
    case "walkout":
      return "walkout";
    case "spent":
      return "spend";
    case "refused":
      return "refuse";
    default: {
      const never: never = cue;
      void never;
      return null;
    }
  }
}
