import type { ApplianceKind, ItemSpec, Vec2 } from "../sim/types";

/**
 * Kitchens are authored as ASCII so layouts stay readable and diffable.
 *
 *   #  wall            =  counter        B  chopping board
 *   F  fryer           O  oven           P  plate stack
 *   X  bin             .  floor          T  table
 *   D  door            t/l/c/p  crates: tomato / lettuce / cheese / potato
 *   f/w                crates: flour / water
 *
 * One grid, one collision system: the dining room is simply the western half
 * of the same rectangle.
 *
 * The **pass** is not an appliance kind — it is two ordinary counters standing
 * in the dividing wall. It used to be its own thing back when food vanished
 * through it, and when that stopped being true the kind was left describing
 * nothing: a counter you could not chop on and could not move. What matters is
 * the *place*, not the object, and as counters those two tiles are something
 * players can have an opinion about: lift them for a wide opening between the
 * rooms, or fill the gap beside them for a single narrow one.
 */
export type LevelDef = {
  /**
   * Stable identifier, and what a save is tied to.
   *
   * Saves used to be keyed by a hash of the ASCII below, which meant any edit
   * at all — including realigning a comment — invalidated every save on every
   * server. Changing where a kitchen's walls are should invalidate saves;
   * touching the file should not. Those are different events and only one of
   * them deserves a new id.
   */
  id: string;
  name: string;
  /** Which biome from `data/biomes.ts` surrounds this kitchen. */
  biome: string;
  rows: string[];
  spawns: Vec2[];
  /** Length of the service phase in seconds. */
  dayLength: number;
};

export type TileSpec =
  | { kind: "floor" }
  | { kind: "wall" }
  /** Walkable floor, and where customers enter and leave from. */
  | { kind: "door" }
  | { kind: "appliance"; appliance: ApplianceKind; source?: ItemSpec };

const crate = (base: string): TileSpec => ({
  kind: "appliance",
  appliance: "crate",
  source: { base, processes: [] },
});

export const LEGEND: Record<string, TileSpec> = {
  ".": { kind: "floor" },
  "#": { kind: "wall" },
  "=": { kind: "appliance", appliance: "counter" },
  B: { kind: "appliance", appliance: "board" },
  F: { kind: "appliance", appliance: "fryer" },
  O: { kind: "appliance", appliance: "oven" },
  P: { kind: "appliance", appliance: "plates", source: { base: "plate", processes: [] } },
  X: { kind: "appliance", appliance: "bin" },
  T: { kind: "appliance", appliance: "table" },
  D: { kind: "door" },
  t: crate("tomato"),
  l: crate("lettuce"),
  c: crate("cheese"),
  f: crate("flour"),
  w: crate("water"),
  p: crate("potato"),
};

export const PARK_KITCHEN: LevelDef = {
  id: "park-kitchen",
  name: "Park Kitchen",
  biome: "park",
  dayLength: 150,
  // Dining room (x 0..6) | dividing wall, walk-through gap and pass (x 7) |
  // kitchen (x 8..19).
  rows: [
    "####################",
    "#......#tlcfwpP===X#",
    "#.T..T.#...........#",
    "#........=B=.......#",
    "D......=...........O",
    "#......=...........O",
    "#.T..T.#.=B=.......#",
    "#......#.......===F#",
    "####################",
  ],
  spawns: [
    { x: 10, y: 4 },
    { x: 13, y: 4 },
    { x: 16, y: 4 },
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
