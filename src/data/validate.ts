import { specKey } from "../sim/items";
import type { ItemSpec } from "../sim/types";
import { APPLIANCES, APPLIANCE_KINDS, isApplianceKind, type ApplianceKind } from "./appliances";
import { CUSTOMER_KINDS, DEFAULT_CUSTOMER_KIND } from "./customers";
import { STALL_SLOTS, STOCK_WEIGHT } from "./economy";
import { INGREDIENTS, PROCESSES } from "./ingredients";
import { BIOMES, type DaylightKey } from "./biomes";
import { LEVELS, runSeams, type LevelDef } from "./level";
import type { Rect, Vec2, World } from "../sim/types";
import { hatchOf, servingSpot } from "../sim/lane";
import { reachableFrom, seatsAround } from "../sim/pathing";
import { canReach } from "../sim/walls";
import { createWorld, isSolid, tileIndex } from "../sim/world";
import { BACKFILL_RECIPES, STARTING_RECIPES, TIER_WEIGHT } from "./progression";
import { COMBINES, RAW_INGREDIENTS, RECIPES, RECIPE_NEEDS, TRANSFORMS } from "./recipes";

/**
 * Is the content coherent?
 *
 * The four lookup indexes in `recipes.ts` are built with bare `Map.set`, so a
 * duplicated transform, a duplicated combine pair or two recipes sharing a dish
 * silently overwrite each other. A typo in a `base` is quieter still: the
 * content simply becomes unreachable, or it throws out of `ingredient()` at
 * render time, several minutes into a game, in a stack trace that says nothing
 * about the row that caused it.
 *
 * None of that is a *code* bug and none of it would be caught by types, because
 * `IngredientId` is a string. So it is checked here instead, once, and the
 * failure lands at startup pointing at the row.
 *
 * Run in development and in tests. Not in production: the content is compiled
 * in, so if it was valid when the bundle was built it is valid now, and a
 * player is not the right person to tell about it.
 */
