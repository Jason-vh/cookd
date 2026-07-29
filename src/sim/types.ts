/**
 * Core simulation types.
 *
 * RULE: nothing in `src/sim` may import from `src/render`, `src/ui` or touch
 * the DOM. The simulation is a pure function of (World, PlayerInput[], dt) so
 * that it can later be run headless on a server for online multiplayer, and so
 * it can be unit tested and replayed from an input log.
 */

export type Vec2 = { x: number; y: number };

export type IngredientId = string;
export type ProcessId = string;

/**
 * An item is an ingredient "base" plus the ordered list of processes applied to
 * it. `contents` is only used by containers (plates), and for the POC a plate
 * holds at most one finished dish.
 *
 * Examples:
 *   { base: "tomato", processes: [] }
 *   { base: "tomato", processes: ["chopped"] }
 *   { base: "pizza",  processes: ["sauced", "topped", "baked"] }
 */
export type Item = {
  id: number;
  base: IngredientId;
  processes: ProcessId[];
  contents: Item[];
};

/** Matcher for an item; matching is exact (same base, same process sequence). */
export type ItemSpec = {
  base: IngredientId;
  processes: ProcessId[];
};

/**
 * Every kind of appliance there is.
 *
 * Defined by the content table in `data/appliances.ts` and re-exported here, so
 * that the simulation still reads as the owner of its own vocabulary while
 * adding an appliance stays a one-row change to data. It used to be a
 * hand-written union in this file, which meant a new appliance was a change to
 * the *simulation's types* — the one boundary this codebase is otherwise
 * careful about.
 */
export type { ApplianceKind } from "../data/appliances";

import type { ApplianceKind } from "../data/appliances";

/**
 * What work an appliance can do. Transforms are keyed by station rather than by
 * appliance kind, so several appliances can offer the same work at different
 * speeds (any counter can prep; a board just does it faster).
 */
export type Station = "prep" | "fry" | "bake";

/** Actions a chef performs by hand, each with its own working animation. */
export type ChefMotion = "chop" | "knead" | "mix";

/**
 * The physical action a transform represents. Purely a presentation hint — the
 * simulation treats every transform of a given mode identically — but it lives
 * in the data so new content brings its own animation (and later, its own
 * sound) rather than needing a change in the render layer.
 */
export type Motion = ChefMotion | "fry" | "bake";

export type Appliance = {
  id: number;
  kind: ApplianceKind;
  tile: Vec2;
  /** Item currently resting on / inside this appliance. */
  item: Item | null;
  /** 0..1 progress of the active transform. */
  progress: number;
  /** Seconds spent sitting on a hot appliance after its transform completed. */
  overcook: number;
  /** Set to true on the frame a transform completes (render/audio hook). */
  justFinished: boolean;
  /** The action currently being performed here, if a chef is working it. */
  motion: Motion | null;
  /** For crates: the item this appliance dispenses. */
  source: ItemSpec | null;
  /** Carried by a player during the build phase (tile is then unoccupied). */
  heldBy: number | null;
  /**
   * For tables: money a customer left behind, collected by whoever busses the
   * dirty plate. Splitting payment this way is what stops clearing tables from
   * being a chore — the tip is the reason to walk over, and the dirty plate
   * comes along with it.
   */
  tip: number;
};

/** One transform, e.g. "chop a tomato at a prep station for 2s". */
export type Transform = {
  station: Station;
  input: ItemSpec;
  output: ItemSpec;
  duration: number;
  /** "hold": a player must hold USE. "auto": runs on its own once loaded. */
  mode: "hold" | "auto";
  /** How it looks when worked. Only meaningful for "hold" transforms. */
  motion?: Motion;
  /** Seconds after completion before the item burns. Undefined = never burns. */
  burnAfter?: number;
};

/** Two items merged by placing one on top of the other. Order-insensitive. */
export type Combine = {
  a: ItemSpec;
  b: ItemSpec;
  output: ItemSpec;
};

export type Recipe = {
  id: string;
  name: string;
  /** The plated dish that satisfies this order. */
  dish: ItemSpec;
  /** Seconds a customer will wait. */
  patience: number;
  reward: number;
  /**
   * First day this can be ordered.
   *
   * Unlocking used to be `RECIPES.slice(0, 1 + world.day)` — the difficulty
   * curve was the *array order*, so reordering the list for readability changed
   * the game, and inserting a hard recipe in the middle silently changed day
   * one. Saying it out loud makes content order irrelevant, which is the whole
   * promise of "adding a recipe means adding a row".
   */
  unlockDay: number;
  /** Human-readable steps, so a recipe cannot ship without saying how to make it. */
  steps: string[];
};

/**
 * Where a customer is in their visit.
 *
 *   arriving -> (seat claimed) -> deciding -> ordering -> eating -> leaving
 *   arriving -> (no free table) -> waiting -> deciding | leaving
 *
 * The order *is* the customer: there is no separate ticket entity, so a lost
 * order and a person walking out are necessarily the same event.
 */
