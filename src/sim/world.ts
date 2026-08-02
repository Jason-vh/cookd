import { applianceDef, type ApplianceDef } from "../data/appliances";
import { chefHat, pickOutfit, DEFAULT_APPEARANCE, type Appearance } from "../data/chefs";
import { runSeams, wallRuns, type LevelDef } from "../data/level";
import { STARTING_RECIPES, cardFee } from "../data/progression";
import { RECIPE_BY_ID } from "../data/recipes";
import { plateCount, stockPlates } from "./plates";
import { nextRandom } from "./random";
import { restockStall } from "./shop";
import { createWalls, edgeSeam, openSeam, setHorizontalWall, setVerticalWall } from "./walls";
import { setWeather } from "./weather";
import { FAIR } from "../data/weather";
import type {
  Appliance,
  ApplianceKind,
  EffectCue,
  ItemSpec,
  Ledger,
  Player,
  PlayerInput,
  Vec2,
  World,
} from "./types";

export const TILE = 1;
/** Player collision radius, in tiles. */
export const PLAYER_RADIUS = 0.32;
/** Tiles per second. */
export const PLAYER_SPEED = 4.2;
/** Tiles per second. Slower than a chef: they are on their day off. */
export const CUSTOMER_SPEED = 2.4;

export function emptyInput(): PlayerInput {
  return {
    move: { x: 0, y: 0 },
    grab: false,
    use: false,
    rotate: false,
    start: false,
    menu: false,
  };
}

/**
 * Nothing held, nothing pressed — a chef standing still.
 *
 * Movement is compared against exactly zero rather than a threshold because the
 * input layer has already applied its stick deadzone by the time an input gets
 * here, so a resting controller reports a true zero.
 */
export function isIdleInput(input: PlayerInput): boolean {
  return (
    input.move.x === 0 &&
    input.move.y === 0 &&
    !input.grab &&
    !input.use &&
    !input.rotate &&
    !input.start &&
    !input.menu
  );
}

export function tileIndex(world: World, x: number, y: number): number {
  return y * world.width + x;
}

export function inBounds(world: World, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < world.width && y < world.height;
}

export function applianceAtTile(world: World, x: number, y: number): Appliance | null {
  if (!inBounds(world, x, y)) return null;
  const id = world.applianceAt[tileIndex(world, x, y)] ?? 0;
  return id === 0 ? null : (world.appliances.get(id) ?? null);
}

/**
 * Is this square occupied?
 *
 * Two things fill a square: something standing on it, and the ground itself
 * being scenery. The grass between the patio and the market is as solid as an
 * oven and for a plainer reason — it is not floor, and the level never said it
 * was. Everything in bounds used to be somewhere to stand, back when the grid
 * was the building plus its apron and nothing else.
 *
 * Walls used to occupy squares as well, and the difference is the whole of the
 * change that put them on the seams between tiles: a wall is not something a
 * tile *is*, so it cannot be answered for one. Whether a wall stands in the way
 * is a question about a **step** — see `sim/walls.ts`.
 *
 * And not even every appliance: one that hangs on the wall is standing on the
 * wall's line rather than on the square, so the square is floor. Owning a tile
 * and filling it came apart the moment the first thing was screwed to a wall.
 */
export function isSolid(world: World, x: number, y: number): boolean {
  if (!inBounds(world, x, y)) return true;
  if (!world.tiles[tileIndex(world, x, y)]?.walkable) return true;
  const appliance = applianceAtTile(world, x, y);
  return appliance !== null && !applianceDef(appliance.kind).mounted;
}

/**
 * Is this square outside the building?
 *
 * Asked of the **room**, not of a list of terrace rectangles, because that is
 * the fact the dining room actually cares about: a table is outdoors when it is
 * not indoors, whichever paving it happens to be standing on. It is also the
 * only definition that keeps working when somebody carries a table out through
 * the door and puts it down on the apron — which they cannot, today, and which
 * is exactly the sort of thing this game says yes to eventually.
 */
export function outdoors(world: World, tile: Vec2): boolean {
  const { x, y, width, height } = world.room;
  return tile.x < x || tile.y < y || tile.x >= x + width || tile.y >= y + height;
}

