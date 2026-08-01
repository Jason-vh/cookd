import type { ApplianceKind } from "./appliances";

/**
 * The ledger: what the stall stocks, and what it pays back.
 *
 * Prices themselves are **not** here — they are the `price` column in
 * `appliances.ts`, so adding an appliance stays one row. What lives here is
 * everything that is about the *shop* rather than about the goods: how many
 * slots there are, how likely each kind is to appear in one, what a sale pays,
 * and the rent.
 *
 * This is content: plain data, expect to iterate on every number in it.
 */

/**
 * Squares in the delivery. Matches the number of `$` tiles the level puts down.
 *
 * Four, and two of them are spoken for: one is promised to something the
 * kitchen is short of, and one holds a [recipe card](../../docs/the-menu.md).
 * That leaves two wildcards, which is what stops a morning with two guarantees
 * in it from being a morning with no surprise in it.
 */
export const STALL_SLOTS = 4;

/**
 * The first morning anything is delivered at all.
 *
 * Day one gets nothing: no goods, no card, and no pallets. A kitchen opens with
 * $0, so a day-one delivery is four things it cannot buy — the first thing a
 * room would ever learn about the shop would be a refusal — and it is four
 * things to walk out and look at on the one morning when everything worth
 * knowing is inside the walls.
 *
 * It is also simply true: a delivery arrives because there is a restaurant to
 * deliver to, and on the first morning there is not one yet. The same shape as
 * the two rent-free days, for the same reason — the days a room has no say in
 * are the days it is neither charged nor sold to.
 *
 * Asked by the roll *and* by the renderer, so "nothing was delivered" is one
 * fact rather than an empty slot the drawing code has to infer.
 */
export const FIRST_DELIVERY_DAY = 2;

/**
 * What a sale pays, as a fraction of list price.
 *
 * Half is enough that selling a mistake is a real option and not enough that
 * churn is a strategy. There is no confirmation dialog on a purchase precisely
 * because this exists: buying the wrong thing costs half of it, which is a
 * price rather than a punishment.
 */
export const SELLBACK = 0.5;

/**
 * How often each kind turns up in a slot.
 *
 * `Record<ApplianceKind, number>` rather than a partial map, so adding an
 * appliance is a build error here naming the key — the alternative is a new
 * kind that silently never appears in a shop, which is the quietest possible
 * way for content to not exist. `0` means "not sold", and saying so is the
 * point.
 *
 * Three tiers, and they are about *rhythm* rather than about price: staples
 * turn up constantly so there is always something affordable, the middle band
 * is a regular decision, and throughput is rare enough that an oven in a slot
 * is an event you rearrange your morning around.
 *
 * These are the weights a *settled* kitchen sees. Early on the scarcity
 * guarantee below reserves one slot in three, and on a lean kitchen the middle
 * band is most of what qualifies — so the first few mornings offer boards and
 * sinks at roughly the rate they offer counters, and only once the kitchen owns
 * two of everything do the tiers come through as written. Measured, that is
 * 12% each across the board on day one, settling to 17/7/4. The shop teaching
 * you what you are missing and *then* becoming a rhythm is the better
 * behaviour, and it falls out rather than being arranged.
 */
export const STOCK_WEIGHT: Record<ApplianceKind, number> = {
  // Not goods: the level's own furniture.
  stall: 0,
  cards: 0,
  sign: 0,
  hatch: 0,

  // Staples.
  counter: 5,
  crate: 5,
  table: 5,

  // The middle band.
  board: 3,
  sink: 2,
  plates: 2,
  bin: 2,

  // Throughput.
  fryer: 1,
  oven: 1,

  // Upgrades: as rare as throughput, and several days dearer. A slot holding
  // one is a thing to plan a week around rather than a thing to buy today,
  // which is the whole reason it is worth seeing before it is affordable.
  steel_board: 1,
  bell_oven: 1,
};

/**
 * The stall guarantees one slot holds a kind the kitchen owns fewer than this
 * many of — and never an **upgrade**, which is a luxury rather than a gap.
 * A kitchen owns none of them for a long time and is not missing anything.
 *
 * Three duds is a shop a player stops walking to, and a shop nobody walks to is
 * a feature that has quietly stopped existing. Two is the threshold because one
 * of a thing is the interesting case: one board, one sink, one bin — a kitchen
 * where every job has exactly one place to happen is a kitchen with an obvious
 * next purchase, and the stall's job is to be holding it.
 *
 * The promised slot is still rolled **by weight**, not evenly. Evenly was
 * simpler and wrong: a lean kitchen owns one of nearly everything, so the
 * shortlist is most of the catalogue, and picking evenly from it made a fryer
 * exactly as likely as a counter — throughput turned up on four mornings in
 * six. The guarantee is about relevance, and has no business overriding rarity.
 */
export const SCARCE_BELOW = 2;

// --- the rent ------------------------------------------------------------------

/**
 * The first day the landlord wants paying.
 *
 * Two mornings free, and they are the two a kitchen has no say in: day one is
 * one dish and whatever the level handed you, and day two is the first recipe
 * card. Charging before a room has made a single decision would be charging it
 * for the tutorial.
 */
export const RENT_FROM_DAY = 3;

/**
 * What the first rent day costs, and what each day after it adds.
 *
 * Half a table to begin with, against a day that comfortably takes two or three
 * of them. The step is deliberately shallower than the takings curve — parties,
 * shorter arrival gaps and dearer dishes all arrive on their own — so rent is a
 * floor under the economy rather than a race with it. It is meant to be the
 * reason a kitchen cannot afford the oven *yet*, and only a lose condition for
 * a room that has stopped serving anybody.
 */
export const RENT_BASE = 20;
export const RENT_STEP = 5;

/** What closing day `day` costs. Zero before the landlord starts asking. */
export function rentFor(day: number): number {
  if (day < RENT_FROM_DAY) return 0;
  return RENT_BASE + RENT_STEP * (day - RENT_FROM_DAY);
}