export function validateContent(): string[] {
  const problems: string[] = [];

  const spec = (where: string, item: ItemSpec): void => {
    if (!Object.hasOwn(INGREDIENTS, item.base)) {
      problems.push(`${where}: unknown ingredient "${item.base}"`);
    }
    for (const process of item.processes) {
      if (!Object.hasOwn(PROCESSES, process)) {
        problems.push(`${where}: unknown process "${process}"`);
      }
    }
  };

  // --- transforms: one per station+input, or the later one wins silently ---
  const byInput = new Set<string>();
  for (const transform of TRANSFORMS) {
    const where = `transform ${specKey(transform.input)} -> ${specKey(transform.output)}`;
    spec(where, transform.input);
    spec(where, transform.output);
    const key = `${transform.station}|${specKey(transform.input)}`;
    if (byInput.has(key)) problems.push(`${where}: a second transform for ${key}`);
    byInput.add(key);
    if (transform.duration <= 0) problems.push(`${where}: duration must be positive`);
    if (transform.mode === "auto" && !transform.motion) {
      problems.push(`${where}: an unattended transform needs a motion to advertise itself`);
    }
    // An appliance has to exist that can actually do this work, or the content
    // is unreachable in a way no player could diagnose.
    const stations = Object.values(APPLIANCES).flatMap((def) => def.stations);
    if (!stations.includes(transform.station)) {
      problems.push(`${where}: no appliance provides the "${transform.station}" station`);
    }
  }

  // --- combines: the pair key is unordered, so a+b and b+a are one rule ---
  const byPair = new Set<string>();
  for (const combine of COMBINES) {
    const where = `combine ${specKey(combine.a)} + ${specKey(combine.b)}`;
    spec(where, combine.a);
    spec(where, combine.b);
    spec(where, combine.output);
    const [x, y] = [specKey(combine.a), specKey(combine.b)].sort();
    const key = `${x}+${y}`;
    if (byPair.has(key)) problems.push(`${where}: a second combine for the same pair`);
    byPair.add(key);
  }

  // --- recipes ---
  const byId = new Set<string>();
  const byDish = new Set<string>();
  for (const recipe of RECIPES) {
    const where = `recipe "${recipe.id}"`;
    spec(where, recipe.dish);
    if (byId.has(recipe.id)) problems.push(`${where}: duplicate id`);
    byId.add(recipe.id);
    // Two recipes wanting the same plate is not a bug the sim can resolve: it
    // looks a dish up by spec to decide what was ordered.
    const dish = specKey(recipe.dish);
    if (byDish.has(dish)) problems.push(`${where}: another recipe already wants ${dish}`);
    byDish.add(dish);
    if (recipe.steps.length === 0) problems.push(`${where}: no steps`);
    // The card outside carries no words at all, so this is the only sentence
    // anybody reads about the dish. A recipe that ships without one has a
    // card with a hole in it and nothing that says so.
    if (recipe.blurb.trim() === "") problems.push(`${where}: no blurb`);
    if (recipe.patience <= 0) problems.push(`${where}: patience must be positive`);
    // A tier the posters have no weight for would be offered at weight 1 by
    // the fallback, which is a silent tuning decision nobody made.
    if (!Object.hasOwn(TIER_WEIGHT, recipe.tier)) {
      problems.push(`${where}: tier ${recipe.tier} has no weight in TIER_WEIGHT`);
    }
    // A card has to be able to *say* what it needs. An empty requirement set
    // means nothing in the content produces this dish from raw ingredients.
    const needs = RECIPE_NEEDS.get(recipe.id);
    if (!needs || needs.bases.length === 0) {
      problems.push(`${where}: no route from raw ingredients to ${specKey(recipe.dish)}`);
    }
  }
  for (const recipe of RECIPES) {
    if (recipe.prereq === undefined) continue;
    const where = `recipe "${recipe.id}"`;
    const prereq = RECIPES.find((other) => other.id === recipe.prereq);
    // A prerequisite that does not exist is a recipe the stand can never offer:
    // `offerable` asks whether it is unlocked, and nothing can unlock it.
    if (!prereq) problems.push(`${where}: unknown prereq "${recipe.prereq}"`);
    else if (prereq.id === recipe.id) problems.push(`${where}: is its own prereq`);
    else if (prereq.prereq === recipe.id) problems.push(`${where}: prereq cycle with ${prereq.id}`);
  }
  // Somebody has to be able to order on day one, and a room has to be able to
  // come back from a pre-card save with a menu.
  for (const [what, ids] of [
    ["STARTING_RECIPES", STARTING_RECIPES],
    ["BACKFILL_RECIPES", BACKFILL_RECIPES],
  ] as const) {
    if (ids.length === 0) problems.push(`${what} is empty`);
    for (const id of ids) {
      if (!byId.has(id)) problems.push(`${what}: no such recipe "${id}"`);
    }
  }

  // --- who walks in ---
  // Every dial multiplies a number the dining room already has, so zero is
  // never a tuning value: a patience of 0 is somebody who walks out on the tick
  // they order, and an appetite of 0 is a table that is never occupied.
  const kindIds = new Set<string>();
  for (const kind of CUSTOMER_KINDS) {
    const where = `customer "${kind.id}"`;
    if (kindIds.has(kind.id)) problems.push(`${where}: duplicate id`);
    kindIds.add(kind.id);
    if (kind.weight <= 0) problems.push(`${where}: weight must be positive`);
    for (const [dial, value] of Object.entries({
      patience: kind.patience,
      appetite: kind.appetite,
      generosity: kind.generosity,
      pace: kind.pace,
      build: kind.build,
    })) {
      if (value <= 0) problems.push(`${where}: ${dial} must be positive`);
    }
    // A kind with no coat cannot be dressed, and `buildCustomer` indexes into
    // the list without asking.
    if (kind.coats.length === 0) problems.push(`${where}: no coat to wear`);
  }
  // The fallback for an id we do not know — an older client, a newer server —
  // has to be somebody. Without it `customerKind` returns whatever row happens
  // to be first, which is a silent tuning decision nobody made.
  if (!kindIds.has(DEFAULT_CUSTOMER_KIND)) {
    problems.push(`no customer kind "${DEFAULT_CUSTOMER_KIND}" for unknown ids to fall back to`);
  }

  // --- the shop ---
  // A crate is sold with an ingredient in it, drawn from what the recipes
  // actually start from. An empty pool would mean a crate of nothing.
  if (STOCK_WEIGHT.crate > 0 && RAW_INGREDIENTS.length === 0) {
    problems.push("the stall sells crates, but no recipe starts from a raw ingredient");
  }
  for (const kind of APPLIANCE_KINDS) {
    // A sale hands over a *held* appliance, so anything immovable is unsellable
    // by construction — the buyer would be given something they cannot carry.
    if (STOCK_WEIGHT[kind] > 0 && !APPLIANCES[kind].movable) {
      problems.push(`stall: "${kind}" is for sale but cannot be picked up`);
    }
  }

  // --- fittings ---
  // A fitting is set on a worktop and never on the floor, so it has to be
  // carryable and it must not be somewhere another fitting could be stacked.
  // The second is what stops a board on a board: `fitTopper` asks the host for
  // its worktop, and a fitting that had one would swallow the next board whole.
  for (const kind of APPLIANCE_KINDS) {
    const def = APPLIANCES[kind];
    if (!def.fitting) continue;
    if (!def.movable) problems.push(`appliance "${kind}": a fitting nobody can lift`);
    if (def.worktop) problems.push(`appliance "${kind}": a fitting that fittings go on`);
    if (def.mounted) problems.push(`appliance "${kind}": both fitted and wall-mounted`);
  }

  // --- upgrades ---
  // The `upgrades` column is a `string`, because the union it names is derived
  // from the table it sits in. These three checks are what the type would have
  // said: it points at a real kind, it does the same job, and it costs more.
  // Without the last one a card would deliver the upgrade instead of the plain
  // appliance, since delivery picks the cheapest kind that offers the station.
  for (const kind of APPLIANCE_KINDS) {
    const def = APPLIANCES[kind];
    if (def.upgrades === null) continue;
    const base = isApplianceKind(def.upgrades) ? APPLIANCES[def.upgrades] : null;
    if (!base) {
      problems.push(`appliance "${kind}": upgrades unknown kind "${def.upgrades}"`);
      continue;
    }
    if (!base.stations.some((station) => def.stations.includes(station))) {
      problems.push(`appliance "${kind}": upgrades "${def.upgrades}", which does another job`);
    }
    if (def.price <= base.price) {
      problems.push(`appliance "${kind}": costs no more than the "${def.upgrades}" it improves on`);
    }
    if (def.speed < base.speed || def.patience < base.patience) {
      problems.push(`appliance "${kind}": is worse than the "${def.upgrades}" it improves on`);
    }
  }

  // --- can each dish actually be made? ---
  const makeable = new Set<string>();
  for (const transform of TRANSFORMS) makeable.add(specKey(transform.output));
  for (const combine of COMBINES) makeable.add(specKey(combine.output));
  for (const ingredientId of Object.keys(INGREDIENTS)) makeable.add(`${ingredientId}|`);
  for (const recipe of RECIPES) {
    if (!makeable.has(specKey(recipe.dish))) {
      problems.push(`recipe "${recipe.id}": nothing produces ${specKey(recipe.dish)}`);
    }
  }

  // --- biomes: a day runs one way, from opening to closing ---
  for (const [id, biome] of Object.entries(BIOMES)) {
    const where = `biome "${id}"`;
    if (biome.id !== id) problems.push(`${where}: registered under a different id`);
    if (biome.daylight.length === 0) problems.push(`${where}: has no daylight keys`);
    problems.push(...daylightProblems(where, biome.daylight));
  }

  // --- levels ---
  for (const [id, level] of Object.entries(LEVELS)) {
    if (level.id !== id) problems.push(`level "${id}": registered under a different id`);
    if (!Object.hasOwn(BIOMES, level.biome)) {
      problems.push(`level "${id}": unknown biome "${level.biome}"`);
    }
    problems.push(...levelProblems(level));
  }

  return problems;
}

