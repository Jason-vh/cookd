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
export type Station = "prep" | "fry" | "bake" | "wash";

/** Actions a chef performs by hand, each with its own working animation. */
export type ChefMotion = "chop" | "knead" | "mix" | "scrub";

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
  /**
   * The fitting set on this appliance's worktop, or null for a bare one.
   *
   * A **kind rather than an id**, because a fitted board is not a thing in its
   * own right: it is a property of the counter it is on, the way a source is a
   * property of a crate. It becomes an `Appliance` again only when somebody
   * lifts it off, and it travels with its host — pick the counter up and the
   * board goes with it, which is what the eye expects and what keeps the two
   * from needing to be kept in step as separate entities.
   *
   * What it buys the host is `stations`, `speed` and `patience`: see
   * `fittedDef`.
   */
  topper: ApplianceKind | null;
  /** For crates: the item this appliance dispenses. */
  source: ItemSpec | null;
  /**
   * For a recipe card: the dish on it.
   *
   * Set when the card is bought, from the offer that was standing on the
   * pallet, and read when it is set down. It is the whole of what makes one
   * card different from another — the same relationship a crate's `source` has
   * to the crate.
   *
   * A card exists only between those two moments, so this is never saved and
   * never true of anything standing on a tile.
   */
  card: string | null;
  /**
   * For stall slots: what is on sale here this morning, or null for a slot
   * that has been emptied. Rolled at restock — see `sim/shop.ts`.
   */
  offer: Offer | null;
  /**
   * For stall slots: the id of the appliance this slot handed out today.
   *
   * This is what makes remorse *undo* rather than commerce. Putting that exact
   * appliance back on that exact slot before the day opens returns the full
   * price; putting anything else there is an ordinary sale at half. A slot with
   * a `taken` reads as empty, and the offer is kept only so the refund knows
   * what it was worth.
   */
  taken: number | null;
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
   * How much kitchen this dish demands, 1..3.
   *
   * Not a day number and not a price: it is what the **card stand** rolls
   * against (see `TIER_WEIGHT`), so simple dishes turn up constantly and a
   * pizza is an event. Unlocking used to be `RECIPES.slice(0, 1 + world.day)`
   * and then an explicit `unlockDay`; both made the calendar the author of the
   * menu. Now the room is, and the day number decides nothing.
   */
  tier: number;
  /**
   * A recipe that must already be unlocked before this one may be offered.
   *
   * For dishes built on another dish's output — cheese fries are fries plus
   * chopped cheese — where the card would otherwise be unusable on arrival.
   */
  prereq?: string;
  /**
   * Human-readable steps, so a recipe cannot ship without saying how to make it.
   *
   * Read in the **pause menu**, for dishes this kitchen has unlocked. They were
   * on the card outside until a card became a picture: a chef who wants to know
   * how a dish is made is asking a question about their own menu, not about
   * what is for sale this morning, and the pause menu is where the other "how
   * does this work" surface — the controls table — already lives.
   */
  steps: string[];
  /**
   * One line of menu copy, for the card a chef reads off the board.
   *
   * What a *restaurant* would say about the dish, rather than what the kitchen
   * has to do to make it. The two used to be the same sentence and it read like
   * an instruction manual pinned up outside — which is the tell that a card was
   * a UI panel wearing a picture frame.
   */
  blurb: string;
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
  /**
   * The group they walked in with, or 0 for somebody on their own.
   *
   * A party is several people at **one table**, each with their own dish,
   * patience and appetite — so almost nothing downstream needs to know about
   * it. This id exists for the two moments that do: finding a table with enough
   * chairs for all of them, and being seated together out of the door queue.
   */
  party: number;
  /**
   * Their dinner, taken off the table when it arrives.
   *
   * A table holds one thing, and a party of three needs three dishes on it
   * within a minute of each other — so an eating customer takes their plate,
   * exactly as a person does, and puts it back dirty when they leave. Plates
   * are conserved, so this counts as a place a plate can be: see
   * `platesInWorld`.
   */
  plate: Item | null;
  /** Tile the customer stands on while seated, beside their table. */
  seat: Vec2 | null;
  /** What they will ask for, decided before they sit down. */
  recipeId: string;
  /**
   * Which sort of person this is: a row in `data/customers.ts`, drawn once at
   * the door.
   *
   * An id rather than the numbers themselves, for the reason `recipeId` is one:
   * the content is compiled into both ends, so the wire carries the name and
   * everybody looks up the same table. It is also the only thing that would
   * have to be re-tuned mid-run, and a save that stored multipliers would pin
   * yesterday's balance into every kitchen.
   */
  kind: string;
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
  /**
   * How they are dressed, by id from `data/chefs.ts`.
   *
   * Cosmetic: nothing in `sim/` reads either field. They live on the player
   * anyway because the world is what every screen is shown — an appearance kept
   * beside the renderer would be each browser's own opinion of somebody else's
   * chef, and the outfit is deliberately not one: it is resolved where the
   * players are, so two people who both chose blue are still two chefs apart.
   */
  outfit: string;
  hat: string;
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

