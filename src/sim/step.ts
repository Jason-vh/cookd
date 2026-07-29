import { clearCards, restockCards } from "./cards";
import { platesInWorld, stockPlates } from "./plates";
import { restockStall } from "./shop";
import type { Inputs, World } from "./types";
import { emptyLedger, log } from "./world";
import { applianceSystem } from "./systems/appliances";
import { cardSystem } from "./systems/cards";
import { customerSystem } from "./systems/customers";
import { kitchenWarnings } from "./queries";
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
  cardSystem(world, dt);
  customerSystem(world, dt);
  phaseSystem(world, inputs, dt);
  expire(world, dt);
  latch(world, inputs);
}

/**
 * Advance only the parts of the world a client is allowed to guess at.
 *
 * The networked client runs its own chefs ahead of the server and replays the
 * unacknowledged ones every time a frame lands (see `net.ts`). It used to do
 * that with the full `step`, which was wrong in three ways:
 *
 *  - **It changed the phase.** `phaseSystem` fires on a local `start` press, so
 *    predicting one flipped the prediction world into `service` while the
 *    server was still in `build`. `interactionSystem` then took the *service*
 *    branch for a round trip, so a grab held across the transition predicted a
 *    completely different action — and `workingOn` is one of the few predicted
 *    fields that is actually drawn.
 *  - **It spawned customers.** `customerSystem` runs a full grid flood fill
 *    every tick, on every predicted tick *and* every replayed one, to produce
 *    people that `applyFrame` overwrites a moment later. On a slow link that is
 *    the client's largest simulation cost, spent entirely on results nobody
 *    sees.
 *  - **It advanced the RNG.** Those spawns drew from `random(world)`, so the
 *    prediction's stream diverged from the server's permanently. Harmless only
 *    because nothing predicted from it is kept.
 *
 * What a client may predict is exactly what its own input causes directly:
 * where its chefs are, and what they are holding or working. Everything else is
 * the server's to say.
 */
export function predict(world: World, inputs: Inputs, dt: number = DT): void {
  world.tick++;
  movementSystem(world, inputs, dt);
  interactionSystem(world, inputs);
  expire(world, dt);
  latch(world, inputs);
}

/** Age out the transient log lines and one-shot cues. */
function expire(world: World, dt: number): void {
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
}

/**
 * Remember this tick's buttons, so the next one can detect an edge.
 *
 * Prediction needs this as much as a full tick does: without it a held `grab`
 * would re-fire on every replayed tick, which is up to 240 of them.
 */
function latch(world: World, inputs: Inputs): void {
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

/** Is anybody carrying an appliance around? Only the build phase allows it. */
function someoneIsHolding(world: World): boolean {
  return world.players.some((player) => player.carriedAppliance !== null);
}

/**
 * Close the kitchen and wake into the next morning.
 *
 * The day number moves **here**, not at open, and that is what makes the build
 * phase read as a morning rather than as an aftermath: close day 3, and the
 * room is now standing in the morning of day 4 deciding what to buy for it. The
 * HUD says "Day 4" throughout, first preparing and then serving, which is how
 * days work.
 *
 * Nothing is taken at close. A day's takings are the day's takings, and what
 * the room does with them is the morning's business — the pressure is meant to
 * be "we cannot afford the oven", and there is no fail state here on purpose.
 */
export function endDay(world: World): void {
  world.phase = "build";
  world.dayTime = 0;
  clearService(world);
  log(world, `Day ${world.day} closed`);

  world.day++;
  restockStall(world);
  // The morning's cards, rolled from the seed and the day it now is. Most
  // mornings that is nothing at all — see `isCardMorning`.
  restockCards(world);
}

/**
 * Empty the kitchen and the dining room.
 *
 * Tips left on tables are swept up with everything else: an uncollected tip is
 * money the players chose not to walk over for, and carrying it into the next
 * day would quietly remove the reason to bus during service.
 *
 * **Something else depends on this and cannot see it.** Because every item is
 * destroyed here, a ruined dish only occupies a plate until closing time — which
 * is the entire reason the stall is willing to sell you your last bin, and why
 * `ESSENTIAL` in `data/appliances.ts` has two entries rather than three. If food
 * or dirt ever survives a day boundary, that decision has to be revisited in the
 * same change.
 *
 * **Plates are counted out and counted back in.** They are the one thing in the
 * kitchen that cannot simply be thrown away at closing time: there are a fixed
 * number of them, a day that ends mid-rush ends with most of them dirty on
 * tables, and a wipe that took them with it would shrink the kitchen's supply
 * every single day until the room could not serve anybody. Closing up washes
 * up — which is what closing up is.
 */
function clearService(world: World): void {
  const plates = platesInWorld(world);
  world.customers.length = 0;
  for (const player of world.players) player.carried = null;
  for (const appliance of world.appliances.values()) {
    appliance.item = null;
    appliance.progress = 0;
    appliance.overcook = 0;
    appliance.tip = 0;
  }
  stockPlates(world, plates);
}

/** Wipe the current day and run it again. Used by the pause menu. */
export function restartDay(world: World): void {
  // Same guard as opening a day, for the same reason: service has no way to put
  // a held appliance down, so starting one while somebody is carrying an oven
  // strands them holding it until the day ends.
  if (someoneIsHolding(world)) {
    log(world, "Put down what you're holding first");
    return;
  }
  world.phase = "service";
  world.dayTime = world.dayLength;
  world.nextArrivalIn = 2;
  world.today = emptyLedger(world.day);
  clearService(world);
  log(world, `Day ${world.day} restarted`);
}

/**
 * Open the day the room has spent the morning preparing.
 *
 * Deliberately does **not** advance the day: `endDay` already did, and the
 * build phase belongs to the day it is the morning of. Opening is a decision
 * about a day that already has a number.
 */
export function beginDay(world: World): void {
  if (someoneIsHolding(world)) {
    log(world, "Put down what you're holding first");
    return;
  }
  world.today = emptyLedger(world.day);
  world.phase = "service";
  world.dayTime = world.dayLength;
  world.nextArrivalIn = 2;
  // Everything a kitchen can be rearranged — or sold — into that stops it
  // working, said out loud rather than prevented. This used to be one warning
  // about a walled-off dining room; the stall added a dozen more ways to reach
  // the same place, and they are all the same sentence. See `kitchenWarnings`
  // for why refusing the sale would be the wrong instrument.
  // Unpicked cards leave with the morning. The choice was optional, the next
  // offer comes on schedule regardless, and a room may consolidate on purpose.
  clearCards(world);
  for (const warning of kitchenWarnings(world)) log(world, warning);
  log(world, `Day ${world.day} — service!`);
}