/**
 * What is wrong with a biome's day.
 *
 * Keys are crossfaded, which makes two of these silent rather than wrong-
 * looking: keys out of order sample the wrong pair, and an azimuth that turns
 * back on itself swings every shadow in the kitchen the other way at noon. The
 * elevation floor is the shadow map's: a texel is smeared across the ground by
 * `1 / sin(elevation)`, so at 10 degrees one covers six times what it does
 * overhead and the edge of a shadow visibly steps.
 */
function daylightProblems(where: string, keys: readonly DaylightKey[]): string[] {
  const problems: string[] = [];
  const azimuths = keys.map((key) => key.sun.azimuth);
  const oneWay =
    azimuths.every((a, i) => i === 0 || a < azimuths[i - 1]!) ||
    azimuths.every((a, i) => i === 0 || a > azimuths[i - 1]!);
  if (!oneWay) problems.push(`${where}: the sun doubles back — azimuth must move one way`);

  keys.forEach((key, i) => {
    const at = `${where}, key at ${key.at}`;
    if (key.at < 0 || key.at > 1) problems.push(`${at}: outside the service day`);
    if (i > 0 && key.at <= keys[i - 1]!.at) problems.push(`${at}: out of order`);
    if (key.sun.elevation < MIN_SUN_ELEVATION) {
      problems.push(`${at}: sun below ${MIN_SUN_ELEVATION} degrees, so its shadows clip`);
    }
  });
  return problems;
}

