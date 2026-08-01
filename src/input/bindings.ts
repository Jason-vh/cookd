/**
 * What each key does, as plain data.
 *
 * Split out of the input layer because these are now three things at once: the
 * defaults, whatever the player has since changed them to, and *another
 * machine's data* read back out of storage. Only the first of those can be a
 * const buried next to the keydown listener.
 *
 * No DOM in here, deliberately — the same functions run in the browser, in the
 * rebinding UI and in tests.
 */

/** Actions belonging to one chef, in the order the controls table lists them. */
export const PLAYER_ACTIONS = [
  "up",
  "down",
  "left",
  "right",
  "grab",
  "use",
  "start",
  "menu",
] as const;

/**
 * Actions belonging to the *browser* rather than to a chef: they are about who
 * is playing, what the room looks like and whether you can hear it. There is
 * one set of them however many people are sharing the keyboard, which is why
 * they are not part of a scheme.
 */
export const GLOBAL_ACTIONS = ["addPlayer", "dropPlayer", "mute", "turnLeft", "turnRight"] as const;

export type PlayerAction = (typeof PLAYER_ACTIONS)[number];
export type GlobalAction = (typeof GLOBAL_ACTIONS)[number];
export type Action = PlayerAction | GlobalAction;

/** The keys one keyboard player has, by action. An empty list means unbound. */
export type KeyScheme = Record<PlayerAction, string[]>;
export type GlobalScheme = Record<GlobalAction, string[]>;

export type KeyBindings = {
  /** One scheme per keyboard player. Scheme 0 always drives the first local chef. */
  players: KeyScheme[];
  global: GlobalScheme;
};

/** Where an action lives: a keyboard player's scheme, or the global set. */
export type Slot =
  | { scheme: number; action: PlayerAction }
  | { scheme: "global"; action: GlobalAction };

/**
 * Build a complete record of actions, one value at a time.
 *
 * Spelled out rather than folded from `PLAYER_ACTIONS`, because a record built
 * key by key in a loop is only *complete* if you assert that it is — and casts
 * are banned here for reasons worth keeping (see `.oxlintrc.json`). Written
 * this way the compiler checks it, and adding an action fails to build until
 * every one of these is dealt with.
 */
export function byPlayerAction<T>(value: (action: PlayerAction) => T): Record<PlayerAction, T> {
  return {
    up: value("up"),
    down: value("down"),
    left: value("left"),
    right: value("right"),
    grab: value("grab"),
    use: value("use"),
    start: value("start"),
    menu: value("menu"),
  };
}

export function byGlobalAction<T>(value: (action: GlobalAction) => T): Record<GlobalAction, T> {
  return {
    addPlayer: value("addPlayer"),
    dropPlayer: value("dropPlayer"),
    mute: value("mute"),
    turnLeft: value("turnLeft"),
    turnRight: value("turnRight"),
  };
}

export const ACTION_LABELS: Record<Action, string> = {
  up: "Move up",
  down: "Move down",
  left: "Move left",
  right: "Move right",
  grab: "Grab / place / serve / open up",
  use: "Hold to prep",
  // It opened the day until the sign by the door took that over. What is left
  // is the job it always also had: saying yes to a menu, and putting down the
  // end-of-day report.
  start: "Confirm",
  menu: "Pause menu",
  addPlayer: "Add a local player",
  dropPlayer: "Remove a local player",
  mute: "Sound on / off",
  turnLeft: "Turn the kitchen left",
  turnRight: "Turn the kitchen right",
};

/**
 * Actions two keyboard players may hold the same key for.
 *
 * Both schemes ship with `Enter` and `Esc`, and that is not an oversight: they
 * open the next day and the pause menu, which happen to the *room* rather than
 * to a chef, so it does not matter whose finger did it. Everything else is a
 * chef doing something, and two chefs sharing a key means one of them moves
 * when the other meant to.
 */
const SHARED_ACTIONS: ReadonlySet<PlayerAction> = new Set(["start", "menu"]);

