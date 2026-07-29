import { LEGEND, type LevelDef } from "../data/level";
import { plateCount, stockPlates } from "./plates";
import { nextRandom } from "./random";
import type {
  Appliance,
  ApplianceKind,
  EffectCue,
  ItemSpec,
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

export function createWorld(level: LevelDef, playerCount: number, seed = 1): World {
  const height = level.rows.length;
  const width = Math.max(...level.rows.map((r) => r.length));

  const world: World = {
    tick: 0,
    nextId: 1,
    nextPlayerId: 0,
    rngState: seed,
    width,
    height,
    tiles: Array.from({ length: width * height }, () => ({ wall: false, door: false })),
    applianceAt: Array.from({ length: width * height }, () => 0),
    appliances: new Map(),
    layoutVersion: 0,
    players: [],
    customers: [],
    door: { x: 0, y: Math.floor(height / 2) },
    phase: "service",
    day: 1,
    dayTime: level.dayLength,
    dayLength: level.dayLength,
    nextArrivalIn: 2,
    money: 0,
    served: 0,
    lost: 0,
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
        world.tiles[idx] = { wall: true, door: false };
      } else if (spec.kind === "door") {
        world.tiles[idx] = { wall: false, door: true };
        world.door = { x, y };
      } else if (spec.kind === "appliance") {
        spawnAppliance(world, spec.appliance, { x, y }, spec.source ?? null);
      }
    }
  }

  // The kitchen's plates, clean and on the stack. Everything after this moves
  // them around; nothing creates or destroys one — see `sim/plates.ts`.
  stockPlates(world, level.plates);

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
    heldBy: null,
    tip: 0,
  };
  world.appliances.set(appliance.id, appliance);
  world.applianceAt[tileIndex(world, tile.x, tile.y)] = appliance.id;
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
 */
export function isFreeTile(world: World, x: number, y: number): boolean {
  if (!inBounds(world, x, y)) return false;
  const tile = world.tiles[tileIndex(world, x, y)];
  if (tile?.wall || tile?.door) return false;
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
  world.effects.push({ ...cue, id: world.nextId++, ttl: 1 });
  if (world.effects.length > 32) world.effects.shift();
}

export function log(world: World, text: string): void {
  world.events.push({ text, ttl: 3 });
  if (world.events.length > 6) world.events.shift();
}
