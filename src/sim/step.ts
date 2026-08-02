import { CLOSING_GRACE, endDay } from "./day";
import type { Inputs, World } from "./types";
import { applianceSystem } from "./systems/appliances";
import { customerSystem } from "./systems/customers";
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
  if (world.pausedBy !== null) return held(world, inputs);

  movementSystem(world, inputs, dt);
  interactionSystem(world, inputs);
  applianceSystem(world, dt);
  customerSystem(world, dt);
  clockSystem(world, dt);
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
 *  - **It changed the phase.** Opening a day is a grab like any other now — the
 *    sign by the door — so a predicted tick would flip the prediction world
 *    into `service` while the server was still in `build`. `interactionSystem`
 *    then took the *service* branch for a round trip, so a grab held across the
 *    transition predicted a completely different action — and `workingOn` is one
 *    of the few predicted fields that is actually drawn. The sign refuses to be
 *    pulled by a guess (`World.predicting`), and the clock below is not
 *    predicted at all.
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
 *
 * **The morning is not predicted at all.** Build-phase interaction buys, sells
 * and moves appliances — it *mints entities* and rewrites the layout — and a
 * client guessing at that invents ids the server will never agree with, once per
 * replayed tick, twenty times a second until the layout message lands. Service
 * interaction only ever moves items that already exist, which is a guess that
 * can be wrong but cannot be made up. Nothing is lost by waiting: the morning
 * has no clock, and an appliance that lands a round trip late lands in an empty
 * kitchen nobody is racing through.
 */
export function predict(world: World, inputs: Inputs, dt: number = DT): void {
  world.tick++;
  if (world.pausedBy !== null) return held(world, inputs);
  movementSystem(world, inputs, dt);
  if (world.phase === "service") interactionSystem(world, inputs);
  expire(world, dt);
  latch(world, inputs);
}

/**
 * A paused tick: the clock still turns, and nothing else does.
 *
 * The tick counter advances because it is what the wire is paced by — a server
 * that stopped numbering its frames would look to every client like a server
 * that had stopped sending them. The buttons are latched for the same reason
 * they are latched in a predicted tick: whatever was held when the menu opened
 * must not read as a fresh press the moment it closes.
 *
 * Log lines and cues are deliberately **not** aged out. They are things the
 * room said, and a paused room is one nobody is reading yet.
 */
function held(world: World, inputs: Inputs): void {
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
    player.prev.rotate = input.rotate;
    player.prev.start = input.start;
    player.prev.menu = input.menu;
  }
}

/**
 * The service clock, and the closing beat at the end of it.
 *
 * All this system does now is run time forward: opening and closing are things
 * a player does to the sign by the door (`systems/sign.ts`), and the morning
 * has no clock at all. It used to also watch for a `start` press, which was the
 * whole of "opening the restaurant" — a verb with nothing in the room behind it.
 */
function clockSystem(world: World, dt: number): void {
  if (world.phase !== "service") return;
  world.dayTime -= dt;
  if (world.dayTime > 0) return;
  if (world.customers.length === 0 || world.dayTime <= -CLOSING_GRACE) endDay(world);
}
