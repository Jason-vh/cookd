import type { ApplianceKind, ItemSpec, Vec2 } from "../sim/types";

/**
 * Kitchens are structured data: a rectangle for the building, a list of walls,
 * and a list of what stands where.
 *
 * They used to be ASCII pictures, and a picture is a lovely thing to read right
 * up until it has to say something that is not one-thing-per-cell. Everything
 * that was not a cell got bolted on: a flag so the sign could live in a wall,
 * six characters for crates that differ only by what is in them, and content
 * checks that counted `$` in the source text because the grid could not be
 * asked how many stall slots it had. What replaces it says the same things
 * directly, and `data/validate.ts` now asks the *built world* the questions the
 * character counting was standing in for.
 *
 * One grid, one collision system: the dining room is simply the western half of
 * the same rectangle, and the **patio ring** around the outside is everything
 * the room and its walls do not cover. Walkable, never placeable, and where the
 * market stall stands — the walk around the building being the honest price of
 * using it.
 */
export type Rect = { x: number; y: number; width: number; height: number };

/** A straight run of wall tiles, inclusive of both ends. */
export type WallRun = { from: Vec2; to: Vec2 };

/** Something the level stands on a tile before anybody has played a day. */
export type Placement = { kind: ApplianceKind; at: Vec2; source?: ItemSpec };

export type LevelDef = {
  /**
   * Stable identifier, and what a save is tied to.
   *
   * Saves used to be keyed by a hash of the level source, which meant any edit
   * at all — including realigning a comment — invalidated every save on every
   * server. Changing where a kitchen's walls are should invalidate saves;
   * touching the file should not.
   */
  id: string;
  name: string;
  /** Which biome from `data/biomes.ts` surrounds this kitchen. */
  biome: string;
  /** The whole grid, patio included. */
  size: { width: number; height: number };
  /** The building. Kitchen floor inside, walls around it, patio beyond. */
  room: Rect;
  /** The gap in the shell customers arrive through. */
  door: Vec2;
  /** Interior walls. The shell comes from `room`, and `door` is its one hole. */
  walls: WallRun[];
  appliances: Placement[];
  spawns: Vec2[];
  /** Length of the service phase in seconds. */
  dayLength: number;
  /**
   * How many plates this kitchen owns. They start clean, on the plate stack.
   *
   * This is the scarcity dial, and the only one: a kitchen that runs short of
   * plates should be one that has been *built* big — more tables than the wash
   * loop can keep up with — rather than one played badly on day one. Two spare
   * over the seat count is generous on purpose; `validate.ts` insists on at
   * least one per table so a level cannot ship unable to serve its own
   * dining room.
   */
  plates: number;
};

export const wall = (x1: number, y1: number, x2: number, y2: number): WallRun => ({
  from: { x: x1, y: y1 },
  to: { x: x2, y: y2 },
});

export const at = (kind: ApplianceKind, x: number, y: number): Placement => ({
  kind,
  at: { x, y },
});

/** `count` of a kind in a line, because a kitchen is mostly runs of things. */
export const run = (
  kind: ApplianceKind,
  x: number,
  y: number,
  count: number,
  axis: "x" | "y" = "x",
): Placement[] =>
  Array.from({ length: count }, (_, i) =>
    at(kind, axis === "x" ? x + i : x, axis === "y" ? y + i : y),
  );

export const crate = (base: string, x: number, y: number): Placement => ({
  kind: "crate",
  at: { x, y },
  source: { base, processes: [] },
});

/** Every wall in this level: the shell the room implies, then the interior ones. */
export function wallRuns(level: LevelDef): WallRun[] {
  const x0 = level.room.x - 1;
  const y0 = level.room.y - 1;
  const x1 = level.room.x + level.room.width;
  const y1 = level.room.y + level.room.height;
  return [
    wall(x0, y0, x1, y0),
    wall(x0, y1, x1, y1),
    wall(x0, y0, x0, y1),
    wall(x1, y0, x1, y1),
    ...level.walls,
  ];
}

/** The tiles a run covers. Diagonal runs are not a thing a wall can be. */
export function runTiles(line: WallRun): Vec2[] {
  const stepX = Math.sign(line.to.x - line.from.x);
  const stepY = Math.sign(line.to.y - line.from.y);
  const length = Math.max(Math.abs(line.to.x - line.from.x), Math.abs(line.to.y - line.from.y));
  return Array.from({ length: length + 1 }, (_, i) => ({
    x: line.from.x + stepX * i,
    y: line.from.y + stepY * i,
  }));
}

