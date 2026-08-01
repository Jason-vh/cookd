import { rentFor } from "../data/economy";
import { clearCards, restockCards } from "./cards";
import { platesInWorld, stockPlates } from "./plates";
import { kitchenWarnings } from "./queries";
import { restockStall } from "./shop";
import type { World } from "./types";
import { emptyLedger, log } from "./world";

/**
 * The day loop: opening, closing, and what closing up does to the room.
 *
 * Split out of `step.ts` so the thing that *causes* a day to open — the sign by
 * the door, in `systems/sign.ts` — can call it without importing the module
 * that runs the systems. Same shape as `cards.ts` beside `systems/cards.ts`:
 * the rules live in `sim/`, the thing that happens to them lives in `systems/`.
 */

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
export const CLOSING_GRACE = 60;

/** Is anybody carrying an appliance around? Only the build phase allows it. */
export function someoneIsHolding(world: World): boolean {
  return world.players.some((player) => player.carriedAppliance !== null);
}

/**
 * Open the day the room has spent the morning preparing.
 *
 * Deliberately does **not** advance the day: `endDay` already did, and the
 * build phase belongs to the day it is the morning of. Opening is a decision
 * about a day that already has a number.
 */
export function beginDay(world: World, by = ""): void {
  if (world.evicted) {
    log(world, "The kitchen has been repossessed — start again from the pause menu");
    return;
  }
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
  // Named when somebody did it, because opening is a decision one player makes
  // on behalf of a room that may not have finished shopping — the same reason
  // every line the stall writes says who spent the money.
  log(world, by ? `${by} opened day ${world.day}` : `Day ${world.day} — service!`);
}

/**
 * Turn the sign over mid-service: no more customers, finish the ones inside.
 *
 * Not the same thing as ending the day, and that difference is the reason this
 * exists. The room is full of people who have ordered and are waiting; sweeping
 * them out because somebody decided to close early would be the one moment the
 * simulation stopped taking its own customers seriously. Instead the clock is
 * simply run out early, and the closing beat that every ordinary day ends with
 * takes over from there — arrivals stop, the room empties, the day ends.
 *
 * An empty room therefore closes immediately, which is what closing an empty
 * restaurant should feel like.
 */
export function callLastOrders(world: World, by = ""): void {
  if (world.phase !== "service" || world.dayTime <= 0) return;
  world.dayTime = 0;
  log(world, by ? `${by} called last orders` : "Last orders");
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
 * The **rent** is taken here, before the day rolls over, so it lands on the
 * ledger of the day that paid it and the morning opens on a balance that is
 * already true. It is the one thing that takes money out of a room without a
 * player pressing anything, which is why it is charged where the day is named
 * rather than anywhere quieter.
 */
export function endDay(world: World): void {
  world.phase = "build";
  world.dayTime = 0;
  clearService(world);
  log(world, `Day ${world.day} closed`);
  chargeRent(world);

  world.day++;
  restockStall(world);
  // The morning's cards, rolled from the seed and the day it now is. Most
  // mornings that is nothing at all — see `isCardMorning`.
  restockCards(world);
}

/**
 * The landlord, and the only end this game has.
 *
 * The shop used to be a decision with no downside: money went up on its own, so
 * buying nothing was always safe and "we cannot afford the oven" was a sentence
 * about patience rather than about risk. A standing cost is what makes a
 * morning's spending a bet — and what makes selling an appliance back at half
 * price a *move* rather than an undo button.
 *
 * The debt is the whole design. A shortfall is not a refused transaction: the
 * till simply goes negative, the log says so, and the room has until the next
 * closing time to get back to zero. Only failing *that* ends the run, so a
 * disastrous day costs a day of recovery, and losing takes two closings and a
 * warning in between. There is no way to be evicted by surprise.
 *
 * Charged before `world.day++`, so `rentFor` is asked about the day that has
 * just been played and the ledger the report card reads is the one it lands on.
 */
function chargeRent(world: World): void {
  const rent = rentFor(world.day);
  if (rent === 0) return;

  // A negative balance here is yesterday's shortfall, still unpaid after a
  // whole day of service. Nothing further is charged: the run is over, and
  // adding rent to a debt nobody will ever settle would only make the final
  // card lie about how far behind the room actually got.
  if (world.money < 0) {
    world.evicted = true;
    log(world, `Rent unpaid twice — the kitchen is repossessed`);
    return;
  }

  world.money -= rent;
  world.today.rent = rent;
  if (world.money < 0) {
    log(world, `Rent $${rent} — $${-world.money} short, and due by tomorrow`);
    return;
  }
  log(world, `Rent paid: $${rent}`);
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