export type Rect = { x: number; y: number; width: number; height: number };

/**
 * Walls, which live on the **seams between tiles** rather than on tiles.
 *
 * A wall used to be a solid tile, which cost the kitchen a whole square of
 * floor everywhere the building had an edge — a dividing wall as wide as the
 * counters beside it. Nothing stands *in* a wall now: it is a line between two
 * squares, and crossing it is what is refused.
 *
 * Two flat arrays, one per axis, indexed by **lattice** coordinate rather than
 * by tile: `vertical[y * (width + 1) + x]` is the seam between tiles `(x-1,y)`
 * and `(x,y)`, and `horizontal[y * width + x]` the seam between `(x,y-1)` and
 * `(x,y)`. Storing each seam once is what makes "is there a wall between these
 * two tiles" a single lookup with one answer — a per-tile set of four sides
 * would store every seam twice and could disagree with itself.
 */
export type Walls = {
  vertical: boolean[];
  horizontal: boolean[];
};

/** One seam's worth of wall: which lattice line it is on, and where. */
export type Seam = { axis: "vertical" | "horizontal"; x: number; y: number };

/**
 * A drive-through lane: where cars come from, and where they go.
 *
 * Both ends are patio tiles, and the tile outside the hatch is on the straight
 * line between them — `validate.ts` insists on it, and everything in `lane.ts`
 * is arithmetic because of it. A queue spaced by counting rather than by bodies
 * is the same trick the line at the door plays, for the same reason: cars are
 * ghosts to each other, as every customer in this game is.
 */
export type Lane = { entry: Vec2; exit: Vec2 };

export type Tile = {
  /** true for the one tile inside the doorway customers arrive through. */
  door: boolean;
  /**
   * Floor or paving, as opposed to the grass between them.
   *
   * The grid used to be the building plus its ring exactly, so every square in
   * it was somewhere to stand and "walkable" needed no field. A market square
   * further out ends that: the ground between here and there is scenery, and
   * scenery is not walked on. **Walkable = paved** is now a fact the level
   * states — see `LevelDef.paving` — rather than one the grid's dimensions
   * happened to imply.
   */
  walkable: boolean;
  /**
   * May an appliance stand here?
   *
   * A property of the tile rather than a test for "is this outside", so the
   * patio ring is refused by the same rule that refuses the paving, and so outdoor
   * seating one day is a flag on some tiles rather than a special case in
   * `canPlace`. The **door is placeable**: sealing your own dining room off is
   * a thing a player is allowed to do to their own kitchen (the build phase
   * warns them), it is only not a thing the game may do on their behalf — see
   * `isFreeTile`.
   */
  placeable: boolean;
};

