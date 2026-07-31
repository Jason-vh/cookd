import type { ApplianceKind, ItemSpec, Lane, Rect, Seam, Vec2 } from "../sim/types";

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

/**
 * A straight run of wall along the **seams between tiles**, from one lattice
 * corner to another.
 *
 * Corner `(x,y)` is the top-left corner of tile `(x,y)`, so `wall(8, 2, 8, 4)`
 * is the line between columns 7 and 8 for the two tile rows 2 and 3 — the far
 * end names the corner the wall stops at, not the last tile it covers. Runs
 * meet end to end, which is why they are polylines rather than tile ranges: a
 * wall is a line on the floor plan, and this is how one is drawn.
 */
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
  /** The building. Kitchen floor inside, walls on its edges, patio beyond. */
  room: Rect;
  /**
   * The tile just inside the way in. The wall it stands against is the one with
   * the hole in it — see `doorSeam`.
   */
  door: Vec2;
  /** Interior walls. The shell comes from `room`, and `door` is its one hole. */
  walls: WallRun[];
  /**
   * The drive-through lane, for a kitchen that serves cars instead of tables.
   *
   * A level has a lane or it has a dining room; **the lane is what says which**,
   * so there is one fact rather than a `service` flag that has to agree with the
   * furniture. The hatch it leads to is wherever the `hatch` placement stands —
   * again one fact, and `createWorld` punches the gap in the shell beside it the
   * same way it punches the doorway.
   *
   * `null` for a kitchen with a dining room, which is most of them.
   */
  lane?: Lane;
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
  const { x, y, width, height } = level.room;
  return [
    wall(x, y, x + width, y),
    wall(x, y + height, x + width, y + height),
    wall(x, y, x, y + height),
    wall(x + width, y, x + width, y + height),
    ...level.walls,
  ];
}

/** The seams a run covers. Diagonal runs are not a thing a wall can be. */
export function runSeams(line: WallRun): Seam[] {
  const [x0, x1] = [Math.min(line.from.x, line.to.x), Math.max(line.from.x, line.to.x)];
  const [y0, y1] = [Math.min(line.from.y, line.to.y), Math.max(line.from.y, line.to.y)];
  if (x0 === x1) {
    return Array.from({ length: y1 - y0 }, (_, i) => ({
      axis: "vertical" as const,
      x: x0,
      y: y0 + i,
    }));
  }
  if (y0 === y1) {
    return Array.from({ length: x1 - x0 }, (_, i) => ({
      axis: "horizontal" as const,
      x: x0 + i,
      y: y0,
    }));
  }
  return [];
}

export const PARK_KITCHEN: LevelDef = {
  // `-3` because walls moved onto the seams between tiles, which gave the room
  // back the ring of squares its own shell used to stand on and moved every
  // tile in the kitchen one column west and one row north. A save from before
  // it describes a kitchen whose coordinates no longer mean the same thing, and
  // there is no honest way to shift them.
  id: "park-kitchen-3",
  name: "Park Kitchen",
  biome: "park",
  dayLength: 150,
  // Two spare over the seat count, as ever — the rule survives the kitchen
  // getting smaller, which is the point of stating it as a rule.
  plates: 4,
  size: { width: 22, height: 11 },
  // Patio (x 0..1) | dining room (x 2..7) | the divider, on the seam at x = 8 |
  // kitchen (x 8..19) | patio again (x 20..21).
  room: { x: 2, y: 2, width: 18, height: 7 },
  door: { x: 2, y: 5 },
  // The divider, stopping either side of the walk-through gap at row 4. What
  // fills the rest of it is two ordinary counters — see the pass, below.
  walls: [wall(8, 2, 8, 4), wall(8, 7, 8, 9)],
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
    ...run("stall", 0, 2, 3, "y"),
    ...run("cards", 0, 6, 2, "y"),
    // The sign hangs on the wall beside the door, on the first tile inside it,
    // so opening the day is somebody walking to the door. It has to be against
    // the shell and not in a corner — that is the wall it is screwed to, and
    // `validate.ts` refuses a sign with nothing behind it.
    at("sign", 2, 4),
    // The back run: crates, then wash-up.
    crate("tomato", 9, 2),
    crate("lettuce", 10, 2),
    at("plates", 15, 2),
    at("sink", 16, 2),
    ...run("counter", 17, 2, 2),
    at("bin", 19, 2),
    // The island, and the worktop below it.
    at("counter", 10, 4),
    at("board", 11, 4),
    at("counter", 12, 4),
    ...run("counter", 10, 7, 3),
    // **The pass is a place, not an appliance**: two ordinary counters standing
    // against the dividing wall, which players can lift for a wide opening
    // between the rooms or fill in beside for a single narrow one.
    ...run("counter", 8, 5, 2, "y"),
    // The dining room.
    at("table", 3, 3),
    at("table", 3, 7),
  ],
  spawns: [
    { x: 11, y: 5 },
    { x: 14, y: 5 },
    { x: 17, y: 5 },
  ],
};

