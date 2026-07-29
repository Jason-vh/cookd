import type { IngredientId, ProcessId } from "../sim/types";

/**
 * Everything the game can hold, and what to call it.
 *
 * Deliberately only the name. Each row used to carry `color`, `shape` and
 * `container` as well, and not one of them was read anywhere: colour moved to
 * `render/palette.ts`, shape was superseded by the sculpted models in
 * `render/models.ts`, and `container` was set once on the plate while
 * `isPlate()` hardcoded `base === "plate"` regardless.
 *
 * Three dead columns is not just clutter — it is three decisions demanded of
 * whoever adds an ingredient, none of which do anything, in a file whose stated
 * purpose is that adding content should be easy. If a row ever needs a field
 * again, adding it back is a line.
 */
export type Ingredient = {
  id: IngredientId;
  /** Shown on crate labels and in the HUD's item names. */
  name: string;
};

export const INGREDIENTS: Record<IngredientId, Ingredient> = {
  tomato: { id: "tomato", name: "Tomato" },
  lettuce: { id: "lettuce", name: "Lettuce" },
  cheese: { id: "cheese", name: "Cheese" },
  flour: { id: "flour", name: "Flour" },
  water: { id: "water", name: "Water" },
  dough: { id: "dough", name: "Dough" },
  potato: { id: "potato", name: "Potato" },

  pizza: { id: "pizza", name: "Pizza" },
  salad: { id: "salad", name: "Salad" },
  fries: { id: "fries", name: "Fries" },
  bread: { id: "bread", name: "Bread" },
  cheesefries: { id: "cheesefries", name: "Cheese Fries" },
  cheesybread: { id: "cheesybread", name: "Cheesy Bread" },
  bakedpotato: { id: "bakedpotato", name: "Baked Potato" },

  plate: { id: "plate", name: "Plate" },
};

/**
 * Processes are tags used for exact item matching, and that is all they are —
 * a set, not a table. They carried a display name and a colour that nothing
 * read; item names are built from the tag itself in `itemLabel`.
 *
 * `burnt` is special: any transform with `burnAfter` appends it, and nothing
 * accepts a burnt item except the bin.
 */
export const PROCESSES: Record<ProcessId, true> = {
  chopped: true,
  crushed: true,
  kneaded: true,
  sauced: true,
  topped: true,
  /** A second helping of cheese, over an already-topped pizza. */
  loaded: true,
  baked: true,
  fried: true,
  burnt: true,
  dirty: true,
};

export const BURNT: ProcessId = "burnt";
/** What a customer leaves behind. Washing it is the plate stack's job (for now). */
export const DIRTY: ProcessId = "dirty";

export function ingredient(id: IngredientId): Ingredient {
  const found = INGREDIENTS[id];
  if (!found) throw new Error(`Unknown ingredient: ${id}`);
  return found;
}
