import { LEGEND, type LevelDef } from "../data/level";
import { nextRandom } from "./random";
import type { Appliance, EffectCue, Player, PlayerInput, Vec2, World } from "./types";

export const TILE = 1;
/** Player collision radius, in tiles. */
export const PLAYER_RADIUS = 0.32;
/** Tiles per second. */
export const PLAYER_SPEED = 4.2;

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
        const appliance: Appliance = {
          id: world.nextId++,
          kind: spec.appliance,
          tile: { x, y },
          item: null,
          progress: 0,
          overcook: 0,
          justFinished: false,
          motion: null,
          source: spec.source ?? null,
          heldBy: null,
          tip: 0,
        };
        world.appliances.set(appliance.id, appliance);
        world.applianceAt[idx] = appliance.id;
      }
    }
  }

  for (let i = 0; i < playerCount; i++) addPlayer(world, level);

  return world;
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
  for (const appliance of world.appliances.values()) {
    if (appliance.heldBy === id) appliance.heldBy = null;
  }
  world.players.splice(index, 1);
  if (player.name) log(world, `${player.name} left`);
}

/** Put a held appliance back on the grid, at home or as close as possible. */
function returnAppliance(world: World, appliance: Appliance): void {
  const free = (x: number, y: number): boolean =>
    inBounds(world, x, y) &&
    !world.tiles[tileIndex(world, x, y)]?.wall &&
    (world.applianceAt[tileIndex(world, x, y)] ?? 0) === 0;

  let target = appliance.tile;
  if (!free(target.x, target.y)) {
    let best = Infinity;
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        if (!free(x, y)) continue;
        const distance = (x - target.x) ** 2 + (y - target.y) ** 2;
        if (distance < best) {
          best = distance;
          target = { x, y };
        }
      }
    }
    if (best === Infinity) return; // nowhere to put it; it simply ceases to be
  }
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
