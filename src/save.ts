import { APPLIANCES } from "./data/appliances";
import { LEVEL } from "./data/level";
import type { ApplianceKind, ItemSpec, World } from "./sim/types";
import { touchLayout } from "./sim/world";

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

/**
 * Bumped whenever the snapshot shape changes.
 *
 * Older saves are **migrated**, not dropped. They used to be dropped, and the
 * combination was quietly awful: `Host` ignored the rejection, so the room came
 * up with the default kitchen, and the first thing the server did was decide
 * the room was dirty and overwrite the file it had just refused to read. A
 * schema bump was therefore indistinguishable from "everyone loses their
 * build", and nothing said so.
 */
const SCHEMA = 2;

export type SavedAppliance = {
  kind: ApplianceKind;
  x: number;
  y: number;
  source?: ItemSpec;
};

export type Save = {
  schema: number;
  /**
   * Identifies the level a save belongs to.
   *
   * This used to hash the level ASCII, which meant *any* edit — including
   * fixing a comment's alignment — invalidated every save in existence. It is
   * now the level's id, so a layout change is a deliberate act with a name
   * rather than a side effect of touching the file.
   */
  level: string;
  appliances: SavedAppliance[];
  money: number;
  day: number;
};

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

export function snapshot(world: World, levelId: string = LEVEL.id): Save {
  const appliances: SavedAppliance[] = [];
  for (const appliance of world.appliances.values()) {
    appliances.push({
      kind: appliance.kind,
      x: appliance.tile.x,
      y: appliance.tile.y,
      ...(appliance.source ? { source: appliance.source } : {}),
    });
  }
  return { schema: SCHEMA, level: levelId, appliances, money: world.money, day: world.day };
}

// --- reading an untrusted file -------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isApplianceKind(value: unknown): value is ApplianceKind {
  return typeof value === "string" && Object.hasOwn(APPLIANCES, value);
}

/**
 * Turn whatever was on disk into a `Save`, or `null`.
 *
 * `JSON.parse(...) as Save` was doing none of this, and the consequences were
 * not subtle. A hand-edited `kind` reached `applianceDef(kind).speed` and threw
 * inside the room tick, which evicted the room — whose players then reconnected,
 * rebuilding it from the same bad file. That is an eviction loop, not a
 * recovery, and the only way out was deleting the file by hand.
 */
export function parseSave(value: unknown): Save | null {
  if (!isRecord(value)) return null;

  const schema = finite(value.schema);
  const money = finite(value.money);
  const day = finite(value.day);
  const level = typeof value.level === "string" ? value.level : null;
  if (schema === null || money === null || day === null || level === null) return null;
  if (!Array.isArray(value.appliances) || value.appliances.length > 4096) return null;

  const appliances: SavedAppliance[] = [];
  for (const entry of value.appliances) {
    if (!isRecord(entry)) return null;
    const x = finite(entry.x);
    const y = finite(entry.y);
    if (x === null || y === null || !Number.isInteger(x) || !Number.isInteger(y)) return null;
    if (!isApplianceKind(entry.kind)) return null;

    const source = parseSpec(entry.source);
    if (source === undefined) return null;
    appliances.push({ kind: entry.kind, x, y, ...(source ? { source } : {}) });
  }

  return { schema, level, appliances, money, day: Math.max(1, Math.floor(day)) };
}

/** `null` for absent, `undefined` for "present but malformed". */
function parseSpec(value: unknown): ItemSpec | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return undefined;
  if (typeof value.base !== "string") return undefined;
  if (!Array.isArray(value.processes) || value.processes.length > 8) return undefined;
  const processes: string[] = [];
  for (const process of value.processes) {
    if (typeof process !== "string") return undefined;
    processes.push(process);
  }
  return { base: value.base, processes };
}

// --- migration -----------------------------------------------------------------

/**
 * Bring an older save up to the current schema, or give up honestly.
 *
 * Each step moves a save forward exactly one version, so adding a schema means
 * adding one function here and nothing else has to know. A save we cannot
 * migrate returns `null`, and the caller is expected to keep the file rather
 * than overwrite it — see `loadSave`.
 */
const MIGRATIONS: Record<number, (save: Save) => Save | null> = {
  // v1 identified levels by hashing the level ASCII, so its `level` field is a
  // hash we can no longer compute a match for. Every v1 save in existence was
  // written against the one level that existed at the time, so that is what
  // they are, and the appliance list — the part a player actually built — is
  // unchanged between the two versions.
  1: (save) => ({ ...save, schema: 2, level: LEVEL.id }),
};

export function migrate(save: Save): Save | null {
  let current = save;
  // Bounded by construction: every step must increase `schema`, so this cannot
  // spin even if someone writes a migration that returns its input.
  while (current.schema < SCHEMA) {
    const step = MIGRATIONS[current.schema];
    if (!step) return null;
    const next = step(current);
    if (!next || next.schema <= current.schema) return null;
    current = next;
  }
  return current.schema === SCHEMA ? current : null;
}

// --- restoring into a world ----------------------------------------------------

export type RestoreResult = { ok: true } | { ok: false; reason: "schema" | "level" | "empty" };

/**
 * Rebuild a saved layout into a freshly created world.
 *
 * The world arrives already built from the level ASCII; we clear the appliance
 * map and tile index, then replay the save. Appliances an old save doesn't
 * mention simply don't exist — that's the point, the player moved or sold them.
 *
 * Returns *why* it failed rather than a bare boolean, because the caller has to
 * decide whether to overwrite the file, and "this is from a different level" and
 * "this is from the future" call for opposite answers.
 */
export function restore(world: World, save: Save, levelId: string = LEVEL.id): RestoreResult {
  const migrated = migrate(save);
  if (!migrated) return { ok: false, reason: "schema" };
  if (migrated.level !== levelId) return { ok: false, reason: "level" };

  // Decide everything before touching the world. An earlier version cleared the
  // grid and *then* discovered the save was unusable, which left the caller
  // holding a world with no appliances in it and a `false` it was free to
  // ignore — which `Host` did.
  const placed = new Map<number, SavedAppliance>();
  for (const saved of migrated.appliances) {
    if (saved.x < 0 || saved.y < 0 || saved.x >= world.width || saved.y >= world.height) continue;
    const index = saved.y * world.width + saved.x;
    // Two appliances on one tile used to produce one that was in the map (so
    // drawn, and sent in every layout message) but not on the grid — a solid
    // looking oven players walked straight through. Last writer wins would be
    // just as arbitrary; first wins at least matches the file's own order.
    if (placed.has(index)) continue;
    // A wall tile is not a place; the level owns those.
    if (world.tiles[index]?.wall) continue;
    placed.set(index, saved);
  }

  // A save that restores to an empty kitchen is a save that has eaten itself.
  // Better to start fresh than to drop players into a bare rectangle.
  if (placed.size === 0) return { ok: false, reason: "empty" };

  world.appliances.clear();
  world.applianceAt.fill(0);
  for (const [index, saved] of placed) {
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
      tip: 0,
    });
    world.applianceAt[index] = id;
  }

  world.money = migrated.money;
  world.day = migrated.day;
  touchLayout(world);
  return { ok: true };
}