const DEFAULTS: KeyBindings = {
  players: [
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
  ],
  global: {
    addPlayer: ["KeyP"],
    dropPlayer: ["Shift+KeyP"],
    mute: ["KeyM"],
    // The obvious keys for turning the view are `Q`/`E`, and `E` is a grab — a
    // camera control that sometimes throws your dinner on the floor is not a
    // camera control. The brackets are a pair and they point the way they turn.
    turnLeft: ["BracketLeft"],
    turnRight: ["BracketRight"],
  },
};

/** A fresh copy, because bindings are edited and these are the originals. */
export function defaultBindings(): KeyBindings {
  return clone(DEFAULTS);
}

function clone(bindings: KeyBindings): KeyBindings {
  return {
    players: bindings.players.map((scheme) => byPlayerAction((a) => [...scheme[a]])),
    global: byGlobalAction((a) => [...bindings.global[a]]),
  };
}

/** True when the two bindings say the same thing. */
export function sameBindings(a: KeyBindings, b: KeyBindings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The keys currently bound to one slot. */
export function keysFor(bindings: KeyBindings, slot: Slot): string[] {
  return slot.scheme === "global"
    ? bindings.global[slot.action]
    : (bindings.players[slot.scheme]?.[slot.action] ?? []);
}

/**
 * Bind `key` to one slot, taking it off every other action.
 *
 * A key that does two jobs at once is a chef who chops when you meant to walk,
 * and across schemes it is two people fighting over one keyboard. The one
 * exception is a shared action in the other scheme — see `SHARED_ACTIONS`.
 *
 * Returns new bindings; the argument is not touched.
 */
export function bindKey(bindings: KeyBindings, slot: Slot, key: string): KeyBindings {
  const next = clone(bindings);
  const keep = slot.scheme !== "global" && SHARED_ACTIONS.has(slot.action) ? slot.action : null;

  for (const scheme of next.players) {
    for (const action of PLAYER_ACTIONS) {
      if (action === keep) continue;
      scheme[action] = scheme[action].filter((code) => code !== key);
    }
  }
  for (const action of GLOBAL_ACTIONS) {
    next.global[action] = next.global[action].filter((code) => code !== key);
  }

  if (slot.scheme === "global") next.global[slot.action] = [key];
  else {
    const scheme = next.players[slot.scheme];
    if (scheme) scheme[slot.action] = [key];
  }
  return next;
}

/** Unbind a slot entirely. An action with no key is simply unavailable. */
export function clearKeys(bindings: KeyBindings, slot: Slot): KeyBindings {
  const next = clone(bindings);
  if (slot.scheme === "global") next.global[slot.action] = [];
  else {
    const scheme = next.players[slot.scheme];
    if (scheme) scheme[slot.action] = [];
  }
  return next;
}

/**
 * Read bindings written by some other version of the game.
 *
 * Anything unrecognised falls back to the default for that action rather than
 * failing the lot: a player who has remapped `use` should not lose it because a
 * later version added an action their storage has never heard of.
 */
export function parseBindings(value: unknown): KeyBindings {
  if (!isRecord(value)) return defaultBindings();
  // Annotated, not inferred: `Array.isArray` on an `unknown` narrows to `any[]`,
  // and `any` is the thing this file exists to stop at the door.
  const players: unknown[] = Array.isArray(value.players) ? value.players : [];
  const global = isRecord(value.global) ? value.global : {};
  return dedupe({
    players: DEFAULTS.players.map((fallback, i) => {
      const stored = players[i];
      const scheme = isRecord(stored) ? stored : {};
      return byPlayerAction((action) => parseKeys(scheme[action], fallback[action]));
    }),
    global: byGlobalAction((action) => parseKeys(global[action], DEFAULTS.global[action])),
  });
}

/** One action's keys, or the default if what was stored is not a list of them. */
function parseKeys(stored: unknown, fallback: string[]): string[] {
  if (!Array.isArray(stored)) return [...fallback];
  return stored.filter((key): key is string => typeof key === "string" && key !== "").slice(0, 4);
}

/**
 * Drop any key doing a second job, keeping the first claim.
 *
 * `bindKey` maintains this, so it only matters for data out of storage — but
 * that is exactly the data allowed to be nonsense, and a double-bound key is
 * unplayable rather than merely odd.
 */
function dedupe(bindings: KeyBindings): KeyBindings {
  const owner = new Map<string, string>();
  // Who a key belongs to: an action, or a *player's* action where two players
  // holding the same one would be two chefs on one key.
  const claim = (action: string, keys: string[]): string[] =>
    keys.filter((key) => {
      const claimed = owner.get(key);
      if (claimed !== undefined && claimed !== action) return false;
      owner.set(key, action);
      return true;
    });

  // Claimed in a pass of its own, so who gets the key depends on the order of
  // the actions rather than on the order an object literal happens to evaluate.
  const players = bindings.players.map((scheme, index) => {
    const kept = new Map<PlayerAction, string[]>();
    for (const action of PLAYER_ACTIONS) {
      const owned = SHARED_ACTIONS.has(action) ? action : `${index}:${action}`;
      kept.set(action, claim(owned, scheme[action]));
    }
    return byPlayerAction((action) => kept.get(action) ?? []);
  });
  // Globals claim last, and under their own names: `mute` and a chef's `use`
  // are different jobs even though both are called an action here.
  const kept = new Map<GlobalAction, string[]>();
  for (const action of GLOBAL_ACTIONS) kept.set(action, claim(action, bindings.global[action]));
  return { players, global: byGlobalAction((action) => kept.get(action) ?? []) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Every key currently doing something, for deciding what to take from the browser. */
export function boundKeys(bindings: KeyBindings): Set<string> {
  const keys = new Set<string>();
  for (const scheme of bindings.players) {
    for (const action of PLAYER_ACTIONS) {
      for (const key of scheme[action]) keys.add(chordOf(key).code);
    }
  }
  for (const action of GLOBAL_ACTIONS) {
    for (const key of bindings.global[action]) keys.add(chordOf(key).code);
  }
  return keys;
}

/**
 * A binding is a `KeyboardEvent.code`, optionally with `Shift+` in front.
 *
 * Shift is the only modifier the game has ever used (`Shift`+`P` removes a
 * player), and one modifier is the difference between a key *chord* and a
 * shortcut system nobody asked for. Supporting it here means the one key that
 * needed it is not a special case in the input layer, and a player who wants
 * `Shift`+`M` may have it.
 */
export type Chord = { code: string; shift: boolean };

export function chordOf(key: string): Chord {
  return key.startsWith("Shift+")
    ? { code: key.slice("Shift+".length), shift: true }
    : { code: key, shift: false };
}

export function chordKey(code: string, shift: boolean): string {
  // A binding of Shift *itself* is the key, not a modifier for nothing.
  if (!shift || code === "ShiftLeft" || code === "ShiftRight") return code;
  return `Shift+${code}`;
}

const NAMED: Record<string, string> = {
  Space: "Space",
  Escape: "Esc",
  Enter: "Enter",
  Backspace: "Backspace",
  Tab: "Tab",
  ArrowUp: "\u2191",
  ArrowDown: "\u2193",
  ArrowLeft: "\u2190",
  ArrowRight: "\u2192",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  ShiftLeft: "L Shift",
  ShiftRight: "R Shift",
  ControlLeft: "L Ctrl",
  ControlRight: "R Ctrl",
  AltLeft: "L Alt",
  AltRight: "R Alt",
  MetaLeft: "L Cmd",
  MetaRight: "R Cmd",
  NumpadDecimal: "Num .",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num -",
  NumpadEnter: "Num Enter",
  CapsLock: "Caps",
};

/** A binding as something worth printing on a key cap. */
export function keyLabel(key: string): string {
  const chord = chordOf(key);
  return chord.shift ? `Shift + ${codeLabel(chord.code)}` : codeLabel(chord.code);
}

function codeLabel(code: string): string {
  const named = NAMED[code];
  if (named) return named;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
}

/** All the keys for one action, as one label: `Space / E`. */
export function keysLabel(keys: readonly string[]): string {
  return keys.length === 0 ? "\u2014" : keys.map(keyLabel).join(" / ");
}