/**
 * Something the stall will sell you: one appliance, and what is in it.
 *
 * This used to be a union, because a single plate arrived in your hands as an
 * item rather than as a held ghost. It was the only offer that did, and it was
 * the only one the morning could not actually put down — the build phase
 * understands appliances, so the grab meant to set a plate on a counter lifted
 * the counter instead. Plates are sold by the **stack** now, crockery included,
 * and the shop has one shape again.
 *
 * `recipe` is the dish on a `cards` offer, and it kept the shape: a card *is*
 * an appliance you carry, and which dish is on it is a property of that one
 * object exactly as which ingredient is in it is a property of a crate. It
 * names an id rather than holding a `Recipe` because an offer rides the wire,
 * and content is not something to send — both ends have the cookbook.
 */
export type Offer = { kind: ApplianceKind; source: ItemSpec | null; recipe?: string };

/**
 * One day's takings, kept apart from the lifetime totals beside them.
 *
 * The end-of-day card is where the shop's numbers get their meaning — "we made
 * forty, and the oven is sixty" is the sentence the whole economy exists to
 * produce — and none of it can be recovered from `money`, `served` and `lost`,
 * which are cumulative. So the day counts itself as it goes.
 *
 * `day` is on the ledger rather than read from the world, because during the
 * build phase `world.day` is already the *upcoming* day and this is a report
 * about the one that just closed.
 */
export type Ledger = {
  day: number;
  /** Rewards paid on delivery. */
  earned: number;
  /** Money picked up off tables. */
  tips: number;
  served: number;
  /** Walkouts by recipe id — what the kitchen kept failing to make. */
  lost: Record<string, number>;
  /** What the landlord took at closing time. Zero on a day nobody was charged. */
  rent: number;
};

export type Phase = "service" | "build";

export type EffectCue =
  | { kind: "served"; playerId: number; amount: number }
  | { kind: "tipped"; playerId: number; amount: number }
  /** Paid at a table rather than to a chef: the food was already waiting. */
  | { kind: "paid"; tile: Vec2; amount: number }
  | { kind: "binned"; tile: Vec2 }
  | { kind: "walkout"; tile: Vec2 }
  /** Money leaving: a purchase. */
  | { kind: "spent"; tile: Vec2; amount: number }
  /**
   * The stall said no. Never a silent refusal: the log says why and the slot's
   * label flashes red, because a button that does nothing is indistinguishable
   * from a button that is broken.
   */
  | { kind: "refused"; tile: Vec2 };

export type Effect = EffectCue & { id: number; ttl: number };

