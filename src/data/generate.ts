import { mulberry32 } from "../sim/random";
import type { Vec2 } from "../sim/types";
import { at, crate, rect, run, wall, type LevelDef, type Placement, type WallRun } from "./level";

/**
 * Kitchens that nobody drew.
 *
 * One template so far — the **split room**, which is the shape the park and the
 * beach already share: patio, dining room, a divider with a walk-through and a
 * pass in it, a galley, patio again. The seed moves the walls around inside
 * that shape; it does not invent shapes.
 *
 * The line between what is rolled and what is not is deliberate: **seed what a
 * player can see and change, freeze what sets the difficulty before they have
 * touched anything.** So table *placement* is rolled — free sides per table
 * decide which parties can be seated, and the build phase can undo it — while
 * the table *count* is not, because arrivals scale with free seats and the shop
 * is where that dial is supposed to live (see `docs/the-shop.md`). Likewise the
 * starting equipment: a kitchen begins with one salad and grows through recipe
 * cards, and a generator scattering ovens would be fighting a system that
 * already works.
 *
 * Every generated level is a `LevelDef` like any other, so `levelProblems` in
 * `data/validate.ts` is the specification this file is written against — and
 * `generate.test.ts` holds it to it over a few hundred seeds. Nothing here
 * retries on a bad roll: a constraint that only holds most of the time is a
 * bug, and a retry loop is how you never find out.
 */

/**
 * A seed from a room code, so the link that invites somebody *is* the kitchen.
 *
 * The hash in the URL is already the invitation; this makes it the floor plan
 * too, which means a room has a building before anybody has agreed on one and
 * two people typing the same code get the same restaurant.
 */
export function seedFromCode(code: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    hash = Math.imul(hash ^ code.charCodeAt(i), 0x01000193);
  }
  return hash | 0;
}

/** The building always sits this far in from the edge of the grid. */
const MARGIN = 2;

/** Frozen, and the note above says why. */
const TABLES = 2;
const PLATES = 4;
const DAY_LENGTH = 150;

/** Biomes a split room can stand in. The roadside belongs to a drive-through. */
const SETTINGS = [
  { biome: "park", name: "Park Kitchen" },
  { biome: "beach", name: "Beach Kitchen" },
] as const;

export function generateLevel(seed: number): LevelDef {
  const roll = roller(seed);
  const setting = roll.pick(SETTINGS);

  // The bargain the two hand-made levels are commented in terms of: a wide
  // deck and a narrow galley, or the other way round.
  const dining = roll.int(5, 7);
  const galley = roll.int(8, 11);
  const width = dining + galley;
  const height = roll.int(7, 9);

  const north = MARGIN;
  const south = MARGIN + height - 1;
  const east = MARGIN + width - 1;
  /** The divider's seam, and the galley's first column. */
  const split = MARGIN + dining;

  // Never a corner: the door has to pierce exactly one wall, and the posters
  // pasted either side of it have to stay on the same face of the building.
  const door = { x: MARGIN, y: roll.int(north + 1, south - 1) };
  // The sign hangs beside the door, on whichever side has a wall left.
  const sign = { x: MARGIN, y: door.y * 2 > north + south ? door.y - 1 : door.y + 1 };

  // Three holes in the divider: one to walk through, and one either side of it
  // with a counter standing in it. Lift a pass counter and the opening widens,
  // which is the whole point of building the pass out of ordinary counters.
  const reach = roll.int(1, 2);
  const gap = roll.int(north + reach, south - reach);
  const passes = [gap - reach, gap + reach];

  // The galley's two ends, three tiles each, at opposite ends of the run so
  // that prep and wash-up are a walk apart whichever way round they land.
  const washWest = roll.chance();
  const prep = washWest ? east - 2 : split + 1;
  const wash = washWest ? split + 1 : east - 2;

  // Free-standing, and clear of both side walls, so it can never seal a corner
  // of the galley off from the rest of it.
  //
  // Kept **at the prep end**, which is a measured rule rather than a taste:
  // gather-and-chop is the tightest loop in the game and it is walked for every
  // dish, and both hand-made kitchens sit their board two squares from the
  // crate run. Rolling its column across the whole galley instead put the worst
  // seeds ten squares away — a twenty-step round trip per tomato, on day one,
  // before a player has any money to fix it with.
  // Two or three rows under the back run, never adrift in the middle of the
  // floor. The row costs as much as the column does — a board rolled across the
  // galley's whole height is five rows from the crates in a tall kitchen — and
  // it leaves the middle of the galley as what it should be: the corridor.
  const islandRow = roll.int(north + 2, Math.min(south - 2, north + 3));
  const first = split + 2;
  const last = east - 3;
  const islandX = washWest
    ? roll.int(Math.max(first, last - 3), last)
    : roll.int(first, Math.min(last, first + 3));
  const worktopX = roll.int(split + 1, east - 3);

  const appliances: Placement[] = [
    // The morning's delivery and the posters, grouped around the door rather
    // than lined up along it — see the note on `stall` in `data/appliances.ts`.
    at("stall", MARGIN - 1, door.y - 2),
    at("stall", MARGIN - 2, door.y - 1),
    at("stall", MARGIN - 2, door.y + 1),
    at("cards", MARGIN - 1, door.y - 1),
    at("cards", MARGIN - 1, door.y + 1),
    at("sign", sign.x, sign.y),
    // The back run.
    crate("tomato", prep, north),
    crate("lettuce", prep + 1, north),
    at("counter", prep + 2, north),
    at("plates", wash, north),
    at("sink", wash + 1, north),
    at("bin", wash + 2, north),
    // The island, and the worktop against the far wall.
    at("counter", islandX, islandRow),
    at("board", islandX + 1, islandRow),
    at("counter", islandX + 2, islandRow),
    ...run("counter", worktopX, south, 3),
    // The pass: ordinary counters, standing in two of the divider's holes.
    ...passes.map((y) => at("counter", split, y)),
    // The dining side of the divider's three holes stays clear: a table in the
    // walk-through seals the kitchen off, and one in front of a pass counter
    // is a pass nobody can collect from.
    ...tables(roll, { x: MARGIN + 1, y: north + 1 }, { x: split - 1, y: south - 1 }, [
      gap,
      ...passes,
    ]),
  ];

  const level: Omit<LevelDef, "id"> = {
    name: setting.name,
    biome: setting.biome,
    dayLength: DAY_LENGTH,
    plates: PLATES,
    size: { width: width + MARGIN * 2, height: height + MARGIN * 2 },
    room: rect(MARGIN, MARGIN, width, height),
    paving: [rect(0, 0, width + MARGIN * 2, height + MARGIN * 2)],
    door,
    walls: divider(split, north, south, new Set([gap, ...passes])),
    appliances,
    spawns: spawns(appliances, split, east, north, south),
  };

  return { id: `gen-${fingerprint(level)}`, ...level };
}

