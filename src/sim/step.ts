import type { Inputs, World } from "./types";
import { log } from "./world";
import { applianceSystem } from "./systems/appliances";
import { customerSystem, unreachableTables } from "./systems/customers";
import { interactionSystem } from "./systems/interaction";
import { movementSystem } from "./systems/movement";

/** Fixed simulation timestep. Everything in `sim` assumes this dt. */
export const DT = 1 / 60;

/**
 * Advance the world by exactly one tick.
 *
 * `inputs` is indexed by player id and is the ONLY way the outside world talks
 * to the simulation. Keep it that way: it is what makes replays, tests and a
 * future authoritative server possible.
 *
 * The world is mutated in place — deliberately. At this entity count immutable
 * updates would allocate thousands of objects per second for no benefit.
 */
export function step(world: World, inputs: Inputs, dt: number = DT): void {
  world.tick++;

  movementSystem(world, inputs, dt);
  interactionSystem(world, inputs);
  applianceSystem(world, dt);
  customerSystem(world, dt);
  phaseSystem(world, inputs, dt);

  for (let i = world.events.length - 1; i >= 0; i--) {
    const event = world.events[i]!;
    event.ttl -= dt;
    if (event.ttl <= 0) world.events.splice(i, 1);
  }
  for (let i = world.effects.length - 1; i >= 0; i--) {
    const cue = world.effects[i]!;
    cue.ttl -= dt;
    if (cue.ttl <= 0) world.effects.splice(i, 1);
  }

  // Latch inputs for next tick's edge detection.
  for (const player of world.players) {
    const input = inputs[player.id];
    if (!input) continue;
    player.prev.grab = input.grab;
    player.prev.use = input.use;
    player.prev.start = input.start;
    player.prev.menu = input.menu;
  }
}

/**
 * Closing time is not the end of the day.
 *
 * Arrivals stop before the clock runs out (see `LAST_ORDERS`), and once it does
 * the kitchen stays open until the last customer has eaten and gone. That gives
 * a day a natural closing beat instead of tables vanishing mid-meal — and it
 * makes finishing the stragglers fast a real thing to care about.
 *
 * The grace period is the backstop: nobody can hold a day open forever, and a
 * customer whose dish never arrives is walked out rather than waited on.
 */
const CLOSING_GRACE = 60;

function phaseSystem(world: World, inputs: Inputs, dt: number): void {
  if (world.phase === "service") {
    world.dayTime -= dt;
    if (world.dayTime > 0) return;
    if (world.customers.length === 0 || world.dayTime <= -CLOSING_GRACE) endDay(world);
    return;
  }

  const startPressed = world.players.some((p) => {
    const input = inputs[p.id];
    return !!input && input.start && !p.prev.start;
  });
  if (startPressed) beginDay(world);
}

/** Close the kitchen immediately and move to the build phase. */
export function endDay(world: World): void {
  world.phase = "build";
  world.dayTime = 0;
  clearService(world);
  log(world, `Day ${world.day} closed — rearrange the kitchen`);
}

/**
 * Empty the kitchen and the dining room.
 *
 * Tips left on tables are swept up with everything else: an uncollected tip is
 * money the players chose not to walk over for, and carrying it into the next
 * day would quietly remove the reason to bus during service.
 */
function clearService(world: World): void {
  world.customers.length = 0;
  for (const player of world.players) player.carried = null;
  for (const appliance of world.appliances.values()) {
    appliance.item = null;
    appliance.progress = 0;
    appliance.overcook = 0;
    appliance.tip = 0;
  }
}

/** Wipe the current day and run it again. Used by the pause menu. */
export function restartDay(world: World): void {
  world.phase = "service";
  world.dayTime = world.dayLength;
  world.nextArrivalIn = 2;
  clearService(world);
  log(world, `Day ${world.day} restarted`);
}

/** Open the next day. Exported so the pause menu takes the same path. */
export function beginDay(world: World): void {
  const holding = world.players.some((p) => p.carriedAppliance !== null);
  if (holding) {
    log(world, "Put down what you're holding first");
    return;
  }
  world.day++;
  world.phase = "service";
  world.dayTime = world.dayLength;
  world.nextArrivalIn = 2;
  // A dining room nobody can walk into is the one build-phase mistake that
  // silently ends the run, so it is said out loud rather than prevented.
  const stranded = unreachableTables(world);
  if (stranded.length > 0) {
    log(world, `${stranded.length} table(s) can't be reached from the door`);
  }
  log(world, `Day ${world.day} — service!`);
}
