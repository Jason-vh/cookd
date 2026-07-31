import { beginDay, callLastOrders } from "../day";
import type { Player, World } from "../types";

/**
 * The sign in the door, and the whole of opening a restaurant.
 *
 * Opening a day used to be a keypress with nothing in the room behind it: the
 * one verb in the game that was not a chef doing something to an object. The
 * caravan taught the lesson — *a shop is a place, not a menu* — and this is the
 * same lesson applied to the day itself. Face the sign, press `Grab`, and the
 * restaurant is open. There is nothing else to know.
 *
 * **Zero new verbs**, exactly like the caravan's hatch and its boards: one immovable
 * piece of level furniture that answers a grab on its own terms, routed to
 * from both halves of `interaction.ts` before any other rule can refuse it.
 *
 * It reads both ways round, which is the reason it is a *sign* and not a
 * button. In the morning it says CLOSED and turning it opens the day; during
 * service it says OPEN and turning it calls last orders. One object, two
 * directions, and the state of the restaurant legible from across the room —
 * the same grammar as the caravan's hatch.
 */
export function useSign(world: World, player: Player): void {
  // A guess does not get to open the restaurant. The online client runs its own
  // chefs ahead of the server and replays every unacknowledged tick, so a
  // predicted flip would swing the phase back and forth twenty times a second
  // — and the phase is what decides which half of `interaction.ts` a held grab
  // is even talking to. See the note on `predict`.
  if (world.predicting) return;

  const by = player.name || "Chef";
  if (world.phase === "build") {
    // `beginDay` refuses out loud while somebody is carrying an appliance:
    // service has no way to put one down, so opening under a held oven would
    // strand them holding it all day.
    beginDay(world, by);
    return;
  }
  callLastOrders(world, by);
}
