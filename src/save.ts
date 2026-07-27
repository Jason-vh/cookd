import { LEVEL } from "./data/level";
import type { ApplianceKind, ItemSpec, World } from "./sim/types";

/**
 * The saved-kitchen format, and nothing else.
 *
 * This module is **pure and shared**: the browser used to own it, the server
 * owns it now, and both need to agree on the shape. Where a save is *kept*
 * (IndexedDB, a file on disk) is deliberately not decided here.
 *
 * Only the things a *player* changed are stored: where the appliances ended up,
 * and the run's progress. Items mid-flight, orders and timers are deliberately
 * discarded. A save that restores a half-chopped tomato and a ticking order is
 * a save that can restore a broken game, and none of it is worth resuming.
 */

/** Bumped whenever the snapshot shape changes; older saves are then dropped. */
const SCHEMA = 1;

export type SavedAppliance = {
  kind: ApplianceKind;
  x: number;
  y: number;
  source?: ItemSpec;
};

export type Save = {
  schema: number;
  /**
   * Identifies the level a save belongs to, by hashing the ASCII itself. Any
   * edit to the layout discards old saves rather than restoring appliances
   * into a kitchen that has moved around them. Size alone is not enough: two
   * different layouts can share dimensions.
   */
  level: string;
  appliances: SavedAppliance[];
  money: number;
  day: number;
};

export function levelFingerprint(): string {
  const source = `${LEVEL.name}\n${LEVEL.rows.join("\n")}`;
  // FNV-1a: not cryptographic, just needs to change when the layout does.
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${LEVEL.name}:${(hash >>> 0).toString(36)}`;
}

/**
 * A cheap value that changes exactly when a save would.
 *
 * Comparing this against what is on disk is what decides whether a write is
 * worth doing. It must cover **every** saved field: it once covered only the
 * layout, and a room could reach day five with money in the bank and never be
 * written, because nobody had moved an appliance so nothing looked dirty.
 */
export function saveSignature(world: World): string {
  let layout = "";
  for (const appliance of world.appliances.values()) {
    layout += `${appliance.id}:${appliance.kind}:${appliance.tile.x},${appliance.tile.y};`;
  }
  return `${layout}|${world.money}|${world.day}`;
}

export function snapshot(world: World): Save {
  const appliances: SavedAppliance[] = [];
  for (const appliance of world.appliances.values()) {
    appliances.push({
      kind: appliance.kind,
      x: appliance.tile.x,
      y: appliance.tile.y,
      ...(appliance.source ? { source: appliance.source } : {}),
    });
  }
  return { schema: SCHEMA, level: levelFingerprint(), appliances, money: world.money, day: world.day };
}

/**
 * Rebuild a saved layout into a freshly created world.
 *
 * The world arrives already built from the level ASCII; we clear the appliance
 * map and tile index, then replay the save. Appliances an old save doesn't
 * mention simply don't exist — that's the point, the player moved or sold them.
 */
export function restore(world: World, save: Save): boolean {
  if (save.schema !== SCHEMA || save.level !== levelFingerprint()) return false;

  world.appliances.clear();
  world.applianceAt.fill(0);

  for (const saved of save.appliances) {
    if (saved.x < 0 || saved.y < 0 || saved.x >= world.width || saved.y >= world.height) continue;
    const id = world.nextId++;
    world.appliances.set(id, {
      id,
      kind: saved.kind,
      tile: { x: saved.x, y: saved.y },
      item: null,
      progress: 0,
      overcook: 0,
      justFinished: false,
      motion: null,
      heldBy: null,
      source: saved.source ?? null,
    });
    world.applianceAt[saved.y * world.width + saved.x] = id;
  }

  world.money = save.money;
  world.day = save.day;
  return true;
}