/** What hangs on the wall here, over floor anybody may walk on. */
export function mountedAt(world: World, x: number, y: number): Appliance | null {
  const appliance = applianceAtTile(world, x, y);
  return appliance && applianceDef(appliance.kind).mounted ? appliance : null;
}

/**
 * How this appliance works, with whatever is fitted to it taken into account.
 *
 * A counter with a board on it prepares at the board's speed and offers the
 * board's stations, so **every rule about work asks this rather than
 * `applianceDef(kind)`** — the transform search, the burn time, the shop's idea
 * of what a room can cook. Asking the kind directly is how a fitted board would
 * silently stop doing anything.
 *
 * The fitting wins outright rather than being merged in. A fitting is a
 * *worktop*, and a worktop that also inherited its host's stations would be a
 * board that fries because somebody set it on a fryer — which nothing allows,
 * but which the type would not have stopped.
 */
export function fittedDef(appliance: Appliance): ApplianceDef {
  return applianceDef(appliance.topper ?? appliance.kind);
}

/** Is this a thing that is set on a worktop rather than stood on the floor? */
export function isFitting(kind: ApplianceKind): boolean {
  return applianceDef(kind).fitting;
}

/**
 * The compass point a direction is nearest to.
 *
 * A chef's facing is a stick or a pair of keys, so it is diagonal about as
 * often as not; a conveyor runs one of four ways. Snapping here rather than
 * refusing a diagonal means every placement lays a belt, and the one it lays is
 * the one the ghost was already drawing.
 */
export function cardinal(dir: Vec2): Vec2 {
  if (Math.abs(dir.x) > Math.abs(dir.y)) return { x: Math.sign(dir.x), y: 0 };
  // Ties and a dead stick both go north-south, which is where a chef starts
  // facing: a belt must never come out of this with no direction at all.
  return { x: 0, y: dir.y < 0 ? -1 : 1 };
}

/**
 * Record that the appliance layout changed.
 *
 * Called by everything that moves an appliance on or off the grid. The server
 * compares this against what it last broadcast, so forgetting it means a player
 * moves an oven and nobody else ever sees it.
 */
export function touchLayout(world: World): void {
  world.layoutVersion++;
}

/**
 * The simulation's random number, drawn from the world's own stream.
 *
 * State lives on the `World` so that a save, a replay and a network snapshot
 * all carry it. The generator itself is shared with the render layer's scenery
 * scattering — see `sim/random.ts`.
 */
export function random(world: World): number {
  const next = nextRandom(world.rngState);
  world.rngState = next.state;
  return next.value;
}

function makePlayer(id: number, name: string, spawn: Vec2, look: Appearance): Player {
  const pos = { x: spawn.x + 0.5, y: spawn.y + 0.5 };
  return {
    id,
    name,
    away: false,
    outfit: look.outfit,
    hat: look.hat,
    pos,
    prevPos: { ...pos },
    facing: { x: 0, y: 1 },
    carried: null,
    carriedAppliance: null,
    workingOn: null,
    prev: emptyInput(),
  };
}

/** A day's takings, before any of it has happened. */
export function emptyLedger(day: number): Ledger {
  return { day, earned: 0, tips: 0, served: 0, lost: {}, rent: 0 };
}

/**
 * Build a world from a level.
 *
 * It wakes in the **build phase**, on the morning of day one. A fresh room and
 * a loaded one both do, and service starts only when somebody opens the day.
 * The save already discards everything mid-day, so this makes the resume point
 * honest rather than dropping players into a service they did not ask for — and
 * it gives the morning somewhere to be: the room gathers, reads the stall,
 * moves a counter, and *then* opens.
 */
