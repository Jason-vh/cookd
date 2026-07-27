import { RECIPES, RECIPE_BY_ID } from "../../data/recipes";
import type { World } from "../types";
import { log, random } from "../world";

const MAX_ACTIVE_ORDERS = 5;

/** Orders arrive faster each day; this is the whole difficulty curve for now. */
function orderInterval(world: World): number {
  const base = Math.max(6, 14 - world.day * 1.5);
  return base + random(world) * 4;
}

export function orderSystem(world: World, dt: number): void {
  if (world.phase !== "service") return;

  for (let i = world.orders.length - 1; i >= 0; i--) {
    const order = world.orders[i]!;
    order.remaining -= dt;
    if (order.remaining <= 0) {
      world.orders.splice(i, 1);
      world.lost++;
      log(world, `${RECIPE_BY_ID.get(order.recipeId)?.name ?? order.recipeId} walked out`);
    }
  }

  world.nextOrderIn -= dt;
  if (world.nextOrderIn > 0) return;
  world.nextOrderIn = orderInterval(world);
  if (world.orders.length >= MAX_ACTIVE_ORDERS) return;

  // Early days only serve the simpler recipes.
  const pool = RECIPES.slice(0, Math.min(RECIPES.length, 1 + world.day));
  const recipe = pool[Math.floor(random(world) * pool.length)] ?? RECIPES[0]!;
  world.orders.push({
    id: world.nextId++,
    recipeId: recipe.id,
    remaining: recipe.patience,
    patience: recipe.patience,
  });
}
