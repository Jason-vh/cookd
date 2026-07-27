import type { ApplianceKind, ItemSpec, Vec2 } from "../sim/types";

/**
 * Kitchens are authored as ASCII so layouts stay readable and diffable.
 *
 *   #  wall            =  counter        B  chopping board
 *   F  fryer           O  oven           P  plate stack
 *   S  serving hatch   X  bin            .  floor
 *   t/l/c/p            crates: tomato / lettuce / cheese / potato
 *   f/w                crates: flour / water
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
  rows: [
    "#############",
    "#tlcfwpP===X#",
    "#...........#",
    "#.=B=.......#",
    "S...........O",
    "S...........O",
    "#.=B=.......#",
    "#.......===F#",
    "#############",
  ],
  spawns: [
    { x: 3, y: 4 },
    { x: 6, y: 4 },
    { x: 9, y: 4 },
  ],
};