export function createWorld(level: LevelDef, playerCount: number, seed = 1): World {
  const { width, height } = level.size;

  const world: World = {
    tick: 0,
    nextId: 1,
    predicting: false,
    nextPlayerId: 0,
    rngState: seed,
    seed,
    width,
    height,
    // Scenery until the level says otherwise. What is paved is a place — the
    // tiles collision allows and the slabs a player can see are the same list
    // — and what is not is the park it stands in.
    tiles: Array.from({ length: width * height }, () => ({
      door: false,
      walkable: false,
      placeable: false,
    })),
    room: { ...level.room },
    paving: level.paving.map((area) => ({ ...area })),
    walls: createWalls(width, height),
    applianceAt: Array.from({ length: width * height }, () => 0),
    appliances: new Map(),
    layoutVersion: 0,
    players: [],
    customers: [],
    door: { x: level.door.x, y: level.door.y },
    lane: level.lane ? { entry: { ...level.lane.entry }, exit: { ...level.lane.exit } } : null,
    // Overwritten by `setWeather` below, once the day is on the world to roll
    // against. Fair rather than empty so a half-built world is never a world
    // with a weather nothing can look up.
    weather: FAIR.id,
    phase: "build",
    pausedBy: null,
    pausedName: "",
    day: 1,
    dayTime: 0,
    dayLength: level.dayLength,
    nextArrivalIn: 2,
    money: 0,
    served: 0,
    lost: 0,
    today: emptyLedger(1),
    evicted: false,
    // The first life of this kitchen, with nothing taken and nothing to beat.
    // A record arrives from the save, or from the run that ends before it.
    run: 1,
    takings: 0,
    best: null,
    // One dish, and it is the salad: every core verb, no burn risk, and a day
    // one that paces itself. Everything else is chosen from a card.
    unlocked: [...STARTING_RECIPES],
    unlockedDay: 0,
    events: [],
    effects: [],
  };

  buildRoom(world, level);
  for (const placement of level.appliances) {
    const tile = world.tiles[tileIndex(world, placement.at.x, placement.at.y)];
    // An immovable appliance owns the tile it stands on: nothing may be built
    // there, for the same reason nothing may be built on the paving around the
    // stall.
    if (tile && !applianceDef(placement.kind).movable) tile.placeable = false;
    // A hatch is a counter standing in a hole in the wall, so the hole is part
    // of putting it there. Punched from the placement rather than named by the
    // level, for the same reason the doorway is punched from the door tile:
    // one fact about where the hatch is, not two that have to agree.
    if (placement.kind === "hatch") openSeam(world, edgeSeam(level.room, placement.at));
    spawnAppliance(world, placement.kind, placement.at, placement.source ?? null);
  }

  // The kitchen's plates, clean and on the stack. Everything after this moves
  // them around; the stall is the one place another can be made — see
  // `sim/plates.ts`.
  stockPlates(world, level.plates);
  restockStall(world);
  // The same event as the delivery, and rolled from the same two numbers: what
  // was decided about today before anybody woke up.
  setWeather(world);
  // No cards: a fresh world wakes on the morning of day one, and the first
  // stand is day two. A restored or reset world is handed a menu and a day it
  // did not start with, and restocks for itself — see `setUnlocked`.

  for (let i = 0; i < playerCount; i++) addPlayer(world, level);

  return world;
}

/**
 * Stamp the level's geometry: floor inside the room, walls around and through
 * it, and the one hole customers arrive by.
 *
 * The doorway is taken out last on purpose. It interrupts the shell, and
 * authoring the shell in two pieces around it would be two facts that have to
 * agree; this way there is one, and the hole is punched afterwards. A hatch
 * makes its own hole the same way, as it is placed.
 */