/** How low the sun may hang before its shadows start to step. */
const MIN_SUN_ELEVATION = 15;

/**
 * What is wrong with a level, asked of the world it builds.
 *
 * These checks used to search the level's ASCII — `rows.join("").split("$")` to
 * count stall slots, `rows.some(row => row.includes("T"))` for a table. That
 * was a picture being interrogated about its contents, and it could only ever
 * ask about characters. A level is a list of placements now, so the questions
 * can be asked of the kitchen those placements actually produce.
 *
 * Exported for its own test: these are the checks that replaced *looking at the
 * picture*, so they are worth pointing at a broken level to prove they fire.
 */
export function levelProblems(level: LevelDef): string[] {
  const problems: string[] = [];
  const say = (text: string): number => problems.push(`level "${level.id}": ${text}`);

  if (level.spawns.length === 0) say("no spawn points");
  if (level.dayLength <= 0) say("dayLength must be positive");

  // Geometry first, because everything below stands on it and `createWorld`
  // writes tiles by index: a room hanging off the edge of the grid would be a
  // building with pieces missing rather than an error.
  const { room, size } = level;
  if (room.width <= 0 || room.height <= 0) say("a room with no floor in it");
  // A tile of paving outside the walls, at least: everybody who comes in walks
  // round the building to do it, and a shop nobody can walk to is no shop.
  if (room.x < 1 || room.y < 1) say("no patio between the building and the grid's edge");
  if (room.x + room.width + 1 > size.width || room.y + room.height + 1 > size.height) {
    say("no patio between the building and the grid's edge");
  }
  // Paving is what makes a square somewhere to stand, so paving off the grid is
  // a place the game believes in and nobody can reach — and `createWorld`
  // stamps tiles by index, so it would be written into somebody else's row.
  const grid: Rect = { x: 0, y: 0, ...size };
  for (const area of level.paving) {
    if (area.width <= 0 || area.height <= 0) say("a paved area with no ground in it");
    else if (
      !within(grid, area.x, area.y) ||
      !within(grid, area.x + area.width - 1, area.y + area.height - 1)
    ) {
      say(`paving off the grid at ${area.x},${area.y}`);
    }
  }
  for (const line of level.walls) {
    if (line.from.x !== line.to.x && line.from.y !== line.to.y) say("a diagonal wall");
    else if (line.from.x === line.to.x && line.from.y === line.to.y) say("a wall of no length");
    // A seam sits on the room's lattice, which is one wider than the room in
    // the direction it cuts across: eighteen columns of floor have nineteen
    // lines to hang a north-south wall on, and the outermost two are the shell.
    for (const seam of runSeams(line)) {
      const lattice = seam.axis === "vertical" ? grow(room, 1, 0) : grow(room, 0, 1);
      if (!within(lattice, seam.x, seam.y)) {
        say(`a wall outside the building at ${seam.x},${seam.y}`);
      }
    }
  }
  // Standing against exactly one wall of the shell. A corner touches two and
  // answers neither, which is the case `edgeSeam` cannot decide — so it is the
  // case that is refused here, once, for everything that asks it.
  const againstShell = (tile: Vec2): boolean =>
    within(room, tile.x, tile.y) &&
    (tile.x === room.x || tile.x === room.x + room.width - 1) !==
      (tile.y === room.y || tile.y === room.y + room.height - 1);

  // The door is the tile behind the hole in the shell, so it has to be against
  // the shell: one tile in and there is no wall for it to pierce, one tile out
  // and it is a square of patio with the dining room sealed off behind it.
  if (!againstShell(level.door)) {
    say("the door is not against the building's wall, so no customer can ever arrive");
  }

  // The sign hangs on that wall from the inside, so it needs one to hang
  // on. Two things depend on it: `inward` decides which way the sign faces from
  // the seam it stands against, and `addWalls` leaves that seam at full
  // height so the board is never screwed to a wall the camera has cut away.
  for (const placement of level.appliances) {
    if (placement.kind === "sign" && !againstShell(placement.at)) {
      say(`a sign at ${placement.at.x},${placement.at.y} with no wall to hang on`);
    }
  }

  const seen = new Set<string>();
  for (const placement of level.appliances) {
    const { x, y } = placement.at;
    const key = `${x},${y}`;
    // Two appliances on one tile leaves the second in the map (so drawn, and
    // sent in every layout message) but not on the grid — a solid-looking oven
    // players walk straight through.
    if (seen.has(key)) say(`two appliances on ${key}`);
    seen.add(key);
    if (x < 0 || y < 0 || x >= size.width || y >= size.height) say(`${key} is off the grid`);
    // Movable things belong indoors. Immovable ones are furniture of the place
    // — the stall in the market, the sign in the wall — and place themselves.
    else if (APPLIANCES[placement.kind].movable && !within(room, x, y)) {
      say(`a ${placement.kind} outside the building at ${key}`);
    }
    // A level stands things on tiles, and a fitting has no tile: `createWorld`
    // would put a chopping board on the floor, which is a state nothing else in
    // the game can produce and nothing knows how to draw.
    if (APPLIANCES[placement.kind].fitting) {
      say(`a ${placement.kind} at ${key} — a fitting goes on a counter, not on a tile`);
    }
  }

  // The coordinates have to make sense before the kitchen they describe can be
  // asked anything. `createWorld` writes tiles by index, so a room hanging off
  // the grid scribbles past the end of the array rather than failing, and every
  // count below would be noise around the real problem.
  if (problems.length > 0) return problems;

  const world = createWorld(level, 0);
  const count = (kind: ApplianceKind): number =>
    [...world.appliances.values()].filter((appliance) => appliance.kind === kind).length;

  for (const spawn of level.spawns) {
    if (isSolid(world, spawn.x, spawn.y))
      say(`a chef spawns inside something at ${spawn.x},${spawn.y}`);
  }

  // Everything the level stands down has to be walked up to. The shop is why
  // this is checked rather than assumed: the goods stand on squares of ordinary
  // paving now, and a level is free to put one of those squares somewhere that
  // has been walled off or boxed in by its own furniture. A delivery nobody can
  // reach is money nobody can spend — in silence.
  const reachable = reachableFrom(world, level.door);
  for (const appliance of world.appliances.values()) {
    const { x, y } = appliance.tile;
    // Something on a wall is reached by standing under it, so the question for
    // a poster is whether its own square can be got to.
    const found = APPLIANCES[appliance.kind].mounted
      ? reachable.has(tileIndex(world, x, y))
      : seatsAround(world, appliance.tile).some((tile) =>
          reachable.has(tileIndex(world, tile.x, tile.y)),
        );
    if (!found) say(`nobody can walk up to the ${appliance.kind} at ${x},${y}`);
  }

  // A kitchen serves people at tables or cars at a hatch, and which one it is
  // is the lane. Both halves are checked: a lane with no hatch is a queue for
  // nothing, and a hatch with no lane is a hole in the wall.
  if (level.lane) {
    for (const problem of laneProblems(level, world)) say(problem);
  } else if (count("hatch") > 0) {
    say("a hatch but no lane, so no car can ever come to it");
  } else if (count("table") === 0) {
    say("no table, so no customer can ever sit");
  }
  // Plates are finite and conserved, so the two appliances the plate economy
  // runs on are not optional scenery: without a stack there is nowhere for the
  // kitchen's plates to start, and without a sink the first six dirty ones end
  // the run.
  if (count("plates") === 0) say("no plate stack, so no plates");
  if (count("sink") === 0) say("no sink, so a dirty plate can never be used again");
  if (level.plates < count("table")) {
    say(`${level.plates} plates for ${count("table")} tables`);
  }
  // A drive-through turns its crockery over faster than any dining room: the
  // plate comes back dirty as the car pulls away, so one is a kitchen that
  // stops between every cover to wash it.
  if (level.lane && level.plates < 2) say(`${level.plates} plate(s) for a drive-through`);
  // The stall is how a kitchen grows, and a kitchen that cannot grow is one
  // where money has nothing to be for. The count matters as much as the
  // presence: `STALL_SLOTS` is what the stock roll fills, so a level with two
  // stall tiles would silently be a two-slot shop that every tuning note in
  // `data/economy.ts` describes wrongly.
  if (count("stall") !== STALL_SLOTS) {
    say(`${count("stall")} stall slots, expected ${STALL_SLOTS}`);
  }
  // The sign is the only way into service, so a kitchen without one can never
  // open — the most complete failure a level can ship. Exactly one: two signs
  // is two answers to "is the restaurant open".
  if (count("sign") !== 1) {
    say(`${count("sign")} signs, expected exactly 1 — no way to open the day`);
  }

  return problems;
}