export type CustomerState = "arriving" | "waiting" | "deciding" | "ordering" | "eating" | "leaving";

export type Customer = {
  id: number;
  state: CustomerState;
  pos: Vec2;
  /** Position at the start of the current tick, for render interpolation. */
  prevPos: Vec2;
  facing: Vec2;
  /** Table appliance id, claimed on arrival so two customers never race for it. */
  table: number | null;
  /** Tile the customer stands on while seated, beside their table. */
  seat: Vec2 | null;
  /** What they will ask for, decided before they sit down. */
  recipeId: string;
  /** Tile centres still to walk through. */
  path: Vec2[];
  /** Seconds left in the current timed state (deciding / eating / waiting). */
  timer: number;
  /** Only counts down while `ordering`. */
  remaining: number;
  patience: number;
  /** Earned on delivery, left on the table when they go. */
  tip: number;
};

/**
 * Inputs for one tick, keyed by **player id**.
 *
 * Not an array: ids are stable for a player's whole session and are not
 * positions in `world.players`. A player leaving must not renumber everyone
 * after them — online, that would silently hand one player another's chef.
 */
export type Inputs = Record<number, PlayerInput | undefined>;

export type PlayerInput = {
  /** Normalised movement vector, magnitude <= 1. */
  move: Vec2;
  /** Pick up / put down / throw-into. */
  grab: boolean;
  /** Hold-to-work (chopping, mixing). */
  use: boolean;
  /** Confirm — opens the next day from the build phase. */
  start: boolean;
  /** Pause / options — handled by the shell, not the simulation. */
  menu: boolean;
};

export type Player = {
  /** Stable for the player's whole session. Never an index into `players`. */
  id: number;
  /** Shown above the chef and in the log. Empty for local-only players. */
  name: string;
  /**
   * Connection dropped, but their seat is being kept warm. Purely descriptive:
   * the simulation never reads it, the `Host` simply feeds them empty input and
   * the renderer fades them out.
   */
  away: boolean;
  pos: Vec2;
  /** Position at the start of the current tick, for render interpolation. */
  prevPos: Vec2;
  facing: Vec2;
  carried: Item | null;
  /** Appliance being carried during the build phase. */
  carriedAppliance: number | null;
  /** Appliance this player is currently working (hold-to-use). */
  workingOn: number | null;
  prev: PlayerInput;
};

export type Tile = {
  /** true for the outer shell; walls are solid and can never hold appliances. */
  wall: boolean;
  /** true for the gap in the wall customers arrive through. */
  door: boolean;
};

export type Phase = "service" | "build";

export type EffectCue =
  | { kind: "served"; playerId: number; amount: number }
  | { kind: "tipped"; playerId: number; amount: number }
  /** Paid at a table rather than to a chef: the food was already waiting. */
  | { kind: "paid"; tile: Vec2; amount: number }
  | { kind: "binned"; tile: Vec2 }
  | { kind: "walkout"; tile: Vec2 };

export type Effect = EffectCue & { id: number; ttl: number };

export type World = {
  tick: number;
  nextId: number;
  /** Handed out to joining players; never reused, so ids stay unambiguous. */
  nextPlayerId: number;
  rngState: number;

  width: number;
  height: number;
  tiles: Tile[];
  /** appliance id per tile index, or 0 for none. */
  applianceAt: number[];
  appliances: Map<number, Appliance>;
  /**
   * Bumped by every change to where appliances are. The server watches this to
   * decide whether to resend the layout, which it would otherwise have to work
   * out by rebuilding and comparing a signature string 60 times a second.
   *
   * Anything that moves, adds or removes an appliance must call `touchLayout`.
   * That is a rule a reader has to keep, which is why the two places it applies
   * (`buildGrab`, `returnAppliance`) are the only two places allowed to write
   * to `applianceAt` outside world construction.
   */
  layoutVersion: number;

  players: Player[];
  customers: Customer[];
  /** Tile customers walk in through, taken from the level. */
  door: Vec2;

  phase: Phase;
  day: number;
  /**
   * Seconds left in the service phase. Goes **negative** after closing time:
   * arrivals stop, but the day is not over until the last customer has eaten
   * and left. That overrun is the "kitchen's closed" beat.
   */
  dayTime: number;
  /** Length of a full service phase, in seconds. */
  dayLength: number;
  /** Seconds until the next customer walks up the path. */
  nextArrivalIn: number;

  money: number;
  served: number;
  lost: number;

  /** Transient log lines for the HUD ("Served pizza +$15"). */
  events: { text: string; ttl: number }[];
  /**
   * One-shot cues for the render layer: a dish served, something binned. Kept
   * separate from `events` because those are words and these are moments.
   *
   * They expire on a timer rather than being cleared each tick, because a
   * render frame can span several ticks and must not miss one. The render layer
   * remembers the highest id it has already shown.
   */
  effects: Effect[];
};