export const PARK_KITCHEN: LevelDef = {
  // `-2` because the patio ring moved every tile in the kitchen two columns
  // east and two rows south. A save from before it describes a kitchen whose
  // coordinates no longer mean the same thing.
  id: "park-kitchen-2",
  name: "Park Kitchen",
  biome: "park",
  dayLength: 150,
  // Two spare over the seat count, as ever — the rule survives the kitchen
  // getting smaller, which is the point of stating it as a rule.
  plates: 4,
  size: { width: 24, height: 13 },
  // Patio (x 0..1) | dining room (x 3..8) | dividing wall (x 9) | kitchen
  // (x 10..20) | patio again (x 22..23).
  room: { x: 3, y: 3, width: 18, height: 7 },
  door: { x: 2, y: 6 },
  // The divider, stopping either side of the walk-through gap at (9,5). What
  // fills the rest of it is two ordinary counters — see the pass, below.
  walls: [wall(9, 3, 9, 4), wall(9, 8, 9, 9)],
  //
  // The sink starts next to the plate stack, so washing up and putting away is
  // one move by default. Whether that is where it belongs — against the run to
  // the pass, and the walk back from the tables — is the build phase's problem,
  // and the point of it.
  //
  // One board and two tables is a **deliberately thin** kitchen: the stall on
  // the west apron is where the second of each comes from, and a shop nobody
  // needs to visit teaches nothing.
  //
  // **The level is a starting point, not an endpoint.** There is no fryer, no
  // oven, and no crate but tomato and lettuce, because a kitchen contains only
  // what its menu needs and the menu is one salad. Equipment enters this world
  // through the card stand, which delivers whatever a new recipe wants — so by
  // day ten no two rooms are the same restaurant.
  appliances: [
    // The patio furniture, which belongs to the place rather than to anybody's
    // build: the stall on the west apron, the card stand below it.
    ...run("stall", 0, 3, 3, "y"),
    ...run("cards", 0, 7, 2, "y"),
    // The sign hangs *in* the wall beside the door — an appliance on a wall
    // tile, which stays solid and part of the shell the renderer bakes.
    at("sign", 2, 5),
    // The back run: crates, then wash-up.
    crate("tomato", 10, 3),
    crate("lettuce", 11, 3),
    at("plates", 16, 3),
    at("sink", 17, 3),
    ...run("counter", 18, 3, 2),
    at("bin", 20, 3),
    // The island, and the worktop below it.
    at("counter", 11, 5),
    at("board", 12, 5),
    at("counter", 13, 5),
    ...run("counter", 11, 8, 3),
    // **The pass is a place, not an appliance**: two ordinary counters standing
    // in the dividing wall, which players can lift for a wide opening between
    // the rooms or fill in beside for a single narrow one.
    ...run("counter", 9, 6, 2, "y"),
    // The dining room.
    at("table", 4, 4),
    at("table", 4, 8),
  ],
  spawns: [
    { x: 12, y: 6 },
    { x: 15, y: 6 },
    { x: 18, y: 6 },
  ],
};

export const BEACH_SHACK: LevelDef = {
  id: "beach-shack-1",
  name: "Beach Shack",
  biome: "beach",
  dayLength: 150,
  plates: 4,
  size: { width: 20, height: 12 },
  // The park kitchen's opposite bargain: **a big deck and a small galley.**
  // Three tables standing in the open against six columns of kitchen, where the
  // park has two tables and eleven. Seats pull customers in, so this room is
  // busier from day one and has less floor to solve it with — the same dials
  // the shop hands a player, set differently before they arrive.
  //
  // Patio (x 0..1) | dining room (x 3..9) | dividing wall (x 10) | galley
  // (x 11..16) | patio again (x 18..19).
  room: { x: 3, y: 2, width: 14, height: 8 },
  door: { x: 2, y: 6 },
  // The divider, broken by the two pass counters and the gap at (10,5).
  walls: [wall(10, 2, 10, 2), wall(10, 4, 10, 4), wall(10, 6, 10, 6), wall(10, 8, 10, 9)],
  appliances: [
    ...run("stall", 0, 3, 3, "y"),
    ...run("cards", 0, 7, 2, "y"),
    at("sign", 2, 5),
    // The galley: crates and bin along the top, wash-up along the bottom.
    crate("tomato", 11, 2),
    crate("lettuce", 12, 2),
    ...run("counter", 13, 2, 3),
    at("bin", 16, 2),
    at("board", 13, 4),
    at("plates", 11, 9),
    at("sink", 12, 9),
    ...run("counter", 13, 9, 3),
    // The pass, either side of the gap.
    at("counter", 10, 3),
    at("counter", 10, 7),
    // Every table has four free sides on purpose: this is the room that seats
    // [parties](../../docs/dining-room.md), and a kitchen that cannot cook two
    // dishes at once is exactly the wrong kitchen to be handed one.
    at("table", 5, 3),
    at("table", 8, 5),
    at("table", 5, 7),
  ],
  spawns: [
    { x: 13, y: 5 },
    { x: 15, y: 5 },
    { x: 13, y: 7 },
  ],
};

/**
 * Every kitchen the game knows about, by id.
 *
 * The wire carries a level *id*, never the geometry: both ends compile the same
 * registry, so `welcome` naming a level is enough for a client to build the
 * right walls, door and biome. Sending the tiles instead would work too, and
 * would be worse — it would make every client's floor plan a thing a server
 * could get wrong.
 */
export const LEVELS: Record<string, LevelDef> = {
  [PARK_KITCHEN.id]: PARK_KITCHEN,
  [BEACH_SHACK.id]: BEACH_SHACK,
};

/** The level a room gets when nothing says otherwise. */
export const DEFAULT_LEVEL_ID = PARK_KITCHEN.id;

export function levelById(id: string): LevelDef | null {
  return LEVELS[id] ?? null;
}

/**
 * The one level, for the many callers that do not yet choose.
 *
 * Kept as a named export so this is a *default*, not an assumption baked into
 * twenty files. `Host` takes a level; this is only what the shell hands it.
 */
export const LEVEL: LevelDef = PARK_KITCHEN;