/**
 * What is wrong with a drive-through's lane.
 *
 * Three things have to be true for a queue of cars to be arithmetic rather than
 * pathfinding, which is what `sim/lane.ts` is built on: there is exactly one
 * hatch, the tile outside it is on the lane, and the lane is **straight**. A
 * bent lane would put a car through a wall on the way to the window, and it
 * would do it silently — nothing else in the game would notice.
 */
function laneProblems(level: LevelDef, world: World): string[] {
  const problems: string[] = [];
  const lane = level.lane!;
  const hatches = level.appliances.filter((placement) => placement.kind === "hatch");
  if (hatches.length !== 1) {
    problems.push(`${hatches.length} hatches, expected exactly 1 — a lane leads to one window`);
    return problems;
  }

  const straight = lane.entry.x === lane.exit.x || lane.entry.y === lane.exit.y;
  if (!straight) problems.push("a lane that bends, so a car cannot drive it");

  const spot = servingSpot(world);
  if (!spot) {
    problems.push("a hatch that does not stand against the building's wall");
    return problems;
  }
  const onLane =
    lane.entry.y === lane.exit.y
      ? spot.y === lane.entry.y &&
        spot.x > Math.min(lane.entry.x, lane.exit.x) &&
        spot.x < Math.max(lane.entry.x, lane.exit.x)
      : spot.x === lane.entry.x &&
        spot.y > Math.min(lane.entry.y, lane.exit.y) &&
        spot.y < Math.max(lane.entry.y, lane.exit.y);
  if (straight && !onLane) problems.push("the hatch is not on the lane, so no car reaches it");

  // The car has to be able to hand a plate back through the wall it pulled up
  // to — which is the whole reason `createWorld` punches a gap beside a hatch.
  const hatch = hatchOf(world);
  if (hatch && !canReach(world, spot, hatch.tile)) {
    problems.push("the wall is closed between the hatch and the lane");
  }
  for (const end of [lane.entry, lane.exit]) {
    if (within(level.room, end.x, end.y)) problems.push(`the lane runs inside the building`);
    else if (isSolid(world, end.x, end.y)) problems.push(`something stands in the lane`);
  }
  return problems;
}

function within(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

/** A rectangle a little wider and taller, for asking about the lattice. */
function grow(rect: Rect, byX: number, byY: number): Rect {
  return { ...rect, width: rect.width + byX, height: rect.height + byY };
}

/** Throw if the content is incoherent. Called at startup in development. */
export function assertContentValid(): void {
  const problems = validateContent();
  if (problems.length === 0) return;
  throw new Error(`cookd content is invalid:\n  - ${problems.join("\n  - ")}`);
}
