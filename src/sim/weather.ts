import { FIRST_DELIVERY_DAY } from "../data/economy";
import { FAIR, WEATHERS, weatherById, type Weather } from "../data/weather";
import { mulberry32 } from "./random";
import type { World } from "./types";
import { touchLayout } from "./world";

/**
 * Today's weather: rolled from the seed and the day, and then simply true.
 *
 * The same shape as the morning's delivery (`sim/shop.ts`), for the same
 * reasons and with one difference worth stating. It is **rolled** from
 * `(seed, day)` through a stream of its own, because `random(world)` is
 * consumed by play and has diverged between two clients within a minute of
 * opening. It is then **stored** on the world and sent in the layout message,
 * where the delivery's leftovers already ride — see `Layout.weather`.
 *
 * Storing something derivable looks redundant and is not. `world.seed` is the
 * one input, every caller of `createWorld` currently passes the default, and a
 * sky that is computed independently on each screen is a sky that silently
 * disagrees the day anybody wires a real per-room seed on one side only. The
 * terrace is a *rule* as well as a look — a table that is open on the server and
 * shut on your screen is a customer walking to a chair nobody can see — so this
 * is not a thing to leave to two ends agreeing by arithmetic.
 */

/**
 * The day's weather, from two numbers that cannot drift.
 *
 * Day one is always fair, for the reason there is no delivery on it (see
 * `FIRST_DELIVERY_DAY`): the days a room has no say in are the days nothing is
 * done to it. A kitchen on its first morning owns no outdoor table and has no
 * money to buy one, so rain could only take something away without ever having
 * offered the choice that makes it interesting.
 */
export function rollWeather(seed: number, day: number): Weather {
  if (day < FIRST_DELIVERY_DAY) return FAIR;
  // `| 0` keeps the seed in the 32-bit shape `mulberry32` is written for. The
  // constants differ from the shop's so that two rolls off the same day are not
  // two readings of one number.
  const random = mulberry32((seed * 0x27d4eb + day * 0x165667) | 0);
  let total = 0;
  for (const entry of WEATHERS) total += entry.weight;
  let roll = random() * total;
  for (const entry of WEATHERS) {
    roll -= entry.weight;
    if (roll < 0) return entry;
  }
  return FAIR;
}

/**
 * Roll the weather for the day the world is now on.
 *
 * Called wherever `restockStall` is — world creation, closing time and restore
 * — because they are the same event seen twice: a new day, and everything about
 * it that was decided before anybody woke up.
 */
export function setWeather(world: World): void {
  world.weather = rollWeather(world.seed, world.day).id;
  // Done here rather than trusted to the callers, for the reason `restockStall`
  // does it: the weather rides the layout message and nothing has *moved*, so
  // this is the easiest bump in the game to forget — and forgetting it is a
  // client playing a whole day under yesterday's sky, with a terrace the server
  // has already closed.
  touchLayout(world);
}

/** What sort of day it is. */
export function weatherOf(world: World): Weather {
  return weatherById(world.weather);
}

/** Is anybody sitting outside today? */
export function servesOutdoors(world: World): boolean {
  return weatherOf(world).outdoor;
}
