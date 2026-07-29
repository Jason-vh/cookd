import { applianceDef } from "../data/appliances";
import { LEGEND, type LevelDef } from "../data/level";
import { STARTING_RECIPES } from "../data/progression";
import { plateCount, stockPlates } from "./plates";
import { nextRandom } from "./random";
import { restockStall } from "./shop";
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
  return { move: { x: 0, y: 0 }, grab: false, use: false, start: false, menu: false };
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

/** Solid tiles block player movement. */
export function isSolid(world: World, x: number, y: number): boolean {
  if (!inBounds(world, x, y)) return true;
  if (world.tiles[tileIndex(world, x, y)]?.wall) return true;
  return (world.applianceAt[tileIndex(world, x, y)] ?? 0) !== 0;
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

function makePlayer(id: number, name: string, spawn: Vec2): Player {
  const pos = { x: spawn.x + 0.5, y: spawn.y + 0.5 };
  return {
    id,
    name,
    away: false,
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
  return { day, earned: 0, tips: 0, served: 0, lost: {} };
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
  const height = level.rows.length;
  const width = Math.max(...level.rows.map((r) => r.length));

  const world: World = {
    tick: 0,
    nextId: 1,
    predicting: false,
    nextPlayerId: 0,
    rngState: seed,
    seed,
    width,
    height,
    tiles: Array.from({ length: width * height }, () => ({
      wall: false,
      door: false,
      placeable: true,
    })),
    applianceAt: Array.from({ length: width * height }, () => 0),
    appliances: new Map(),
    layoutVersion: 0,
    players: [],
    customers: [],
    door: { x: 0, y: Math.floor(height / 2) },
    phase: "build",
    day: 1,
    dayTime: 0,
    dayLength: level.dayLength,
    nextArrivalIn: 2,
    money: 0,
    served: 0,
    lost: 0,
    today: emptyLedger(1),
    // One dish, and it is the salad: every core verb, no burn risk, and a day
    // one that paces itself. Everything else is chosen from a card.
    unlocked: [...STARTING_RECIPES],
    unlockedDay: 0,
    events: [],
    effects: [],
  };

  for (let y = 0; y < height; y++) {
    const row = level.rows[y] ?? "";
    for (let x = 0; x < width; x++) {
      const ch = row[x] ?? ".";
      const spec = LEGEND[ch];
      if (!spec) throw new Error(`Unknown level char "${ch}" at ${x},${y}`);
      const idx = tileIndex(world, x, y);
      if (spec.kind === "wall") {
        world.tiles[idx] = { wall: true, door: false, placeable: false };
      } else if (spec.kind === "door") {
        world.tiles[idx] = { wall: false, door: true, placeable: true };
        world.door = { x, y };
      } else if (spec.kind === "patio") {
        world.tiles[idx] = { wall: false, door: false, placeable: false };
      } else if (spec.kind === "appliance") {
        // The stall stands on the patio, so its tile has to be unplaceable for
        // the same reason the paving around it is: nothing may be built there.
        // Read from the ASCII rather than inferred, so a stall inside a kitchen
        // would behave the same way.
        if (!applianceDef(spec.appliance).movable) {
          world.tiles[idx] = { wall: false, door: false, placeable: false };
        }
        spawnAppliance(world, spec.appliance, { x, y }, spec.source ?? null);
      }
    }
  }

  // The kitchen's plates, clean and on the stack. Everything after this moves
  // them around; the stall is the one place another can be made — see
  // `sim/plates.ts`.
  stockPlates(world, level.plates);
  restockStall(world);
  // No cards: a fresh world wakes on the morning of day one, and the first
  // stand is day two. A restored or reset world is handed a menu and a day it
  // did not start with, and restocks for itself — see `setUnlocked`.

  for (let i = 0; i < playerCount; i++) addPlayer(world, level);

  return world;
}

/**
 * Put a new appliance on the grid.
 *
 * The one place an appliance comes into existence, so building a kitchen from
 * ASCII, restoring one from a save and topping one up after a content update
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
    source,
    offer: null,
    taken: null,
    card: null,
    armedBy: null,
    armTime: 0,
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
 * Neither is the **patio**, for a plainer reason: it is not placeable at all,
 * so an oven whose owner disconnected can never end up standing in the park.
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
export function playerById(world: World, id: number): Player | undefined {
  return world.players.find((player) => player.id === id);
}

export function addPlayer(world: World, level: LevelDef, name = ""): Player {
  const spawn = level.spawns[world.players.length % level.spawns.length] ?? { x: 1, y: 1 };
  const player = makePlayer(world.nextPlayerId++, name, spawn);
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
export function adoptPlayer(world: World, id: number, name: string, at: Vec2): Player {
  const player = makePlayer(id, name, { x: at.x - 0.5, y: at.y - 0.5 });
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
  if (player.name) log(world, `${player.name} left`);
}

/** Put a held appliance back on the grid, at home or as close as possible. */
function returnAppliance(world: World, appliance: Appliance): void {
  const target = nearestFreeTile(world, appliance.tile);
  if (!target) return; // nowhere to put it; it simply ceases to be
  appliance.tile = { x: target.x, y: target.y };
  appliance.heldBy = null;
  world.applianceAt[tileIndex(world, target.x, target.y)] = appliance.id;
  touchLayout(world);
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