/**
 * The divider, as the runs of seam left over between its holes.
 *
 * Authored as "everything except the openings" because the openings are the
 * decision: three holes in a wall is one fact, and the four wall runs around
 * them are four that would have to agree with it.
 */
function divider(x: number, north: number, south: number, open: Set<number>): WallRun[] {
  const runs: WallRun[] = [];
  for (let y = north; y <= south; y++) {
    if (open.has(y)) continue;
    const from = y;
    while (y + 1 <= south && !open.has(y + 1)) y++;
    runs.push(wall(x, from, x, y + 1));
  }
  return runs;
}

/**
 * Tables in the open, no two adjacent.
 *
 * The gap is what makes them worth rolling: a table with four free sides seats
 * a party of four and one shoved against its neighbour seats fewer, so spacing
 * is the dining room's capacity — see `docs/dining-room.md`. Kept off the shell
 * rows and out of the door's column for the same reason.
 */
function tables(roll: Roll, from: Vec2, to: Vec2, openings: number[]): Placement[] {
  const free: Vec2[] = [];
  for (let y = from.y; y <= to.y; y++) {
    for (let x = from.x; x <= to.x; x++) {
      if (x === to.x && openings.includes(y)) continue;
      free.push({ x, y });
    }
  }
  const placed: Placement[] = [];
  while (placed.length < TABLES && free.length > 0) {
    const spot = free[roll.int(0, free.length - 1)]!;
    placed.push(at("table", spot.x, spot.y));
    for (let i = free.length - 1; i >= 0; i--) {
      const other = free[i]!;
      if (Math.max(Math.abs(other.x - spot.x), Math.abs(other.y - spot.y)) <= 1) free.splice(i, 1);
    }
  }
  return placed;
}

/**
 * Three standing places in the galley, spread along whatever floor is left.
 *
 * Derived from the placements rather than rolled, because a spawn is the one
 * coordinate that has to agree with everything else in the room.
 */
function spawns(
  appliances: Placement[],
  split: number,
  east: number,
  y0: number,
  y1: number,
): Vec2[] {
  const taken = new Set(appliances.map((placement) => key(placement.at)));
  const free: Vec2[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = split; x <= east; x++) {
      if (!taken.has(key({ x, y }))) free.push({ x, y });
    }
  }
  return [0, 1, 2].map((i) => free[Math.floor(((i * 2 + 1) * free.length) / 6)]!);
}

const key = (tile: Vec2): string => `${tile.x},${tile.y}`;

/**
 * A short hash of the kitchen itself, which is what the id is.
 *
 * `park-kitchen-3` carries a number somebody has to remember to bump; this is
 * the same rule enforced instead of remembered — *changing where the walls are
 * invalidates saves, touching the file does not*. Two seeds that happen to
 * produce the same room get the same id, and should: it is the same kitchen,
 * and a save from one belongs in the other.
 */
function fingerprint(level: Omit<LevelDef, "id">): string {
  const text = JSON.stringify(level);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

type Roll = {
  /** Inclusive both ends. */
  int: (min: number, max: number) => number;
  pick: <T>(items: readonly T[]) => T;
  chance: () => boolean;
};

/**
 * The generator's own stream, never `random(world)`.
 *
 * Same rule the shop and the recipe cards follow: play consumes the world's
 * stream, so anything that must come out the same everywhere has to be drawn
 * from something that does not move.
 */
function roller(seed: number): Roll {
  const next = mulberry32(seed);
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    int,
    pick: <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!,
    chance: () => next() < 0.5,
  };
}
