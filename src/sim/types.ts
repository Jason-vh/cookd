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

export type ApplianceKind =
  | "wall"
  | "counter"
  | "board"
  | "fryer"
  | "oven"
  | "crate"
  | "plates"
  | "serving"
  | "bin";

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
};

export type Order = {
  id: number;
  recipeId: string;
  remaining: number;
  patience: number;
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
};

export type Phase = "service" | "build";

export type EffectCue =
  | { kind: "served"; playerId: number; amount: number }
  | { kind: "binned"; tile: Vec2 };

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

  players: Player[];
  orders: Order[];

  phase: Phase;
  day: number;
  /** Seconds left in the service phase. */
  dayTime: number;
  /** Length of a full service phase, in seconds. */
  dayLength: number;
  /** Seconds until the next order spawns. */
  nextOrderIn: number;

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
