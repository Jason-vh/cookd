import { ARM_SECONDS } from "../../data/progression";
import { RECIPE_BY_ID } from "../../data/recipes";
import { cardStands, deliveryLabel, missingFor, unlockRecipe } from "../cards";
import { targetAppliance } from "../queries";
import type { Appliance, Player, World } from "../types";
import { log, playerById } from "../world";

/**
 * Choosing a card: arm, then confirm.
 *
 * The same two-press shape as the pause menu's reset, for the same reason —
 * `Grab` is the button that means "yes" everywhere else in the game, and a
 * mistimed press should not quietly decide what kind of restaurant this is for
 * everybody. Arming is visible (the card lifts) and it says who is holding it,
 * so a second player watching knows a choice is being made before it is made.
 *
 * It clears on **walking away**, on the card leaving, and after
 * `ARM_SECONDS` — an armed choice left alone must not still be one press from
 * happening when somebody comes back to it.
 *
 * Anyone may choose. That is the same trust model as the money, the layout and
 * the reset: this is a shared kitchen, and the log is what makes it accountable
 * rather than a permission system nobody asked for.
 */
export function cardSystem(world: World, dt: number): void {
  // Only ever a decision in the morning. A stand cannot be armed during
  // service — `buildGrab` is not running — but a day can *open* while a card is
  // lifted, and that card has to come back down with the rest of them.
  for (const stand of cardStands(world)) {
    if (stand.armedBy === null) continue;
    if (world.phase !== "build" || stand.card === null) {
      disarm(stand);
      continue;
    }
    const player = playerById(world, stand.armedBy);
    // Facing it is what keeps the arming alive: turning to look at the other
    // card is a change of mind, and so is walking off.
    if (!player || targetAppliance(world, player)?.id !== stand.id) {
      disarm(stand);
      continue;
    }
    stand.armTime -= dt;
    if (stand.armTime <= 0) disarm(stand);
  }
}

/**
 * Face a card, press `Grab`. Press it again to take it.
 *
 * Called from `buildGrab`, before anything else can get a word in, exactly as
 * the stall is: a stand is immovable, so every rule below it would refuse the
 * grab in silence.
 */
export function useCardStand(world: World, player: Player, stand: Appliance): void {
  if (world.phase !== "build") return; // the morning is the decision
  const recipe = stand.card === null ? null : RECIPE_BY_ID.get(stand.card);
  if (!recipe) return;

  if (stand.armedBy !== player.id) {
    // Only one card can be lifted at a time. Arming the second is a change of
    // mind about the first, and the first has to be seen to drop.
    for (const other of cardStands(world)) disarm(other);
    stand.armedBy = player.id;
    stand.armTime = ARM_SECONDS;
    const needs = deliveryLabel(missingFor(world, recipe));
    log(world, `${who(player)} is considering ${recipe.name}…${needs ? ` (needs: ${needs})` : ""}`);
    return;
  }

  // Confirmed. `unlockRecipe` refuses out loud if the kitchen has nowhere to
  // put what the card owes it, and leaves the card armed to be tried again.
  unlockRecipe(world, recipe, who(player), stand.tile);
}

function disarm(stand: Appliance): void {
  stand.armedBy = null;
  stand.armTime = 0;
}

/** Who did it. Local players have no name; the kitchen still has to say something. */
function who(player: Player): string {
  return player.name || "Chef";
}
