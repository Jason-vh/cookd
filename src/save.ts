import { APPLIANCES, ESSENTIAL, applianceDef } from "./data/appliances";
import { LEVEL, type LevelDef, levelById, parseLevelDef } from "./data/level";
import { BACKFILL_RECIPES } from "./data/progression";
import { restockCards, setUnlocked } from "./sim/cards";
import { MAX_PLATES, platesInWorld, stockPlates } from "./sim/plates";
import { restockStall, stallSlots } from "./sim/shop";
import type { ApplianceKind, ItemSpec, Vec2, World } from "./sim/types";
import { emptyLedger, nearestFreeTile, spawnAppliance, touchLayout } from "./sim/world";

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
export const SCHEMA = 6;

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
  /**
   * The kitchen itself, for a room whose level is not in the registry.
   *
   * Absent for the hand-made levels, where the id is a pointer into a table
   * both ends compile and storing the geometry would be storing something we
   * can always look up. Present for a [generated](./data/generate.ts) one,
   * where there is nothing to look up: the id names a building that only ever
   * existed as the output of a function, and a function is free to change.
   *
   * This is what makes the generator safe to retune. Without it, tomorrow's
   * version of `generateLevel` would silently move the walls of every room
   * already playing — and their saved appliance coordinates with them.
   *
   * It also makes `snapshot`'s rule about immovable furniture true again. That
   * furniture is deliberately not saved because it is rebuilt "from the level
   * itself, the only place that can still be right after the level changes";
   * for a generated kitchen this *is* the level itself.
   */
  def?: LevelDef;
  appliances: SavedAppliance[];
  money: number;
  day: number;
  /**
   * How many plates this kitchen owns.
   *
   * Plates are conserved during play, so this only ever changes when a level
   * says so — or, later, when somebody buys one. It is saved as a *number*
   * rather than as where each plate happened to be: mid-flight items are
   * deliberately discarded like everything else, and a plate comes back clean
   * on the stack. A save that restored four dirty plates onto four tables would
   * be restoring the washing-up, which is nobody's idea of resuming.
   */
  plates: number;
  /**
   * Which stall slots have already been emptied this morning.
   *
   * The stock itself is not stored: it is a pure function of the room's seed
   * and the day, so writing it down would be writing down something we can
   * always recompute. What *cannot* be recomputed is what somebody already
   * bought — and without it, a room coming back from disk finds a full stall
   * again, which turns "restart the server" into a way to reroll the shop.
   */
  stall: number[];
  /**
   * The recipes this kitchen has unlocked, and the day the newest arrived.
   *
   * The only part of a run that is neither money nor furniture, and the one
   * that a reset deliberately keeps: reset un-wrecks the layout, it does not
   * delete history. `unlockedDay` comes along because a save written in a card
   * morning must not be offered the pair it has already spent.
   */
  unlocked: string[];
  unlockedDay: number;
  /**
   * The run ended: the rent went unpaid twice.
   *
   * Saved because it is the one piece of run state a refresh could otherwise
   * *undo* — a repossessed kitchen that comes back from disk able to open again
   * is not a lose condition, it is a loading screen. The layout is kept exactly
   * as it was: an evicted room is still somebody's restaurant to look at, and
   * resetting is a decision they make rather than one made for them.
   */
  evicted: boolean;
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
  const stall = takenSlots(world).join(",");
  const menu = world.unlocked.join(",");
  return `${layout}|${world.money}|${world.day}|${platesInWorld(world)}|${stall}|${menu}|${world.unlockedDay}|${world.evicted}`;
}

/**
 * Slots that have already handed something out, by index.
 *
 * A slot counts as emptied whether the offer was carried away (`taken`) or
 * simply consumed, as a bought plate is — both are "there is nothing there any
 * more", which is the only thing the save has to be able to say.
 */
function takenSlots(world: World): number[] {
  const emptied: number[] = [];
  for (const [index, slot] of stallSlots(world).entries()) {
    if (slot.taken !== null || slot.offer === null) emptied.push(index);
  }
  return emptied;
}

/**
 * What a kitchen is worth writing down.
 *
 * **Immovable appliances are skipped.** They are furniture of the *place*, not
 * of anybody's build: the walls, and the market stall on the patio. Storing
 * them would mean every save carrying a copy of the level, and a save written
 * before a stall existed describing a kitchen that has none. `restore` rebuilds
 * them from the level itself instead, which is where they came from and the
 * only place that can still be right after the level changes.
 */
