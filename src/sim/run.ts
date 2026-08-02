import type { RunRecord, World } from "./types";

/**
 * A run: one life of a kitchen, and the mark it leaves on the room.
 *
 * The [rent](../../docs/the-shop.md#the-rent) gave the game an end, and ending
 * was all it gave it. A repossessed kitchen could only be reset, a reset put
 * back a kitchen identical to the one the first run started in, and the twelve
 * days in between left nothing behind at all — so "again" was a button rather
 * than a reason. This is the missing half, and it is deliberately one line of
 * state: **how far this room has ever got.**
 *
 * ## A run ends when somebody says so
 *
 * Not at eviction. Being repossessed stops the sign opening another day, and
 * that is all it does — the kitchen stands, the numbers stand, and the card
 * on screen is the only thing saying the run is over. So the record is filed
 * on **reset**, which is the moment a room actually starts again, and until
 * then the mark on the wall belongs to an *earlier* run.
 *
 * That ordering is what lets the closed-down card ask an honest question. At
 * the moment it is read, `world.best` is still the thing the run was trying to
 * beat, so "did we?" is a comparison rather than a flag somebody has to
 * remember to set.
 *
 * It also means a reset from a *living* kitchen files that run too, which is
 * right: a room wiped on day nine got nine days out of the kitchen, whatever
 * the reason it was wiped.
 *
 * ## Days, then takings
 *
 * Days survived is what the rent asks of a kitchen, so it is the score. Money
 * breaks the tie, and it is `takings` rather than the till: what is *left* at
 * the end is what nobody spent, and a room that put every penny into a good
 * kitchen should not read as poorer than one that bought nothing.
 */

/**
 * The days this run has actually finished. A room nobody opened has none.
 *
 * `world.day` is the day *in hand* — the one being served, or the one the
 * morning is preparing for — and it moves at closing time. So the count of days
 * behind it is one less, in both phases, without anybody having to ask which
 * one it is.
 */
export function daysPlayed(world: World): number {
  return Math.max(0, world.day - 1);
}

/**
 * Is the run in hand better than the mark on the wall?
 *
 * The rule itself, exported because two callers need it and they must never
 * disagree: the one that *files* a record, and the closed-down card that tells
 * a player whether the last hour was worth anything. A card whose congratulation
 * was computed separately from the record it congratulates is a card that will
 * one day lie.
 *
 * A run nobody ever opened beats nothing, including a room with no record at
 * all: zero days is not an achievement to be the first to hold.
 */
export function beatsRecord(world: World): boolean {
  const days = daysPlayed(world);
  if (days === 0) return false;
  if (world.best === null) return true;
  return days === world.best.days ? world.takings > world.best.takings : days > world.best.days;
}

/**
 * The record this room should carry into its next run.
 *
 * Returns the existing one unchanged when the finished run did not beat it, so
 * the caller has a single value to keep either way.
 */
export function fileRun(world: World): RunRecord | null {
  if (!beatsRecord(world)) return world.best;
  return { run: world.run, days: daysPlayed(world), takings: world.takings };
}

/**
 * Has this run just gone past the mark, on the day that has closed?
 *
 * Asked once, on the closing that does it, because the point of it is the
 * moment: a line in the log the evening you overtake your best run is worth
 * more than a counter on screen all week saying how far away it is.
 */
export function passedRecord(world: World): boolean {
  return world.best !== null && daysPlayed(world) === world.best.days + 1;
}
