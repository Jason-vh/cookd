import { applianceDef } from "../../data/appliances";
import { BURNT } from "../../data/ingredients";
import { BURN_INDEX, TRANSFORM_INDEX } from "../../data/recipes";
import { makeItem, specKey } from "../items";
import type { Appliance, Item, Transform, World } from "../types";
import { wallBetween } from "../walls";
import { applianceAtTile, fittedDef } from "../world";

/**
 * Advances every loaded appliance:
 *   - a hopper hands out what it holds — see `dispense`;
 *   - a conveyor carries what is on it and hands it on — see `carry`;
 *   - "hold" transforms only progress while a player is holding USE at them;
 *   - "auto" transforms run on their own;
 *   - finished items sitting on a hot appliance eventually burn.
 *
 * Work is matched by **station** (`prep` / `fry` / `bake`), not by appliance
 * kind, so any counter can be prepped on — a chopping board is just faster.
 *
 * Which is why every question here goes through `fittedDef`: a board is a
 * *fitting* on a counter now, so the counter's own row is the wrong answer for
 * any counter somebody has put one on.
 */
export function applianceSystem(world: World, dt: number): void {
  const working = new Set<number>();
  for (const player of world.players) {
    if (player.workingOn !== null) working.add(player.workingOn);
  }

  for (const appliance of world.appliances.values()) {
    appliance.justFinished = false;
    appliance.motion = null;

    // Before the empty check, not after it: a hopper holds nothing and is the
    // one appliance whose `progress` means something while its hands are empty.
    if (applianceDef(appliance.kind).feeds > 0) {
      dispense(world, appliance, dt);
      continue;
    }

    const item = appliance.item;
    if (!item) {
      appliance.progress = 0;
      appliance.overcook = 0;
      continue;
    }

    // Before the transform search, because a belt's `progress` means something
    // else entirely and the search would zero it every tick on its way to
    // deciding a conveyor cannot cook. Asked of the kind rather than through
    // `fittedDef`: a belt is not a worktop, so nothing is ever fitted to one.
    if (applianceDef(appliance.kind).travel > 0) {
      carry(world, appliance, item, dt);
      continue;
    }

    const key = specKey(item);
    const speed = fittedDef(appliance).speed;
    const transform = findTransform(appliance, key);

    if (transform) {
      appliance.overcook = 0;
      const active = transform.mode === "auto" || working.has(appliance.id);
      if (!active) {
        // Prep progress decays slowly if you walk away — forgiving, but you
        // can't bank a half-chopped tomato forever.
        appliance.progress = Math.max(0, appliance.progress - dt * 0.15);
        continue;
      }
      // Tells the render layer which action to animate, and only while it is
      // genuinely being performed.
      appliance.motion = transform.motion ?? null;
      appliance.progress += (dt * speed) / transform.duration;
      if (appliance.progress >= 1) {
        applyOutput(item, transform);
        appliance.progress = 0;
        appliance.justFinished = true;
      }
      continue;
    }

    const burnAfter = findBurnTime(appliance, key);
    if (burnAfter === undefined) {
      appliance.progress = 0;
      appliance.overcook = 0;
      continue;
    }

    appliance.overcook += dt;
    appliance.progress = Math.min(1, appliance.overcook / burnAfter);
    if (appliance.overcook >= burnAfter) {
      item.processes = [...item.processes, BURNT];
      appliance.overcook = 0;
      appliance.progress = 0;
    }
  }
}

/**
 * Where an appliance that pushes may put its load, or null for nowhere.
 *
 * The one rule a belt and a hopper share, and the reason they share it is that
 * there is only one honest answer to "may this machine put something here": the
 * **plain** put-it-down. The next appliance takes it if it accepts items and is
 * empty. Neither machine performs a chef's special verbs — neither scrapes into
 * a bin, takes a plate off a stack, or combines what it is holding with what it
 * meets. Those are things a pair of hands does, and a machine that quietly did
 * them would be a second, invisible set of rules about what goes with what.
 *
 * What it *can* reach is anything a hand could put something on, including a
 * table and a hatch. Food landing in front of somebody who ordered it is the
 * dining room's rule and the drive-through's rule, and it stays theirs: a belt
 * pointed at a hatch is a long arm, not a new kind of service.
 *
 * Returning the appliance rather than taking the item is what lets a hopper ask
 * **before** it mints anything. A blocked hopper that made a tomato and threw
 * it away would burn an id sixty times a second, and ids are what every client
 * agrees about things by.
 */
