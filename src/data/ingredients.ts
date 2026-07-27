import type { IngredientId, ProcessId } from "../sim/types";

export type Shape = "box" | "sphere" | "disc" | "plate";

export type Ingredient = {
  id: IngredientId;
  name: string;
  color: number;
  shape: Shape;
  /** Containers hold other items (currently only the plate). */
  container?: boolean;
};

export const INGREDIENTS: Record<IngredientId, Ingredient> = {
  tomato: { id: "tomato", name: "Tomato", color: 0xd83b2c, shape: "sphere" },
  lettuce: { id: "lettuce", name: "Lettuce", color: 0x5fbf4a, shape: "sphere" },
  cheese: { id: "cheese", name: "Cheese", color: 0xf2c24b, shape: "box" },
  flour: { id: "flour", name: "Flour", color: 0xf0e6d2, shape: "box" },
  water: { id: "water", name: "Water", color: 0x7fb2d9, shape: "sphere" },
  dough: { id: "dough", name: "Dough", color: 0xe8d5a8, shape: "sphere" },
  potato: { id: "potato", name: "Potato", color: 0xc08b4a, shape: "sphere" },

  pizza: { id: "pizza", name: "Pizza", color: 0xe0a55a, shape: "disc" },
  salad: { id: "salad", name: "Salad", color: 0x7fc95e, shape: "disc" },
  fries: { id: "fries", name: "Fries", color: 0xf0b93b, shape: "box" },

  plate: { id: "plate", name: "Plate", color: 0xf2f2f2, shape: "plate", container: true },
};

/**
 * Processes are cosmetic-ish tags used for exact matching. `burnt` is special:
 * any transform with `burnAfter` appends it, and nothing accepts a burnt item
 * except the bin.
 */
export const PROCESSES: Record<ProcessId, { name: string; color: number }> = {
  chopped: { name: "Chopped", color: 0xffffff },
  crushed: { name: "Crushed", color: 0xb32b1c },
  kneaded: { name: "Kneaded", color: 0xffffff },
  sauced: { name: "Sauced", color: 0xd83b2c },
  topped: { name: "Topped", color: 0xf2c24b },
  baked: { name: "Baked", color: 0xb06a2c },
  fried: { name: "Fried", color: 0xd79b2e },
  burnt: { name: "Burnt", color: 0x2b2b2b },
};

export const BURNT: ProcessId = "burnt";

export function ingredient(id: IngredientId): Ingredient {
  const found = INGREDIENTS[id];
  if (!found) throw new Error(`Unknown ingredient: ${id}`);
  return found;
}
