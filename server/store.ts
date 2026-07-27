import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { Save } from "../src/save";

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

export async function loadSave(room: string): Promise<Save | null> {
  try {
    const file = Bun.file(pathFor(room));
    if (!(await file.exists())) return null;
    return (await file.json()) as Save;
  } catch {
    return null;
  }
}

/**
 * One write at a time per room, and never a half-written file.
 *
 * Two saves can be triggered in the same tick — a layout change and the last
 * player leaving — and interleaved writes to the same path can leave truncated
 * JSON. `loadSave` swallows the parse error, so the symptom would be a kitchen
 * that silently reverted to the default layout: the worst possible way to lose
 * someone's build. Writing to a temporary file and renaming makes the swap
 * atomic; the queue makes concurrent calls serial.
 */
const writing = new Map<string, Promise<void>>();

export function saveKitchen(room: string, save: Save): Promise<void> {
  const previous = writing.get(room) ?? Promise.resolve();
  const next = previous.then(() => write(room, save)).catch(() => {});
  writing.set(room, next);
  void next.then(() => {
    if (writing.get(room) === next) writing.delete(room);
  });
  return next;
}

async function write(room: string, save: Save): Promise<void> {
  const path = pathFor(room);
  try {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    await Bun.write(temporary, JSON.stringify(save));
    await rename(temporary, path);
  } catch (error) {
    // Never let a full disk take the kitchen down with it.
    console.warn("[cookd] could not save", room, error);
  }
}