export const BEACH_SHACK: LevelDef = {
  id: "beach-shack-2",
  name: "Beach Shack",
  biome: "beach",
  dayLength: 150,
  plates: 4,
  size: { width: 18, height: 10 },
  // The park kitchen's opposite bargain: **a big deck and a small galley.**
  // Three tables standing in the open against six columns of kitchen, where the
  // park has two tables and eleven. Seats pull customers in, so this room is
  // busier from day one and has less floor to solve it with — the same dials
  // the shop hands a player, set differently before they arrive.
  //
  // Patio (x 0..1) | dining room (x 2..8) | the divider, on the seam at x = 9 |
  // galley (x 9..15) | patio again (x 16..17).
  room: { x: 2, y: 1, width: 14, height: 8 },
  door: { x: 2, y: 5 },
  // The divider, in four pieces: the gap at row 4, and the two rows the pass
  // counters stand against.
  walls: [wall(9, 1, 9, 2), wall(9, 3, 9, 4), wall(9, 5, 9, 6), wall(9, 7, 9, 9)],
  appliances: [
    ...run("stall", 0, 2, 3, "y"),
    ...run("cards", 0, 6, 2, "y"),
    at("sign", 2, 4),
    // The galley: crates and bin along the top, wash-up along the bottom.
    crate("tomato", 10, 1),
    crate("lettuce", 11, 1),
    ...run("counter", 12, 1, 3),
    at("bin", 15, 1),
    at("board", 12, 3),
    at("plates", 10, 8),
    at("sink", 11, 8),
    ...run("counter", 12, 8, 3),
    // The pass, either side of the gap.
    at("counter", 9, 2),
    at("counter", 9, 6),
    // Every table has four free sides on purpose: this is the room that seats
    // [parties](../../docs/dining-room.md), and a kitchen that cannot cook two
    // dishes at once is exactly the wrong kitchen to be handed one.
    at("table", 4, 2),
    at("table", 7, 4),
    at("table", 4, 6),
  ],
  spawns: [
    { x: 12, y: 4 },
    { x: 14, y: 4 },
    { x: 12, y: 6 },
  ],
};

/**
 * The third kitchen, and the first that does not have a dining room.
 *
 * A **drive-through**: one hatch in the south wall, a lane of cars coming to
 * it, and no chair in the building. It exists because the two rooms above are
 * the same game with the furniture moved, and this one is a different job.
 *
 * Tables are **parallel** — a slow table costs you that table, and the others
 * carry on. A lane is **serial**: the car at the window is standing between
 * every car behind it and the road, so one order nobody can cook holds up all
 * of them. That pressure is the whole reason this room exists, and it is the
 * one thing a dining room cannot express. See
 * [the drive-through](../../docs/drive-through.md).
 *
 * The loop keeps its back half, in the one place there was room for it: the car
 * takes the *food* and the plate stays behind, dirty, in the hands that served
 * it. Every cover is a wash, immediately, and the kitchen owns four plates — so
 * the sink is what a table was, the thing you buy your way out of.
 *
 * A long galley on purpose. Nobody leaves the building during service, so the
 * walk that used to be to a table has to exist *inside* the room: the crates
 * and the wash-up are at opposite ends of it, and the hatch is in the middle of
 * the long wall where both are a run away.
 */
export const HIGHWAY_STOP: LevelDef = {
  id: "highway-stop-1",
  name: "Highway Stop",
  biome: "roadside",
  dayLength: 150,
  // Four, as everywhere — but they turn over faster here than in any dining
  // room, because a car hands one back dirty the moment it is served rather
  // than a quarter of an hour later.
  plates: 4,
  size: { width: 20, height: 10 },
  // Patio (x 0..1) | the galley (x 2..17) | patio again (x 18..19), with the
  // lane along the south apron at y = 8.
  room: { x: 2, y: 2, width: 16, height: 6 },
  door: { x: 2, y: 4 },
  // No dividing wall: there is nothing to divide. The shell is the whole of it.
  walls: [],
  // Cars come off the road at the east end and pull away at the west, so the
  // lane runs *past* the building rather than into it. Nobody reverses.
  lane: { entry: { x: 19, y: 8 }, exit: { x: 0, y: 8 } },
  appliances: [
    // The apron furniture, as every kitchen has it: the stall, the card stand,
    // and the sign on the wall inside the door.
    ...run("stall", 0, 2, 3, "y"),
    ...run("cards", 0, 6, 2, "y"),
    at("sign", 2, 5),
    // The back run: crates and prep at the west end, wash-up at the east.
    crate("tomato", 3, 2),
    crate("lettuce", 4, 2),
    at("counter", 5, 2),
    at("board", 6, 2),
    ...run("counter", 7, 2, 2),
    at("counter", 14, 2),
    at("plates", 15, 2),
    at("sink", 16, 2),
    at("bin", 17, 2),
    // The hatch, and the sill either side of it. A dish left *on* the hatch is
    // handed to whoever pulls up next, so one chef can load it ahead of the
    // car and two can split the window from the cooking entirely.
    at("counter", 9, 7),
    at("hatch", 10, 7),
    at("counter", 11, 7),
  ],
  spawns: [
    { x: 6, y: 5 },
    { x: 10, y: 4 },
    { x: 14, y: 5 },
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
  [HIGHWAY_STOP.id]: HIGHWAY_STOP,
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