function buildRoom(world: World, level: LevelDef): void {
  // The terrace, over the paving and under the floor: paved ground a kitchen is
  // also allowed to build on. One field's difference from the apron beside it,
  // which is the whole of what outdoor seating needed — see `Tile.placeable`.
  const terrace = (x: number, y: number): boolean =>
    (level.terrace ?? []).some(
      (area) => x >= area.x && y >= area.y && x < area.x + area.width && y < area.y + area.height,
    );
  // Paving first, floor over the top of it: a paved rectangle is allowed to
  // cover the building it wraps (the beach's deck does), and the floor inside
  // the walls is the more specific fact about those squares.
  for (const area of level.paving) {
    for (let y = area.y; y < area.y + area.height; y++) {
      for (let x = area.x; x < area.x + area.width; x++) {
        if (!inBounds(world, x, y)) continue;
        world.tiles[tileIndex(world, x, y)] = {
          door: false,
          walkable: true,
          placeable: terrace(x, y),
        };
      }
    }
  }
  for (let y = level.room.y; y < level.room.y + level.room.height; y++) {
    for (let x = level.room.x; x < level.room.x + level.room.width; x++) {
      world.tiles[tileIndex(world, x, y)] = { door: false, walkable: true, placeable: true };
    }
  }
  for (const line of wallRuns(level)) {
    for (const seam of runSeams(line)) {
      if (seam.axis === "vertical") setVerticalWall(world, seam.x, seam.y, true);
      else setHorizontalWall(world, seam.x, seam.y, true);
    }
  }
  openSeam(world, edgeSeam(level.room, level.door));
  world.tiles[tileIndex(world, level.door.x, level.door.y)] = {
    door: true,
    walkable: true,
    placeable: true,
  };
}

/**
 * Put a new appliance on the grid.
 *
 * The one place an appliance comes into existence, so building a kitchen from
 * a level, restoring one from a save and topping one up after a content update
 * cannot drift into three subtly different `Appliance` literals.
 */
export function spawnAppliance(
  world: World,
  kind: ApplianceKind,
  tile: Vec2,
  source: ItemSpec | null = null,
  /**
   * Born straight into somebody's hands, for an appliance bought at the stall.
   *
   * It must **not** reach the grid on the way: `tile` is only where it would go
   * home to if the buyer disconnected, and writing it there would overwrite
   * whatever is standing on that tile — the stall itself, in the one case this
   * exists for. An appliance that has never been put down is exactly a held
   * one, and this is how it starts that way.
   */
  heldBy: number | null = null,
): Appliance {
  const appliance: Appliance = {
    id: world.nextId++,
    kind,
    tile: { x: tile.x, y: tile.y },
    item: null,
    progress: 0,
    overcook: 0,
    justFinished: false,
    motion: null,
    topper: null,
    // Whichever way the level is drawn. Only a conveyor reads it, and one is
    // only ever born held — it is pointed when it is put down.
    dir: { x: 0, y: 1 },
    source,
    offer: null,
    taken: null,
    card: null,
    heldBy,
    tip: 0,
  };
  world.appliances.set(appliance.id, appliance);
  if (heldBy === null) world.applianceAt[tileIndex(world, tile.x, tile.y)] = appliance.id;
  return appliance;
}

/**
 * Somewhere the game may put an appliance without asking anybody.
 *
 * The **door is not free**, even though it is walkable and empty: an appliance
 * standing in it seals the dining room off from every customer in the park.
 * That is a thing a *player* is allowed to do to their own kitchen — the build
 * phase warns them and `canPlace` permits it — but it is not a thing the game
 * gets to do on their behalf while nobody is watching.
 *
 * The **patio** is not free either, for a plainer reason: it is not placeable,
 * so an oven whose owner disconnected cannot end up standing in the park. The
 * *terrace* is, and that is correct rather than an oversight — it is floor the
 * kitchen owns, and the nearest free tile to a galley is never out on it unless
 * the building is already full.
 */
export function isFreeTile(world: World, x: number, y: number): boolean {
  if (!inBounds(world, x, y)) return false;
  const tile = world.tiles[tileIndex(world, x, y)];
  if (!tile?.placeable || tile.door) return false;
  return (world.applianceAt[tileIndex(world, x, y)] ?? 0) === 0;
}

/**
 * The free tile closest to `from`, or null if the kitchen is completely full.
 *
 * Shared by everything that has an appliance and a preference about where it
 * goes but no right to insist: a disconnected player's oven going home, and a
 * save being given back an appliance it predates.
 */
export function nearestFreeTile(world: World, from: Vec2): Vec2 | null {
  if (isFreeTile(world, from.x, from.y)) return { x: from.x, y: from.y };
  let best = Infinity;
  let found: Vec2 | null = null;
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      if (!isFreeTile(world, x, y)) continue;
      const distance = (x - from.x) ** 2 + (y - from.y) ** 2;
      if (distance < best) {
        best = distance;
        found = { x, y };
      }
    }
  }
  return found;
}

