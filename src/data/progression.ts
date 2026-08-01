/**
 * How a kitchen's menu grows: the cards, their cadence, and their weights.
 *
 * Kept apart from `economy.ts`, whose subject is what a square holds and what a
 * sale pays, even though a recipe is now bought from the same paving as an
 * oven. The two tables answer different questions: that one prices *objects* by
 * what they do for a kitchen, this one prices *dishes* by how much kitchen they
 * ask for. A card's fee is a fact about the menu, and it belongs beside the
 * weights that decide which dish is offered in the first place.
 *
 * This is content: plain data, expect to iterate on every number in it.
 */

/**
 * What every kitchen starts with.
 *
 * **One dish, and it is the salad.** It covers every core verb — grab, chop,
 * combine, plate, serve, bus, wash — with no burn risk anywhere in it, so day
 * one is self-paced by construction rather than by a difficulty setting. The
 * thinnest the game will ever be, on purpose: the dining loop is plenty to
 * learn, and everything after it is chosen.
 */
export const STARTING_RECIPES: string[] = ["salad"];

/**
 * What a save written before the cards existed is assumed to know.
 *
 * Those kitchens were built against `unlockDay`, which handed out fries on day
 * two and pizza on day three, and their layouts still have the fryer and the
 * oven standing in them. Backfilling the three is the same philosophy as the
 * essential-appliance top-up: a schema bump is not an excuse to take somebody's
 * restaurant away.
 */
export const BACKFILL_RECIPES: string[] = ["salad", "fries", "pizza"];

/**
 * How likely each tier is to be offered.
 *
 * Read like `STOCK_WEIGHT`: early mornings are mostly simple dishes, and
 * **pizza arrives late and rare, as the event it deserves to be**. A tier is a
 * claim about how much kitchen a dish demands, not about its reward — the two
 * correlate, and where they do not, the tier is what the morning goes by.
 */
export const TIER_WEIGHT: Record<number, number> = { 1: 5, 2: 2, 3: 1 };

/**
 * What a card costs, by the same tier the roll is weighted by.
 *
 * The fee is **flat**, and the equipment the kitchen lacks still comes free on
 * top of it — so a card is how a room gets its *first* fryer, and the shop is
 * where it buys the second. The two are not competing to sell you an oven; they
 * are selling different things, and a card is the only one that also tells you
 * why you wanted it.
 *
 * A tier-1 fee is about one good day's takings, which is what puts the first
 * affordable card on the morning of day 2 — where the old `FIRST_CARD_DAY`
 * used to put it by decree.
 *
 * Not in `appliances.ts` with the other prices: those are what a *thing* costs,
 * and every card is the same object. What varies is the dish on it.
 */
export const TIER_FEE: Record<number, number> = { 1: 30, 2: 60, 3: 100 };

/**
 * What a card costs, by tier.
 *
 * Takes the tier rather than the recipe so that this stays a data module
 * nothing else in `data/` has to import. Four callers ask it — the price on the
 * pallet, the refund a disconnect pays, the money a save writes for a card
 * somebody was holding, and the tests — and one answer is the point.
 */
export function cardFee(tier: number): number {
  return TIER_FEE[tier] ?? 0;
}

/**
 * Roughly what share of the first service day's orders the newest dish takes.
 *
 * First contact under deliberate repetition. A recipe unlocked in the morning
 * and then seen twice in an hour is a recipe nobody learns; half of one day is
 * enough to make the mistakes worth making, and it is over by the next morning.
 */
export const LAUNCH_SHARE = 0.5;