export type World = {
  tick: number;
  nextId: number;
  /**
   * True for a world a client is guessing in, rather than one anybody's screen
   * is the record of.
   *
   * The online client runs its own chefs ahead of the server and re-runs every
   * unacknowledged tick each time a frame lands, so anything a predicted tick
   * *announces* — a log line, a puff of coins — would be announced again on
   * every frame until the server caught up, twenty times a second. What a
   * prediction may do is move things; saying so out loud is the server's, and
   * it arrives with the frame that confirms it.
   */
  predicting: boolean;
  /** Handed out to joining players; never reused, so ids stay unambiguous. */
  nextPlayerId: number;
  rngState: number;
  /**
   * The room's seed, kept alongside the stream it started.
   *
   * `rngState` is consumed by play — by which chair somebody sits in, and how
   * long until the next arrival — so two kitchens on the same seed diverge
   * within a minute of opening. Anything that has to be *identical on every
   * client* and is not sent over the wire must therefore be drawn from the seed
   * and something stable, not from the live stream. The stall's stock is rolled
   * from `(seed, day)` for exactly that reason.
   */
  seed: number;

  width: number;
  height: number;
  tiles: Tile[];
  /** The building: kitchen floor inside, patio outside. */
  room: Rect;
  /**
   * The paved ground outside the building: the ring, and whatever it leads to.
   *
   * The tiles already know (`Tile.walkable`); this is the same fact as
   * rectangles, because the renderer lays slabs rather than tiles and a
   * marching-squares outline of a tile set is a great deal of machinery for a
   * shape somebody drew as three rooms in the first place.
   */
  paving: Rect[];
  walls: Walls;
  /**
   * The drive-through lane, or null for a kitchen with a dining room.
   *
   * The one field that says which of the two kinds of restaurant this is.
   * Customers are cars where it is set and diners where it is not — there is no
   * flag on the customer, because a room is one thing or the other and a
   * customer who could be either would be a second answer to the same question.
   */
  lane: Lane | null;
  /** appliance id per tile index, or 0 for none. */
  applianceAt: number[];
  appliances: Map<number, Appliance>;
  /**
   * Bumped by every change to what the layout message carries. The server
   * watches this to decide whether to resend the layout, which it would
   * otherwise have to work out by rebuilding and comparing a signature string
   * 60 times a second.
   *
   * Anything that moves, adds or removes an appliance must call `touchLayout`.
   * That is a rule a reader has to keep, which is why the two places it applies
   * (`buildGrab`, `returnAppliance`) are the only two places allowed to write
   * to `applianceAt` outside world construction.
   *
   * **It is not only about position.** A slot's `offer` rides the same message
   * — the recipe card among them — so the morning roll is a layout change too,
   * and it is missed easily, because nothing has moved. `restockStall` does it
   * itself rather than trusting its callers: the day it did not, a client spent
   * a whole day reading yesterday's price off a slot the host had restocked.
   */
  layoutVersion: number;

  players: Player[];
  customers: Customer[];
  /** Tile customers walk in through, taken from the level. */
  door: Vec2;

  phase: Phase;
  /**
   * The chef whose pause menu is open, or null for a kitchen that is running.
   *
   * Pausing is a fact about the **room**, not about a screen. It used to be a
   * screen: the menu blanked your own input and the day carried on without you,
   * which is the only honest thing a client can do on its own — and it meant
   * that reading the controls during a rush cost you the rush. So the kitchen
   * holds it, `step` refuses to advance while it is set, and everybody else
   * sees who did it.
   *
   * The **name** rides alongside the id because it is what the other screens
   * show, and a seat can leave between pausing and being drawn.
   */
  pausedBy: number | null;
  pausedName: string;
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

  /**
   * The till, which can go **negative**: an unpaid rent is a debt rather than a
   * refused transaction. See `chargeRent`.
   */
  money: number;
  served: number;
  lost: number;
  /** The day in progress, or the one that just closed while it is the morning. */
  today: Ledger;

  /**
   * The run is over: the rent went unpaid two closings running.
   *
   * The only end state the game has, and it is deliberately inert — nothing is
   * destroyed, the kitchen stands exactly as it was, and the sign simply will
   * not open another day. Resetting is what starts a new run, which is a thing
   * a player does on purpose rather than something a rule does to them.
   */
  evicted: boolean;

  /**
   * The recipes this room has bought, oldest first.
   *
   * **This is the order pool**, and there is no other. It replaced a day-slice
   * over `RECIPES`, so what customers ask for is now a record of the room's own
   * choices rather than of the calendar. Saved like the layout and the money,
   * and kept across a reset — reset un-wrecks the layout, it does not delete
   * history.
   *
   * Ordered rather than a `Set` because the *newest* entry is load-bearing: it
   * takes about half of the first service day's orders (see `LAUNCH_SHARE`), so
   * first contact with a dish happens under deliberate repetition.
   */
  unlocked: string[];
  /**
   * The day the newest recipe was unlocked, or 0 for a room that has never
   * picked a card.
   *
   * Two jobs, and they are one fact seen from two sides: it is how long
   * `unlocked`'s last entry keeps its launch-day share of the orders, and it is
   * what lets a save come back into a morning without re-running that.
   *
   * It used to have a third — "this morning's offer is already spent" — and a
   * card being a good took it away. A bought card empties its square through
   * `taken`, exactly as a bought oven does, and one fewer special case is the
   * whole reason to put the two on the same paving.
   */
  unlockedDay: number;

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