/**
 * Find a player by id.
 *
 * Always use this rather than `world.players[id]`. Ids stopped being positions
 * in the array the moment players could leave, and the two only look
 * interchangeable until someone in the middle disconnects — at which point
 * indexing silently returns the wrong chef, or nobody.
 */
/**
 * The nearest appliance a fitting could be set on, or null when every worktop
 * in the kitchen is taken.
 *
 * `nearestFreeTile`'s twin, and used by the same callers for the same reason:
 * something has to happen to a board whose owner disconnected, and dropping it
 * on the floor is not one of the states a board has.
 */
export function nearestWorktop(world: World, from: Vec2): Appliance | null {
  let best = Infinity;
  let found: Appliance | null = null;
  for (const appliance of world.appliances.values()) {
    if (!applianceDef(appliance.kind).worktop) continue;
    if (appliance.topper !== null || appliance.heldBy !== null) continue;
    const distance = (appliance.tile.x - from.x) ** 2 + (appliance.tile.y - from.y) ** 2;
    if (distance < best) {
      best = distance;
      found = appliance;
    }
  }
  return found;
}

export function playerById(world: World, id: number): Player | undefined {
  return world.players.find((player) => player.id === id);
}

/**
 * Add a player, dressed in what they asked for as far as the room allows.
 *
 * The outfit is settled here rather than taken on trust, because this is the
 * one place that can see who else is standing in the kitchen — and four chefs
 * sharing a sofa share one saved preference. See `pickOutfit`.
 */
export function addPlayer(
  world: World,
  level: LevelDef,
  name = "",
  look: Appearance = DEFAULT_APPEARANCE,
): Player {
  const spawn = level.spawns[world.players.length % level.spawns.length] ?? { x: 1, y: 1 };
  const player = makePlayer(world.nextPlayerId++, name, spawn, {
    outfit: pickOutfit(
      look.outfit,
      world.players.map((other) => other.outfit),
    ),
    hat: chefHat(look.hat).id,
  });
  world.players.push(player);
  return player;
}

/**
 * Add a player whose id and position we already know.
 *
 * For rebuilding a roster from a server snapshot, where a spawn point is not
 * just unnecessary but misleading: `applyFrame` used to call `addPlayer` with
 * the module-level `LEVEL`, picking a spawn from whichever level the *client*
 * was compiled with, and then overwrite it two lines later. Harmless, and
 * exactly the sort of stale assumption the level registry exists to remove —
 * on any second level it would have been reading the wrong table.
 */
export function adoptPlayer(
  world: World,
  id: number,
  name: string,
  at: Vec2,
  look: Appearance = DEFAULT_APPEARANCE,
): Player {
  // Taken as given, not resolved: whoever is running the room has already
  // decided who is wearing what, and a client with a second opinion would draw
  // a chef nobody else can see.
  const player = makePlayer(id, name, { x: at.x - 0.5, y: at.y - 0.5 }, look);
  world.players.push(player);
  world.nextPlayerId = Math.max(world.nextPlayerId, id + 1);
  return player;
}

/**
 * Remove a player and everything they were holding onto.
 *
 * Food they carried is destroyed rather than dropped: there is no such thing as
 * an item on the floor, and a chef vanishing while leaving a pizza hovering in
 * mid-air is a worse bug than losing an ingredient.
 *
 * A **plate** is not food. Ingredients are infinite and plates are not, so a
 * dropped connection taking the last two plates out of the kitchen would be a
 * room nobody can fix. They go back on the stack, washed — the same tidying-up
 * the end of a day does.
 *
 * An appliance is different — it has a home. It goes back to the tile it was
 * lifted from, or the nearest free tile if someone has since filled it. Losing
 * an oven because a player's wifi dropped would be unrecoverable.
 */