export function snapshot(world: World, level: LevelDef = LEVEL): Save {
  const appliances: SavedAppliance[] = [];
  for (const appliance of world.appliances.values()) {
    if (!applianceDef(appliance.kind).movable) continue;
    appliances.push({
      kind: appliance.kind,
      x: appliance.tile.x,
      y: appliance.tile.y,
      ...(appliance.source ? { source: appliance.source } : {}),
    });
  }
  return {
    schema: SCHEMA,
    level: level.id,
    // Only when there is nowhere else to get it from. A save that carried a
    // copy of the park would be a save that disagrees with the park the day
    // somebody moves one of its walls.
    ...(levelById(level.id) ? {} : { def: level }),
    appliances,
    money: world.money,
    day: world.day,
    plates: platesInWorld(world),
    stall: takenSlots(world),
    unlocked: [...world.unlocked],
    unlockedDay: world.unlockedDay,
    evicted: world.evicted,
  };
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
  // Absent in schema 1 and 2, and supplied by the migration. Present but wrong
  // is still a file we do not understand.
  const plates = value.plates === undefined ? 0 : finite(value.plates);
  if (plates === null || plates < 0 || plates > MAX_PLATES) return null;
  if (!Array.isArray(value.appliances) || value.appliances.length > 4096) return null;

  // Absent before schema 4. Bounded and integral, because it indexes the slots.
  const stall: number[] = [];
  if (value.stall !== undefined) {
    if (!Array.isArray(value.stall) || value.stall.length > 64) return null;
    for (const entry of value.stall) {
      const index = finite(entry);
      if (index === null || !Number.isInteger(index) || index < 0) return null;
      stall.push(index);
    }
  }

  // Absent before schema 5, and supplied by the migration. Bounded, and every
  // entry a short string: this list is read straight into the order pool.
  const unlocked: string[] = [];
  if (value.unlocked !== undefined) {
    if (!Array.isArray(value.unlocked) || value.unlocked.length > 64) return null;
    for (const entry of value.unlocked) {
      if (typeof entry !== "string" || entry.length > 32) return null;
      unlocked.push(entry);
    }
  }
  const unlockedDay = value.unlockedDay === undefined ? 0 : finite(value.unlockedDay);
  if (unlockedDay === null || unlockedDay < 0) return null;

  // Absent before schema 6, and absent for every registry level for ever.
  // Present but malformed is a file we do not understand — and this one is
  // load-bearing, because it is the building the coordinates below are in.
  const def = value.def === undefined ? null : parseLevelDef(value.def);
  if (value.def !== undefined && (!def || def.id !== level)) return null;

  // Absent before schema 6, when nothing could end a run.
  if (value.evicted !== undefined && typeof value.evicted !== "boolean") return null;
  const evicted = value.evicted === true;

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

  return {
    schema,
    level,
    ...(def ? { def } : {}),
    appliances,
    money,
    day: Math.max(1, Math.floor(day)),
    plates: Math.floor(plates),
    stall,
    unlocked,
    unlockedDay: Math.floor(unlockedDay),
    evicted,
  };
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
  // The id is written out rather than read from `LEVEL`, which is what it used
  // to do. `LEVEL.id` is whatever kitchen the game ships *today*, so a v1 save
  // would silently be re-labelled as belonging to a level whose walls have
  // since moved — and then restored into it, appliance by misplaced appliance.
  // A migration must name the thing it actually meant.
  1: (save) => ({ ...save, schema: 2, level: "park-kitchen" }),
  // v2 predates finite plates, so it cannot say how many the kitchen owns. The
  // rule the levels use — one per table, plus two — is recoverable from the
  // save's own appliance list, which is better than a constant: a kitchen
  // somebody built four tables into gets four tables' worth of crockery.
  2: (save) => ({
    ...save,
    schema: 3,
    plates: Math.min(MAX_PLATES, save.appliances.filter((e) => e.kind === "table").length + 2),
    // v2 stored a `source` on the plate stack, from when it conjured plates out
    // of nothing. Nothing reads it any more, but it would be re-saved for ever
    // and it still makes the appliance draw a crate's ingredient marker.
    appliances: save.appliances.map((entry) =>
      entry.kind === "plates" ? { kind: entry.kind, x: entry.x, y: entry.y } : entry,
    ),
  }),
  // v3 predates the stall, so nothing has been bought from one. It also
  // predates the patio ring, which moved every tile in the kitchen — but that
  // is not a migration, it is a *different level*, and the level id says so.
  3: (save) => ({ ...save, schema: 4, stall: [] }),
  // v4 predates the card stand, so it cannot say what its menu is — it did not
  // have one. Those kitchens were played against `unlockDay`, which handed out
  // fries on day two and pizza on day three, and their layouts still have the
  // fryer and the oven standing in them. Backfilling the three they were
  // playing with is the same philosophy as the essential-appliance top-up: a
  // schema bump is not an excuse to take somebody's restaurant away.
  //
  // `unlockedDay: 0` says "nothing was unlocked recently", so no launch-day
  // weighting and no morning that thinks it has already spent its cards.
  4: (save) => ({ ...save, schema: 5, unlocked: [...BACKFILL_RECIPES], unlockedDay: 0 }),
  // v5 predates two things. Generated kitchens: every v5 save is a registry
  // level, so a missing `def` means "look it up" rather than "the file is
  // incomplete", and there is nothing to backfill. And the rent: no v5 kitchen
  // can have failed to pay it, and they banked their takings under a promise
  // that nothing would ever take money out of the till, so they arrive in the
  // new economy with whatever that promise left them — the kindest possible
  // starting position, and the reason this needs no more than a flag.
  5: (save) => ({ ...save, schema: 6, evicted: false }),
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
 * The world arrives already built from the level; we clear the appliance
 * map and tile index, then replay the save. Appliances an old save doesn't
 * mention simply don't exist — that's the point, the player moved or sold them.
 *
 * Returns *why* it failed rather than a bare boolean, because the caller has to
 * decide whether to overwrite the file, and "this is from a different level" and
 * "this is from the future" call for opposite answers.
 */
export function restore(world: World, save: Save, level: LevelDef = LEVEL): RestoreResult {
  const migrated = migrate(save);
  if (!migrated) return { ok: false, reason: "schema" };
  if (migrated.level !== level.id) return { ok: false, reason: "level" };

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
    // The patio is not a place a build may reach; the level owns what stands
    // out there. A save should never name one, and one that does is describing
    // a kitchen from before its walls moved.
    if (!world.tiles[index]?.placeable) continue;
    placed.set(index, saved);
  }

  // A save that restores to an empty kitchen is a save that has eaten itself.
  // Better to start fresh than to drop players into a bare rectangle.
  if (placed.size === 0) return { ok: false, reason: "empty" };

  // The level's own furniture survives the clear: it was never in the file, and
  // it belongs to the place rather than to the build. Put back first so a saved
  // appliance can never land on the stall's tile.
  const furniture = [...world.appliances.values()].filter(
    (appliance) => !applianceDef(appliance.kind).movable,
  );
  world.appliances.clear();
  world.applianceAt.fill(0);
  for (const fixed of furniture) {
    spawnAppliance(world, fixed.kind, fixed.tile, fixed.source);
  }
  for (const saved of placed.values()) {
    if ((world.applianceAt[saved.y * world.width + saved.x] ?? 0) !== 0) continue;
    spawnAppliance(world, saved.kind, { x: saved.x, y: saved.y }, saved.source ?? null);
  }
  topUp(world, level);

  world.money = migrated.money;
  world.day = migrated.day;
  world.evicted = migrated.evicted;
  world.today = emptyLedger(migrated.day);
  // Before either restock: the stall stocks for the menu and the stand rolls
  // against it, so a world holding the wrong one would roll the wrong shop.
  setUnlocked(world, migrated.unlocked, migrated.unlockedDay);
  // Wherever they were when the room went quiet, plates come back clean and on
  // the stack. See the note on `Save["plates"]`.
  stockPlates(world, migrated.plates);
  // The stock is rolled again from the seed and the day — the same roll, so the
  // same three things — and then emptied where the file says it was emptied.
  restockStall(world);
  const slots = stallSlots(world);
  for (const index of migrated.stall) {
    const slot = slots[index];
    if (slot) slot.offer = null;
  }
  // And this morning's cards, if it is a card morning and the room has not
  // already chosen — `unlockedDay` is what remembers that.
  restockCards(world);
  touchLayout(world);
  return { ok: true };
}

/**
 * Give a restored kitchen back the essentials its save has none of.
 *
 * The alternative was to change the level's id, which invalidates every save on
 * every server — a real cost paid by real people to avoid twenty lines. An
 * appliance arrives on the tile the level puts it on, or the nearest free one
 * if the layout has moved on without it.
 */
function topUp(world: World, level: LevelDef): void {
  const present = new Set<ApplianceKind>();
  for (const appliance of world.appliances.values()) present.add(appliance.kind);

  for (const kind of ESSENTIAL) {
    if (present.has(kind)) continue;
    const home = levelTileFor(level, kind) ?? { x: 0, y: 0 };
    const free = nearestFreeTile(world, home);
    if (!free) continue; // a kitchen with no room left has bigger problems
    spawnAppliance(world, kind, free);
  }
}

/** Where the level itself puts this kind of appliance, if it does. */
function levelTileFor(level: LevelDef, kind: ApplianceKind): Vec2 | null {
  return level.appliances.find((placement) => placement.kind === kind)?.at ?? null;
}
