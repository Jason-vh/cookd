import { emptyInput } from "../sim/world";
import { screenToWorld } from "../orientation";
import type { Inputs, PlayerInput } from "../sim/types";

/**
 * Input layer. Produces one PlayerInput per player slot per tick.
 *
 * Everything here is deliberately dumb: it reads devices and writes plain
 * data. The sim never sees a Gamepad or a KeyboardEvent, which is what lets us
 * swap in network-received inputs later.
 *
 * The one thing it is not dumb about is *which way up is*: directions are read
 * in screen space and turned into world space here, before anything is
 * quantised or sent. Doing it at the edge keeps the sim ignorant of the camera
 * and keeps lockstep intact — what goes on the wire is still a plain vector.
 *
 * Device assignment:
 *   - keyboard scheme 0 always drives player 0 (so you can always play solo);
 *   - keyboard scheme 1 drives player 1 once a second player exists;
 *   - the first gamepad joins player 0, every further gamepad creates a player.
 */

export type MenuNav = {
  up: boolean;
  down: boolean;
  confirm: boolean;
  /** Toggle the menu (Esc / Start). */
  menu: boolean;
  /** Cancel out of the menu (B / Backspace) — closes, never opens. */
  back: boolean;
};

type KeyScheme = {
  up: string[];
  down: string[];
  left: string[];
  right: string[];
  grab: string[];
  use: string[];
  start: string[];
  menu: string[];
};

const KEY_SCHEMES: KeyScheme[] = [
  {
    up: ["KeyW"],
    down: ["KeyS"],
    left: ["KeyA"],
    right: ["KeyD"],
    grab: ["Space", "KeyE"],
    use: ["KeyF", "ShiftLeft"],
    start: ["Enter"],
    menu: ["Escape"],
  },
  {
    up: ["ArrowUp"],
    down: ["ArrowDown"],
    left: ["ArrowLeft"],
    right: ["ArrowRight"],
    grab: ["Comma", "Numpad0"],
    use: ["Period", "NumpadDecimal"],
    start: ["Enter"],
    menu: ["Escape"],
  },
];

// Standard gamepad mapping. Start opens the pause menu; the north face button
// (Y / Triangle) confirms "open for business", so the two can never conflict.
// Standard gamepad mapping. `back` (B / Circle) doubles as an alternate USE
// during play and as "close the menu" while it is open — the two contexts are
// mutually exclusive, so they cannot conflict.
// The shoulders turn the kitchen, which is the one control that is about the
// *view* rather than about the chef — so it sits where a camera control sits on
// every other pad.
const BUTTON = { grab: 0, use: 2, start: 3, menu: 9, back: 1, turnL: 4, turnR: 5 } as const;
const STICK_DEADZONE = 0.22;

export class InputManager {
  private keys = new Set<string>();
  /**
   * Keys that saw a keydown since the last poll. A press-and-release that
   * happens entirely within one frame would otherwise be dropped, because we
   * only sample `keys` once per frame.
   *
   * One buffer per *reader*, because a buffer that is cleared on read can only
   * be read once: while these were shared, the menu's poll ran first and ate
   * the tap before gameplay ever saw it.
   */
  private pressedForPlay = new Set<string>();
  private pressedForMenu = new Set<string>();
  /** Gamepad index -> the player id it drives. */
  private padToPlayer = new Map<number, number>();
  /** A join has been asked for and not yet answered. See `bindGamepads`. */
  private awaitingSeat = false;
  private lastLocalCount = -1;
  private inputs: Inputs = {};
  /** Set for one poll when the "add local player" key is pressed. */
  private addPlayerRequested = false;
  /** Set for one poll when the "drop a local player" key is pressed. */
  private dropPlayerRequested = false;
  /** Set for one poll when the mute key is pressed. */
  private muteRequested = false;
  /** Quarter turns of the camera asked for since the last poll. */
  private rotateRequested = 0;
  /** Shoulder buttons already held, so a held bumper turns the room once. */
  private readonly padTurning = new Set<string>();

