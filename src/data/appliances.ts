import type { ApplianceKind, Station } from "../sim/types";

export type ApplianceDef = {
  kind: ApplianceKind;
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

export const APPLIANCES: Record<ApplianceKind, ApplianceDef> = {
  wall: { stations: [], speed: 1, kind: "wall", label: "Wall", color: 0x4a4a55, height: 1.15, acceptsItems: false, movable: false, price: 0 },
  counter: { stations: ["prep"], speed: 1, kind: "counter", label: "Counter", color: 0x9a7b58, height: 0.62, acceptsItems: true, movable: true, price: 15 },
  board: { stations: ["prep"], speed: 1.75, kind: "board", label: "Chopping board", color: 0xc9a06a, height: 0.66, acceptsItems: true, movable: true, price: 25 },
  fryer: { stations: ["fry"], speed: 1, kind: "fryer", label: "Fryer", color: 0x8e8e99, height: 0.72, acceptsItems: true, movable: true, price: 60 },
  oven: { stations: ["bake"], speed: 1, kind: "oven", label: "Oven", color: 0x6f7076, height: 0.9, acceptsItems: true, movable: true, price: 80 },
  crate: { stations: [], speed: 1, kind: "crate", label: "Crate", color: 0x7a5c3c, height: 0.7, acceptsItems: false, movable: true, price: 10 },
  plates: { stations: [], speed: 1, kind: "plates", label: "Plate stack", color: 0xbfc7cf, height: 0.7, acceptsItems: false, movable: true, price: 20 },
  // A table is an appliance like any other: it accepts a plate, so delivery is
  // the place verb players already know. Its price is what the build phase
  // charges for order capacity.
  table: { stations: [], speed: 1, kind: "table", label: "Table", color: 0xb08d63, height: 0.55, acceptsItems: true, movable: true, price: 30 },
  bin: { stations: [], speed: 1, kind: "bin", label: "Bin", color: 0x35363c, height: 0.7, acceptsItems: true, movable: true, price: 5 },
};

export function applianceDef(kind: ApplianceKind): ApplianceDef {
  return APPLIANCES[kind];
}