function outlet(world: World, from: Appliance): Appliance | null {
  const ahead = { x: from.tile.x + from.dir.x, y: from.tile.y + from.dir.y };
  // Neither machine passes through the shell, nor feeds the room next door
  // through a dividing wall. A hatch is reachable because a hatch stands in a
  // hole somebody already punched.
  if (wallBetween(world, from.tile, ahead)) return null;
  const next = applianceAtTile(world, ahead.x, ahead.y);
  if (!next || next.heldBy !== null || next.item !== null) return null;
  return applianceDef(next.kind).acceptsItems ? next : null;
}

/** Set an item down on an appliance that has just been found empty. */
function load(next: Appliance, item: Item): void {
  next.item = item;
  next.progress = 0;
  next.overcook = 0;
}

/**
 * Carry an item along a conveyor, and hand it over at the far end.
 *
 * Blocked — nothing there, something already there, a wall in the way, or the
 * end of the line — the item simply sits at the far end with `progress` at 1.
 * Backpressure and "this belt goes nowhere" are the same state on purpose:
 * a run that has backed up is a run whose last belt is full, which is the one
 * thing about a jam a player needs to be able to see.
 */
function carry(world: World, belt: Appliance, item: Item, dt: number): void {
  belt.overcook = 0;
  belt.progress = Math.min(1, belt.progress + dt / applianceDef(belt.kind).travel);
  if (belt.progress < 1) return;

  const next = outlet(world, belt);
  if (!next) return;
  load(next, item);
  belt.item = null;
  belt.progress = 0;
}

/**
 * A hopper: hand a fresh copy of what this holds to the tile it faces.
 *
 * The other end of a conveyor, and the reason one is worth owning — a belt that
 * can only be loaded by hand saves the carry rather than the trip. What it
 * pushes is minted from its `source`, exactly as a chef taking one out of a
 * crate would, so ingredients stay infinite and nothing here can create a plate.
 *
 * **It is off while the restaurant is shut.** Not tidiness: the appliance system
 * runs in the morning too, so without this a room spent rearranging its kitchen
 * would open the day with a tomato on every surface a hopper happened to face.
 * The machine being switched off with the sign is also simply what a kitchen
 * looks like.
 *
 * Blocked, it holds at `progress` 1 like a full belt — same rule, same reading,
 * and it is what stops an infinite crate flooding a room.
 */
function dispense(world: World, hopper: Appliance, dt: number): void {
  const source = hopper.source;
  if (world.phase !== "service" || !source) {
    hopper.progress = 0;
    return;
  }
  hopper.progress = Math.min(1, hopper.progress + dt / applianceDef(hopper.kind).feeds);
  if (hopper.progress < 1) return;

  const next = outlet(world, hopper);
  if (!next) return;
  load(next, makeItem(world, source));
  hopper.progress = 0;
}

/**
 * Complete one cycle of work on an item.
 *
 * A **stack** — an item whose contents are copies of itself, which today means
 * a pile of dirty plates — is worked one unit per cycle, and the head goes
 * last. Both halves of that matter:
 *
 *  - one per cycle, so the dial is a plate rather than a pile, and a chef
 *    called away mid-sweep keeps everything already washed;
 *  - head last, because the head is what the pile *is*. Wash it first and the
 *    item's key becomes `plate`, no wash transform matches it any more, and the
 *    sink stops with dirty plates sitting inside a clean one.
 *
 * Only a genuine stack can match here: `transform` was looked up by the head's
 * own key, so a content can only equal the input if it is a duplicate of the
 * head. A plate holding a salad is not one.
 */
function applyOutput(item: Item, transform: Transform): void {
  const inputKey = specKey(transform.input);
  const stacked = item.contents.find((child) => specKey(child) === inputKey);
  const target = stacked ?? item;
  target.base = transform.output.base;
  target.processes = [...transform.output.processes];
}

function findTransform(appliance: Appliance, itemKey: string): Transform | undefined {
  for (const station of fittedDef(appliance).stations) {
    const transform = TRANSFORM_INDEX.get(`${station}|${itemKey}`);
    if (transform) return transform;
  }
  return undefined;
}

/**
 * How long this appliance will hold finished food before ruining it.
 *
 * How long the *dish* survives is content (`BURN_INDEX`); how forgiving the
 * appliance is is a column on the appliance, so a bell oven is a multiplier on
 * the same number rather than a second table of burn times to keep in step.
 */
function findBurnTime(appliance: Appliance, itemKey: string): number | undefined {
  const def = fittedDef(appliance);
  for (const station of def.stations) {
    const burnAfter = BURN_INDEX.get(`${station}|${itemKey}`);
    if (burnAfter !== undefined) return burnAfter * def.patience;
  }
  return undefined;
}
