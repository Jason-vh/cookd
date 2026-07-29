import type { Item, ItemSpec, World } from "./types";

/**
 * Canonical string key for an item / item spec. Matching is exact: same base,
 * same processes in the same order. This keeps recipe resolution to a single
 * Map lookup and makes "wrong order of steps" a real (intended) failure mode.
 */
export function specKey(spec: ItemSpec | Item): string {
  return spec.processes.length === 0 ? spec.base : `${spec.base}|${spec.processes.join(",")}`;
}

export function makeItem(world: World, spec: ItemSpec): Item {
  return {
    id: world.nextId++,
    base: spec.base,
    processes: [...spec.processes],
    contents: [],
  };
}

/**
 * A type predicate, not just a boolean: "is this a plate" is nearly always
 * asked in order to *do* something to it, and callers were left re-checking
 * for null a second time to convince the compiler of what they had just
 * established.
 */
export function isPlate(item: Item | null): item is Item {
  return item !== null && item.base === "plate";
}

export function isBurnt(item: Item | null): boolean {
  return item !== null && item.processes.includes("burnt");
}

/** A plate a customer has eaten off. Useless until it has been washed. */
export function isDirty(item: Item | null): boolean {
  return item !== null && item.processes.includes("dirty");
}

/** Flattened list of items (an item plus anything it contains). */
export function* walkItems(item: Item | null): Generator<Item> {
  if (!item) return;
  yield item;
  for (const child of item.contents) yield* walkItems(child);
}
