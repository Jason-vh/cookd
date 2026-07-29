/**
 * How a kitchen's menu grows: the cards, their cadence, and their weights.
 *
 * Deliberately not in `economy.ts`, whose subject is the *shop* — what a slot
 * holds, what a sale pays, what rent costs. The card stand looks like a shop
 * and is not one: nothing here has a price, and the only currency is the day
 * number. Two systems, two tables.
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

/** The morning the first card stand appears. */
export const FIRST_CARD_DAY = 2;

/** And every this-many mornings after it: 2, 5, 8, 11… */
export const CARD_INTERVAL = 3;

/**
 * Cards on the stand. Matches the number of `?` tiles the level puts down.
 *
 * Two, and it is a **choice between them** rather than two things to collect:
 * picking one takes the offer with it. That is what makes the stand a decision
 * about what kind of restaurant this is, and it is why an unpicked pair is
 * allowed to simply leave at open — a room may consolidate on purpose.
 */
export const CARD_SLOTS = 2;

/**
 * How likely each tier is to be offered.
 *
 * Read like `STOCK_WEIGHT`: early mornings are mostly simple dishes, and
 * **pizza arrives late and rare, as the event it deserves to be**. A tier is a
 * claim about how much kitchen a dish demands, not about its reward — the two
 * correlate, and where they do not, the tier is what the stand goes by.
 */
export const TIER_WEIGHT: Record<number, number> = { 1: 5, 2: 2, 3: 1 };

/**
 * How long an armed card stays armed, in seconds.
 *
 * The same number and the same reason as the pause menu's reset: an armed
 * choice left alone should not still be one press from happening when somebody
 * comes back to it.
 */
export const ARM_SECONDS = 4;

/**
 * Roughly what share of the first service day's orders the newest dish takes.
 *
 * First contact under deliberate repetition. A recipe unlocked in the morning
 * and then seen twice in an hour is a recipe nobody learns; half of one day is
 * enough to make the mistakes worth making, and it is over by the next morning.
 */
export const LAUNCH_SHARE = 0.5;
