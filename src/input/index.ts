import { emptyInput } from "../sim/world";
import { screenToWorld } from "../orientation";
import type { Inputs, PlayerInput } from "../sim/types";
import {
  GLOBAL_ACTIONS,
  boundKeys,
  byGlobalAction,
  byPlayerAction,
  chordOf,
  defaultBindings,
  type Chord,
  type GlobalAction,
  type KeyBindings,
  type PlayerAction,
} from "./bindings";

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
 * *Which* key does what is not decided here either — see `bindings.ts`. This
 * layer holds compiled bindings and asks them questions.
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

/** Bindings with every key pre-parsed, so a frame is not parsing strings. */
type Compiled = {
  players: Record<PlayerAction, Chord[]>[];
  global: Record<GlobalAction, Chord[]>;
  bound: Set<string>;
};

function compile(bindings: KeyBindings): Compiled {
  return {
    players: bindings.players.map((scheme) =>
      byPlayerAction((action) => scheme[action].map(chordOf)),
    ),
    global: byGlobalAction((action) => bindings.global[action].map(chordOf)),
    bound: boundKeys(bindings),
  };
}

// Standard gamepad mapping. Start opens the pause menu; the north face button
// (Y / Triangle) confirms a menu item, so the two can never conflict.
// `back` (B / Circle) doubles as an alternate USE during play and as "close the
// menu" while it is open — the two contexts are mutually exclusive, so they
// cannot conflict.
// The shoulders turn the kitchen, which is the one control that is about the
// *view* rather than about the chef — so it sits where a camera control sits on
// every other pad.
const BUTTON = { grab: 0, use: 2, start: 3, menu: 9, back: 1, turnL: 4, turnR: 5 } as const;
const STICK_DEADZONE = 0.22;

export class InputManager {
  private bindings: KeyBindings;
  private compiled: Compiled;
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
  /** The rebinding UI, waiting for one keypress. See `capture`. */
  private capturing: ((event: KeyboardEvent) => void) | null = null;

  constructor(bindings: KeyBindings = defaultBindings()) {
    this.bindings = bindings;
    this.compiled = compile(bindings);

    window.addEventListener("keydown", (e) => {
      // Typing your name is not playing: without this, the join screen's `P`
      // added a chef, and `Space` was swallowed before it reached the field.
      if (isTyping(e.target)) return;

      // A key being *chosen* is not a key being pressed. Rebinding takes the
      // whole event and nothing else sees it, so binding `Esc` to something
      // cannot also close the menu you are binding it in.
      if (this.capturing) {
        const capture = this.capturing;
        this.capturing = null;
        e.preventDefault();
        if (!e.repeat) capture(e);
        return;
      }

      if (!e.repeat) this.fireGlobals(e);
      this.keys.add(e.code);
      this.pressedForPlay.add(e.code);
      this.pressedForMenu.add(e.code);
      // Keys the game uses are keys the game takes: `Space` scrolls a page and
      // `Enter` clicks whatever the browser thinks is focused. Only the bound
      // ones, so a key nobody mapped still belongs to the browser.
      if (this.compiled.bound.has(e.code)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.pressedForPlay.clear();
      this.pressedForMenu.clear();
    });
  }

  /**
   * The one-shot, edge-triggered controls: they add and remove players, turn
   * the room and mute the game.
   *
   * Matched on the keydown itself rather than against held state, because a
   * modifier is part of a *tap*: `Shift`+`P` must remove a player without also
   * reading as the plain `P` that adds one.
   */
  private fireGlobals(e: KeyboardEvent): void {
    for (const action of GLOBAL_ACTIONS) {
      if (!this.compiled.global[action].some((c) => c.code === e.code && c.shift === e.shiftKey)) {
        continue;
      }
      switch (action) {
        // Adding a player needed an undo: a stray press, or a controller
        // claiming a seat you did not mean to fill, otherwise left a chef
        // standing in the kitchen with no way to remove it short of everyone
        // reloading.
        case "addPlayer":
          this.addPlayerRequested = true;
          break;
        case "dropPlayer":
          this.dropPlayerRequested = true;
          break;
        // Sound is a preference of the person at the keyboard, so it is a key
        // rather than a menu item: the pause menu's actions go to the *world*,
        // and muting one browser is nobody else's business.
        case "mute":
          this.muteRequested = true;
          break;
        case "turnLeft":
          this.rotateRequested -= 1;
          break;
        case "turnRight":
          this.rotateRequested += 1;
          break;
      }
      e.preventDefault();
    }
  }

  /** The keys as they stand. */
  get keyBindings(): KeyBindings {
    return this.bindings;
  }

  /** Change what the keys do, from now on. */
  setBindings(bindings: KeyBindings): void {
    this.bindings = bindings;
    this.compiled = compile(bindings);
    // Anything held under the old bindings is no longer held under the new
    // ones: a chef should not keep walking because the key that moved them has
    // just become something else.
    this.keys.clear();
    this.pressedForPlay.clear();
    this.pressedForMenu.clear();
  }

  /**
   * Hand the next keypress to `handler` instead of to the game.
   *
   * This is how a key is *chosen* rather than pressed. It lives here because
   * this class owns the only keydown listener in the game — a second one in the
   * rebinding UI would see keys this one swallows, in an order neither of them
   * controls. Returns a function that cancels the wait.
   */
  capture(handler: (event: KeyboardEvent) => void): () => void {
    this.capturing = handler;
    return () => {
      if (this.capturing === handler) this.capturing = null;
    };
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
    const down = (chords: Chord[]): boolean => this.held(chords, this.pressedForMenu);

    for (const scheme of this.compiled.players) {
      if (down(scheme.up)) nav.up = true;
      if (down(scheme.down)) nav.down = true;
      if (down(scheme.grab) || down(scheme.start)) nav.confirm = true;
      if (down(scheme.menu)) nav.menu = true;
    }
    if (down([{ code: "Backspace", shift: false }])) nav.back = true;
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
      const scheme = this.compiled.players[i];
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

  /**
   * Is any of these keys down?
   *
   * A chord asking for `Shift` needs `Shift`; one that does not, does not care —
   * you are holding `Shift` to prep and still expect `W` to walk. Which is also
   * why `fireGlobals` matches the other way: held controls overlap by nature,
   * taps do not.
   */
  private held(chords: Chord[], pressed: Set<string>): boolean {
    const shift = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    return chords.some(
      (c) => (!c.shift || shift) && (this.keys.has(c.code) || pressed.has(c.code)),
    );
  }

  private applyKeys(input: PlayerInput, scheme: Record<PlayerAction, Chord[]>): void {
    const down = (chords: Chord[]): boolean => this.held(chords, this.pressedForPlay);
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
