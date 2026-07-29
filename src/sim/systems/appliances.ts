import { applianceDef } from "../../data/appliances";
import { BURNT } from "../../data/ingredients";
import { BURN_INDEX, TRANSFORM_INDEX } from "../../data/recipes";
import { specKey } from "../items";
import type { Appliance, Item, Transform, World } from "../types";

/**
 * Advances every loaded appliance:
 *   - "hold" transforms only progress while a player is holding USE at them;
 *   - "auto" transforms run on their own;
 *   - finished items sitting on a hot appliance eventually burn.
 *
 * Work is matched by **station** (`prep` / `fry` / `bake`), not by appliance
 * kind, so any counter can be prepped on — a chopping board is just faster.
 */
export function applianceSystem(world: World, dt: number): void {
  const working = new Set<number>();
  for (const player of world.players) {
    if (player.workingOn !== null) working.add(player.workingOn);
  }

  for (const appliance of world.appliances.values()) {
    appliance.justFinished = false;
    appliance.motion = null;
    const item = appliance.item;
    if (!item) {
      appliance.progress = 0;
      appliance.overcook = 0;
      continue;
    }

    const key = specKey(item);
    const speed = applianceDef(appliance.kind).speed;
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
  for (const station of applianceDef(appliance.kind).stations) {
    const transform = TRANSFORM_INDEX.get(`${station}|${itemKey}`);
    if (transform) return transform;
  }
  return undefined;
}

function findBurnTime(appliance: Appliance, itemKey: string): number | undefined {
  for (const station of applianceDef(appliance.kind).stations) {
    const burnAfter = BURN_INDEX.get(`${station}|${itemKey}`);
    if (burnAfter !== undefined) return burnAfter;
  }
  return undefined;
}