  constructor() {
    window.addEventListener("keydown", (e) => {
      // Typing your name is not playing: without this, the join screen's `P`
      // added a chef, and `Space` was swallowed before it reached the field.
      if (isTyping(e.target)) return;
      if (e.code === "KeyP" && !e.repeat) {
        // Shift+P drops the last one. Adding a player needed an undo: a stray
        // press, or a controller claiming a seat you did not mean to fill,
        // otherwise left a chef standing in the kitchen with no way to remove
        // it short of everyone reloading.
        if (e.shiftKey) this.dropPlayerRequested = true;
        else this.addPlayerRequested = true;
      }
      // Sound is a preference of the person at the keyboard, so it is a key
      // rather than a menu item: the pause menu's actions go to the *world*,
      // and muting one browser is nobody else's business.
      if (e.code === "KeyM" && !e.repeat) this.muteRequested = true;
      // Which way the kitchen turns. The obvious keys for this are `Q`/`E`,
      // and `E` is a grab — a camera control that sometimes throws your dinner
      // on the floor is not a camera control. The brackets are a pair, they
      // point the way they turn, and nothing else in the game wants them.
      if (e.code === "BracketLeft" && !e.repeat) this.rotateRequested -= 1;
      if (e.code === "BracketRight" && !e.repeat) this.rotateRequested += 1;
      this.keys.add(e.code);
      this.pressedForPlay.add(e.code);
      this.pressedForMenu.add(e.code);
      if (SWALLOWED.has(e.code)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.pressedForPlay.clear();
      this.pressedForMenu.clear();
    });
  }

  /** True once per press of the "add a keyboard player" key. */
  consumeDropPlayerRequest(): boolean {
    const requested = this.dropPlayerRequested;
    this.dropPlayerRequested = false;
    return requested;
  }

  /** True once per press of the mute key. */
  consumeMuteRequest(): boolean {
    const requested = this.muteRequested;
    this.muteRequested = false;
    return requested;
  }

  consumeAddPlayerRequest(): boolean {
    const requested = this.addPlayerRequested;
    this.addPlayerRequested = false;
    return requested;
  }

  /**
   * Quarter turns of the camera asked for since the last call, positive
   * clockwise.
   *
   * Pads are edge-detected here rather than in `poll`, because turning the view
   * belongs to nobody in particular: any pad in the room may do it, including
   * one that has not claimed a chef yet.
   */
  consumeRotateRequest(): number {
    let turns = this.rotateRequested;
    this.rotateRequested = 0;
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad) continue;
      for (const [button, step] of [
        [BUTTON.turnL, -1],
        [BUTTON.turnR, 1],
      ] as const) {
        const held = `${pad.index}:${button}`;
        if (!pad.buttons[button]?.pressed) {
          this.padTurning.delete(held);
          continue;
        }
        if (!this.padTurning.has(held)) turns += step;
        this.padTurning.add(held);
      }
    }
    return turns;
  }

  /** Number of player slots that at least one device is bound to. */
  /**
   * Give every new gamepad a player to drive: first any local player nobody has
   * claimed, otherwise a freshly joined one.
   *
   * `local` is this browser's player ids. Ids are stable and global now, so a
   * pad is bound to an id rather than to a position in a list — otherwise
   * someone leaving in another country would slide this browser's gamepads onto
   * different chefs.
   */
  bindGamepads(local: number[], addPlayer: () => number | null): void {
    // The roster changed, so any request we were waiting on has been answered.
    if (local.length !== this.lastLocalCount) {
      this.lastLocalCount = local.length;
      this.awaitingSeat = false;
    }

    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (!pad || this.padToPlayer.has(pad.index)) continue;
      const taken = new Set(this.padToPlayer.values());
      const free = local.find((id) => !taken.has(id));

      // A pad with a seat going spare takes it silently — it just picks up a
      // chef that already exists.
      if (free !== undefined) {
        this.padToPlayer.set(pad.index, free);
        continue;
      }

      // Creating a *new* chef needs an actual press. Merely being plugged in is
      // not a request to play, and it is what the on-screen help has always
      // promised — "press any button to join".
      if (!isPadActive(pad)) continue;

      // Online, joining is a *request*: the server owns player ids, so
      // `addPlayer` returns null and the answer arrives a round trip later.
      // Until then this pad still has no seat, so without this latch it asks
      // again on every single frame — about eleven times across a 180ms link,
      // each one creating a chef. One controller was enough to fill a kitchen.
      if (this.awaitingSeat) continue;
      const id = addPlayer();
      if (id === null) {
        this.awaitingSeat = true;
        continue;
      }
      this.padToPlayer.set(pad.index, id);
    }
  }

  /** Forget pads bound to players that are no longer ours. */
  releaseGamepads(local: number[]): void {
    const live = new Set(local);
    for (const [pad, id] of this.padToPlayer) {
      if (!live.has(id)) this.padToPlayer.delete(pad);
    }
  }

  /**
   * Menu navigation, read from *every* device at once rather than per player
   * slot. In a one-player game the arrow keys belong to nobody, and a second
   * gamepad may not be bound to a chef yet — but all of them should still be
   * able to drive a menu.
   */
  pollMenu(): MenuNav {
    const nav: MenuNav = { up: false, down: false, confirm: false, menu: false, back: false };
    const down = (codes: string[]): boolean =>
      codes.some((k) => this.keys.has(k) || this.pressedForMenu.has(k));

    for (const scheme of KEY_SCHEMES) {
      if (down(scheme.up)) nav.up = true;
      if (down(scheme.down)) nav.down = true;
      if (down(scheme.grab) || down(scheme.start)) nav.confirm = true;
      if (down(scheme.menu)) nav.menu = true;
    }
    if (down(["Backspace"])) nav.back = true;
    this.pressedForMenu.clear();

    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad) continue;
      const y = pad.axes[1] ?? 0;
      if (y < -STICK_DEADZONE || pad.buttons[12]?.pressed) nav.up = true;
      if (y > STICK_DEADZONE || pad.buttons[13]?.pressed) nav.down = true;
      if (pad.buttons[BUTTON.grab]?.pressed || pad.buttons[BUTTON.start]?.pressed) {
        nav.confirm = true;
      }
      if (pad.buttons[BUTTON.menu]?.pressed) nav.menu = true;
      if (pad.buttons[BUTTON.back]?.pressed) nav.back = true;
    }

    return nav;
  }

  /**
   * Poll inputs for this browser's players, keyed by player id.
   *
   * Keyboard schemes are handed out by *position* in `local` — the first local
   * player gets WASD whoever they are — because that is how the people sharing
   * the keyboard think about it.
   */
  poll(local: number[]): Inputs {
    this.inputs = {};
    for (let i = 0; i < local.length; i++) {
      const id = local[i]!;
      const input = emptyInput();
      const scheme = KEY_SCHEMES[i];
      if (scheme) this.applyKeys(input, scheme);
      this.inputs[id] = input;
    }
    this.pressedForPlay.clear();

    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (!pad) continue;
      const id = this.padToPlayer.get(pad.index);
      const input = id === undefined ? undefined : this.inputs[id];
      if (input) this.applyPad(input, pad);
    }

    for (const id of local) {
      const input = this.inputs[id]!;
      // Devices speak in screen directions; the kitchen is turned 41 degrees
      // away from them. Rotate first, then clamp, so quantisation stays the
      // last thing that happens to a number bound for the wire.
      screenToWorld(input.move);
      clampMove(input);
    }
    return this.inputs;
  }

  private applyKeys(input: PlayerInput, scheme: KeyScheme): void {
    const down = (codes: string[]): boolean =>
      codes.some((k) => this.keys.has(k) || this.pressedForPlay.has(k));
    if (down(scheme.up)) input.move.y -= 1;
    if (down(scheme.down)) input.move.y += 1;
    if (down(scheme.left)) input.move.x -= 1;
    if (down(scheme.right)) input.move.x += 1;
    if (down(scheme.grab)) input.grab = true;
    if (down(scheme.use)) input.use = true;
    if (down(scheme.start)) input.start = true;
    if (down(scheme.menu)) input.menu = true;
  }

  private applyPad(input: PlayerInput, pad: Gamepad): void {
    let x = pad.axes[0] ?? 0;
    let y = pad.axes[1] ?? 0;
    if (Math.hypot(x, y) < STICK_DEADZONE) {
      x = 0;
      y = 0;
    }
    // D-pad, for pads that report it as buttons 12..15.
    if (pad.buttons[12]?.pressed) y -= 1;
    if (pad.buttons[13]?.pressed) y += 1;
    if (pad.buttons[14]?.pressed) x -= 1;
    if (pad.buttons[15]?.pressed) x += 1;

    input.move.x += x;
    input.move.y += y;
    if (pad.buttons[BUTTON.grab]?.pressed) input.grab = true;
    if (pad.buttons[BUTTON.use]?.pressed || pad.buttons[BUTTON.back]?.pressed) input.use = true;
    if (pad.buttons[BUTTON.start]?.pressed) input.start = true;
    if (pad.buttons[BUTTON.menu]?.pressed) input.menu = true;
  }

  /** Player slots that currently have a gamepad attached (for the HUD). */
  padSlots(): Set<number> {
    return new Set(this.padToPlayer.values());
  }
}

/** Tags that own their own keystrokes: the join screen's name and room fields. */
const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** True when a keypress belongs to a form field rather than to the kitchen. */
function isTyping(target: EventTarget | null): boolean {
  return !!target && "tagName" in target && TYPING_TAGS.has(String(target.tagName));
}

/** True when a pad is being *used*, not merely connected. */
function isPadActive(pad: Gamepad): boolean {
  if (pad.buttons.some((button) => button.pressed)) return true;
  return pad.axes.some((axis) => Math.abs(axis) > 0.5);
}

/**
 * Clamped to a unit of speed, then quantised so identical stick positions
 * produce identical floats on every machine — a prerequisite for deterministic
 * lockstep netcode.
 */
function clampMove(input: PlayerInput): void {
  const mag = Math.hypot(input.move.x, input.move.y);
  if (mag > 1) {
    input.move.x /= mag;
    input.move.y /= mag;
  }
  input.move.x = Math.round(input.move.x * 1000) / 1000;
  input.move.y = Math.round(input.move.y * 1000) / 1000;
}

const SWALLOWED = new Set([
  "Escape",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
]);