export function removePlayer(world: World, id: number): void {
  const index = world.players.findIndex((player) => player.id === id);
  if (index === -1) return;
  const player = world.players[index]!;

  if (player.carriedAppliance !== null) {
    const appliance = world.appliances.get(player.carriedAppliance);
    if (appliance) returnAppliance(world, appliance);
  }
  stockPlates(world, plateCount(player.carried));
  for (const appliance of world.appliances.values()) {
    if (appliance.heldBy === id) appliance.heldBy = null;
  }
  world.players.splice(index, 1);
  // A room may not be left paused by somebody who is no longer in it. The menu
  // that holds the pause is on their screen, and their screen has gone.
  if (world.pausedBy === id) resume(world);
  if (player.name) log(world, `${player.name} left`);
}

/**
 * Put a held appliance back on the grid, at home or as close as possible.
 *
 * A **fitting** has no grid to go back to, so it goes back onto a worktop — the
 * nearest bare one, which is the same "somewhere the game may put it without
 * asking" rule the tile search is. A kitchen with every counter already fitted
 * has nowhere to put it and it ceases to be, exactly as an appliance does in a
 * kitchen with no free floor.
 */
function returnAppliance(world: World, appliance: Appliance): void {
  // A card has no home to go back to — it is spent where it is put down, and
  // nobody is left to put it down. So it goes back to the pallet in the only
  // form that survives its owner: the money, which the pallet would still have
  // handed back all morning. Refunding beats guessing which dish they meant to
  // add to everybody else's menu.
  if (appliance.kind === "cards") {
    const recipe = appliance.card === null ? null : RECIPE_BY_ID.get(appliance.card);
    world.appliances.delete(appliance.id);
    if (!recipe) return;
    world.money += cardFee(recipe.tier);
    log(world, `The ${recipe.name} card went back  +$${cardFee(recipe.tier)}`);
    return;
  }
  if (applianceDef(appliance.kind).fitting) {
    const host = nearestWorktop(world, appliance.tile);
    world.appliances.delete(appliance.id);
    if (!host) return;
    host.topper = appliance.kind;
    touchLayout(world);
    return;
  }
  const target = nearestFreeTile(world, appliance.tile);
  if (!target) return; // nowhere to put it; it simply ceases to be
  appliance.tile = { x: target.x, y: target.y };
  appliance.heldBy = null;
  world.applianceAt[tileIndex(world, target.x, target.y)] = appliance.id;
  touchLayout(world);
}

/**
 * Hold the whole kitchen still while somebody has the menu open.
 *
 * Set here rather than in the shell because a pause is a fact about the room:
 * `step` reads it, everybody's screen draws it, and online it has to survive
 * the trip. See `World.pausedBy`.
 */
export function pause(world: World, id: number, name: string): void {
  if (world.pausedBy !== null) return; // first one in holds it
  world.pausedBy = id;
  world.pausedName = name || "Chef";
}

/**
 * Let the kitchen run again.
 *
 * Only whoever paused it may, or a second player opening and closing their own
 * menu would start the room up underneath the person still reading theirs.
 * `by` is omitted for a release the *game* is doing — somebody left, or their
 * connection dropped — which is what keeps a pause from outliving its owner and
 * stranding a room nobody can restart.
 *
 * A pause held by a seat that is no longer here is cleared by anybody, as a
 * backstop: the only thing worse than the wrong player resuming is a kitchen
 * that cannot be.
 */
export function resume(world: World, by?: number): void {
  if (by !== undefined && world.pausedBy !== by && playerById(world, world.pausedBy ?? -1)) return;
  world.pausedBy = null;
  world.pausedName = "";
}

/**
 * Queue a one-shot cue for the render layer. The sim never knows what it looks
 * like — only that it happened, where, and to whom.
 */
export function effect(world: World, cue: EffectCue): void {
  // A guess does not get to announce itself; see `World.predicting`.
  if (world.predicting) return;
  world.effects.push({ ...cue, id: world.nextId++, ttl: 1 });
  if (world.effects.length > 32) world.effects.shift();
}

export function log(world: World, text: string): void {
  if (world.predicting) return;
  world.events.push({ text, ttl: 3 });
  if (world.events.length > 6) world.events.shift();
}
