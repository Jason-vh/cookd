import type { Inputs, World } from "./types";
import { log } from "./world";
import { applianceSystem } from "./systems/appliances";
import { interactionSystem } from "./systems/interaction";
import { movementSystem } from "./systems/movement";
import { orderSystem } from "./systems/orders";

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
  orderSystem(world, dt);
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

function phaseSystem(world: World, inputs: Inputs, dt: number): void {
  if (world.phase === "service") {
    world.dayTime -= dt;
    if (world.dayTime <= 0) endDay(world);
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
  world.orders.length = 0;
  for (const player of world.players) player.carried = null;
  for (const appliance of world.appliances.values()) {
    appliance.item = null;
    appliance.progress = 0;
    appliance.overcook = 0;
  }
  log(world, `Day ${world.day} closed — rearrange the kitchen`);
}

/** Wipe the current day and run it again. Used by the pause menu. */
export function restartDay(world: World): void {
  world.phase = "service";
  world.dayTime = world.dayLength;
  world.nextOrderIn = 2;
  world.orders.length = 0;
  for (const player of world.players) player.carried = null;
  for (const appliance of world.appliances.values()) {
    appliance.item = null;
    appliance.progress = 0;
    appliance.overcook = 0;
  }
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
  world.nextOrderIn = 2;
  log(world, `Day ${world.day} — service!`);
}
