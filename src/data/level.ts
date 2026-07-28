import type { ApplianceKind, ItemSpec, Vec2 } from "../sim/types";

/**
 * Kitchens are authored as ASCII so layouts stay readable and diffable.
 *
 *   #  wall            =  counter        B  chopping board
 *   F  fryer           O  oven           P  plate stack
 *   S  pass            X  bin            .  floor
 *   T  table           D  door           t/l/c/p  crates: tomato / lettuce / cheese / potato
 *   f/w                crates: flour / water
 *
 * One grid, one collision system: the dining room is simply the western half
 * of the same rectangle. The pass (`S`) sits in the dividing wall, with a gap
 * beside it so a chef can walk round rather than only slide plates across.
 */
export type LevelDef = {
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
  S: { kind: "appliance", appliance: "serving" },
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

export const LEVEL: LevelDef = {
  name: "Park Kitchen",
  biome: "park",
  dayLength: 150,
  // Dining room (x 0..6) | pass and dividing wall (x 7) | kitchen (x 8..19).
  rows: [
    "####################",
    "#......#tlcfwpP===X#",
    "#.T..T.#...........#",
    "#........=B=.......#",
    "D......S...........O",
    "#......S...........O",
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
