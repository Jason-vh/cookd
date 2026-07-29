import type { Station } from "../sim/types";

export type ApplianceDef = {
  label: string;
  color: number;
  /** Visual height in tiles. */
  height: number;
  /** Can a player put an item down on it? */
  acceptsItems: boolean;
  /** Which kinds of work this appliance can perform. */
  stations: Station[];
  /** Work-rate multiplier. A dedicated station beats improvising on a counter. */
  speed: number;
  /** Can a player pick the appliance itself up during the build phase? */
  movable: boolean;
  /** Cost to buy in a future shop phase; also its resale/limit value. */
  price: number;
};

// A table, read down its columns — see the note on TRANSFORMS in recipes.ts.
// prettier-ignore
const DEFS = {
  wall: { stations: [], speed: 1, label: "Wall", color: 0x4a4a55, height: 1.15, acceptsItems: false, movable: false, price: 0 },
  counter: { stations: ["prep"], speed: 1, label: "Counter", color: 0x9a7b58, height: 0.62, acceptsItems: true, movable: true, price: 15 },
  board: { stations: ["prep"], speed: 1.75, label: "Chopping board", color: 0xc9a06a, height: 0.66, acceptsItems: true, movable: true, price: 25 },
  fryer: { stations: ["fry"], speed: 1, label: "Fryer", color: 0x8e8e99, height: 0.72, acceptsItems: true, movable: true, price: 60 },
  oven: { stations: ["bake"], speed: 1, label: "Oven", color: 0x6f7076, height: 0.9, acceptsItems: true, movable: true, price: 80 },
  crate: { stations: [], speed: 1, label: "Crate", color: 0x7a5c3c, height: 0.7, acceptsItems: false, movable: true, price: 10 },
  plates: { stations: [], speed: 1, label: "Plate stack", color: 0xbfc7cf, height: 0.7, acceptsItems: false, movable: true, price: 20 },
  // A table is an appliance like any other: it accepts a plate, so delivery is
  // the place verb players already know. Its price is what the build phase
  // charges for order capacity.
  table: { stations: [], speed: 1, label: "Table", color: 0xb08d63, height: 0.55, acceptsItems: true, movable: true, price: 30 },
  bin: { stations: [], speed: 1, label: "Bin", color: 0x35363c, height: 0.7, acceptsItems: true, movable: true, price: 5 },
} as const satisfies Record<string, ApplianceDef>;

/**
 * Every kind of appliance there is, derived from the table above.
 *
 * The union used to be hand-written in `sim/types.ts`, with this record
 * annotated `Record<ApplianceKind, ApplianceDef>` to match — so adding a sink,
 * which is pure content, meant editing the simulation's type layer. Deriving it
 * the other way round makes a new appliance one row, and keeps `applianceDef`
 * exhaustive for free.
 *
 * `satisfies` rather than an annotation: it checks every row against
 * `ApplianceDef` *without* widening the keys back to `string`, which is the
 * whole trick.
 */
export type ApplianceKind = keyof typeof DEFS;

export const APPLIANCES: Record<ApplianceKind, ApplianceDef> = DEFS;

export function applianceDef(kind: ApplianceKind): ApplianceDef {
  return APPLIANCES[kind];
}
