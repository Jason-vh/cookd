import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { parseSave, type Save } from "../src/save";

/**
 * Where a room's kitchen lives between server restarts.
 *
 * Plain JSON files, one per room. This is not a database and should not become
 * one: a save is under 2 KB, is written a few times a day, and being able to
 * read or delete one with `cat` and `rm` is worth more than any query ability
 * we would ever use.
 */

const DIR = process.env.COOKD_SAVE_DIR ?? "./saves";

function pathFor(room: string): string {
  // Room codes are already normalised to [A-Z0-9]{1,8}, but this is the one
  // place a bad one would become a path traversal, so it is checked again here.
  const safe = room.replace(/[^A-Z0-9]/g, "").slice(0, 8) || "MAIN";
  return `${DIR}/${safe}.json`;
}

export type LoadResult = {
  save: Save | null;
  /**
   * True when there was a file and we could not read it. Distinct from a
   * missing file, which is just a new kitchen: a room built from a *rejected*
   * save must not then write over the thing it rejected.
   */
  corrupt: boolean;
};

/**
 * Read a room's kitchen.
 *
 * A file we cannot parse is **kept**, not overwritten. It used to be silently
 * replaced by the next successful write, which meant a bug in the save format
 * destroyed the evidence of itself along with somebody's kitchen. Now it is
 * renamed out of the way with a timestamp, so the room starts fresh (the only
 * thing it can do) but the file is still there to look at.
 */
export async function loadSave(room: string): Promise<LoadResult> {
  const path = pathFor(room);
  let raw: unknown;
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return { save: null, corrupt: false };
    raw = await file.json();
  } catch (error) {
    console.warn("[cookd] unreadable save", room, error);
    await quarantine(path, "unreadable");
    return { save: null, corrupt: true };
  }

  const save = parseSave(raw);
  if (!save) {
    console.warn("[cookd] rejected save", room, "- kept as .bad");
    await quarantine(path, "invalid");
    return { save: null, corrupt: true };
  }
  return { save, corrupt: false };
}

async function quarantine(path: string, why: string): Promise<void> {
  try {
    await rename(path, `${path}.${why}.${Date.now()}.bad`);
  } catch {
    /* nothing more we can do; the room starts fresh either way */
  }
}

/**
 * One write at a time per room, latest wins, and never a half-written file.
 *
 * Two saves can be triggered in the same tick — a layout change and the last
 * player leaving — and interleaved writes to the same path can leave truncated
 * JSON. Writing to a temporary file and renaming makes the swap atomic.
 *
 * The queue used to *chain*, so a build phase where somebody shuffled ten
 * appliances wrote ten files one after another when only the tenth mattered.
 * Now a room holds at most one in-flight write and one pending save; a new save
 * arriving while a write is in progress replaces the pending one. Intermediate
 * states are not worth the disk, and the last one is the only one that is true.
 */
type Pending = { save: Save; waiters: ((ok: boolean) => void)[] };

const inFlight = new Map<string, Promise<void>>();
const pending = new Map<string, Pending>();

export function saveKitchen(room: string, save: Save): Promise<boolean> {
  const waiting = pending.get(room);
  if (waiting) {
    // Supersede: whoever was waiting on the older save is waiting for "is the
    // kitchen on disk up to date", and this write answers that better.
    waiting.save = save;
    return new Promise<boolean>((resolve) => waiting.waiters.push(resolve));
  }

  const entry: Pending = { save, waiters: [] };
  pending.set(room, entry);
  const result = new Promise<boolean>((resolve) => entry.waiters.push(resolve));

  const previous = inFlight.get(room) ?? Promise.resolve();
  const next = drain(previous, room, entry);
  inFlight.set(room, next);
  void next.finally(() => {
    if (inFlight.get(room) === next) inFlight.delete(room);
  });
  return result;
}

async function drain(previous: Promise<void>, room: string, entry: Pending): Promise<void> {
  await previous;
  // Read `entry.save` now, not when it was queued: a later call may have
  // superseded it while we waited, and the later one is the one that is true.
  pending.delete(room);
  const ok = await write(room, entry.save);
  for (const resolve of entry.waiters) resolve(ok);
}

/**
 * Returns whether the kitchen actually reached the disk.
 *
 * The caller needs the answer. It used to be swallowed, and the server marked
 * the room clean *before* firing the write — so a full disk or a bad volume
 * mount meant it believed the kitchen was saved, never retried, and said
 * nothing until the room was evicted and the layout was gone.
 */
async function write(room: string, save: Save): Promise<boolean> {
  const path = pathFor(room);
  try {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    await Bun.write(temporary, JSON.stringify(save));
    await rename(temporary, path);
    return true;
  } catch (error) {
    // Never let a full disk take the kitchen down with it — but do tell the
    // caller, so it can try again rather than assuming it worked.
    console.warn("[cookd] could not save", room, error);
    return false;
  }
}
