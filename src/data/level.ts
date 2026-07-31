import type { ApplianceKind, ItemSpec, Vec2 } from "../sim/types";

/**
 * Kitchens are authored as ASCII so layouts stay readable and diffable.
 *
 *   #  wall            =  counter        B  chopping board
 *   F  fryer           O  oven           P  plate stack
 *   S  sink            X  bin            .  floor          T  table
 *   D  door            t/l/c/p  crates: tomato / lettuce / cheese / potato
 *   f/w                crates: flour / water
 *   ,  patio           $  market stall   ?  recipe card stand
 *   !  the sign        — hung in the wall beside the door; opens the day
 *
 * One grid, one collision system: the dining room is simply the western half
 * of the same rectangle, and the **patio ring** around the outside is more of
 * the same rectangle again.
 *
 * The ring is what makes "outside" a place rather than a painted backdrop. The
 * renderer has always drawn a paved patio under the kitchen; now the paving a
 * player can see, the tiles collision allows and the map the simulation
 * believes in are the same thing. It costs two columns and two rows, and it
 * buys the market stall a place to stand and the wall-embedded ovens a back
 * side to be reached from — the walk around the building being the honest
 * price of using it.
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

export type TileSpec =
  | { kind: "floor" }
  | { kind: "wall" }
  /** Walkable floor, and where customers enter and leave from. */
  | { kind: "door" }
  /** Walkable paving outside the walls. Nothing may be built on it. */
  | { kind: "patio" }
  | {
      kind: "appliance";
      appliance: ApplianceKind;
      source?: ItemSpec;
      /**
       * Standing *in* the wall rather than against it.
       *
       * The tile keeps every property a wall tile has — solid, unbuildable, and
       * drawn as part of the shell — and carries an appliance as well. Without
       * it the sign by the door would be a one-tile hole in the building that
       * happened to have a sign in it.
       */
      wall?: boolean;
    };

const crate = (base: string): TileSpec => ({
  kind: "appliance",
  appliance: "crate",
  source: { base, processes: [] },
});

export const LEGEND: Record<string, TileSpec> = {
  ".": { kind: "floor" },
  "#": { kind: "wall" },
  ",": { kind: "patio" },
  // The stall is furniture the *level* owns, like the walls: immovable, and
  // therefore never written to a save (see `snapshot`). Where the shop stands
  // is a property of the place, not of anybody's build.
  $: { kind: "appliance", appliance: "stall" },
  // Same deal, one apron along: where the menu grows is a property of the
  // place, not of anybody's build. Bare on most mornings — see `sim/cards.ts`.
  "?": { kind: "appliance", appliance: "cards" },
  // And the same again for the sign, which is how a day opens. It hangs in the
  // wall beside the door — the one wall tile every restaurant hangs one on, and
  // the one place a player is already looking when they think about opening.
  "!": { kind: "appliance", appliance: "sign", wall: true },
  "=": { kind: "appliance", appliance: "counter" },
  B: { kind: "appliance", appliance: "board" },
  F: { kind: "appliance", appliance: "fryer" },
  O: { kind: "appliance", appliance: "oven" },
  // No `source`: the plate stack does not conjure plates, it *holds* them —
  // see `sim/plates.ts`. What it has is what the kitchen owns.
  P: { kind: "appliance", appliance: "plates" },
  S: { kind: "appliance", appliance: "sink" },
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
  // `-2` because the patio ring moved every tile in the kitchen two columns
  // east and two rows south. A save from before it describes a kitchen whose
  // coordinates no longer mean the same thing, and there is no honest way to
  // shift them: the layout a player built was relative to walls that have
  // moved. A new id drops those files cleanly instead of loading them
  // misaligned — which is exactly what the id is for.
  id: "park-kitchen-2",
  name: "Park Kitchen",
  biome: "park",
  dayLength: 150,
  // Two spare over the seat count, as ever — the rule survives the kitchen
  // getting smaller, which is the point of stating it as a rule.
  plates: 4,
  // Patio (x 0..1) | dining room (x 3..8) | dividing wall, walk-through gap
  // and pass (x 9) | kitchen (x 10..20) | patio again (x 22..23).
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
  // through the card stand (`?`), which delivers whatever a new recipe wants —
  // so by day ten no two rooms are the same restaurant. Saves written against
  // the older, richer layout keep it: this describes what a *new* room gets.
  rows: [
    ",,,,,,,,,,,,,,,,,,,,,,,,",
    ",,,,,,,,,,,,,,,,,,,,,,,,",
    ",,####################,,",
    "$,#......#tl....PS==X#,,",
    "$,#.T....#...........#,,",
    "$,!........=B=.......#,,",
    ",,D......=...........#,,",
    "?,#......=...........#,,",
    "?,#.T....#.===.......#,,",
    ",,#......#...........#,,",
    ",,####################,,",
    ",,,,,,,,,,,,,,,,,,,,,,,,",
    ",,,,,,,,,,,,,,,,,,,,,,,,",
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
  // The park kitchen's opposite bargain: **a big deck and a small galley.**
  // Three tables standing in the open against six columns of kitchen, where the
  // park has two tables and eleven. Seats pull customers in, so this room is
  // busier from day one and has less floor to solve it with — the same dials
  // the shop hands a player, set differently before they arrive.
  //
  // Every table has four free sides on purpose: this is the room that seats
  // [parties](../../docs/dining-room.md), and a kitchen that cannot cook two
  // dishes at once is exactly the wrong kitchen to be handed one.
  //
  // Patio (x 0..1) | dining room (x 3..9) | dividing wall with a gap and two
  // pass counters (x 10) | galley (x 11..16) | patio again (x 18..19).
  rows: [
    ",,,,,,,,,,,,,,,,,,,,",
    ",,################,,",
    ",,#.......#tl===X#,,",
    "$,#..T....=......#,,",
    "$,#.......#..B...#,,",
    "$,!.....T........#,,",
    ",,D.......#......#,,",
    "?,#..T....=......#,,",
    "?,#.......#......#,,",
    ",,#.......#PS===.#,,",
    ",,################,,",
    ",,,,,,,,,,,,,,,,,,,,",
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
