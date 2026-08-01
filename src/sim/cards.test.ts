import { describe, expect, test } from "bun:test";
import { applianceDef } from "../data/appliances";
import { FIRST_DELIVERY_DAY } from "../data/economy";
import { STARTING_RECIPES, cardFee } from "../data/progression";
import { LEVEL } from "../data/level";
import { RECIPES, RECIPE_BY_ID } from "../data/recipes";
import { Host } from "../game/host";
import { restore, snapshot } from "../save";
import { missingFor, unlockedRecipes } from "./cards";
import { seatsAround } from "./pathing";
import { restockStall, stallSlots } from "./shop";
import { beginDay, endDay } from "./day";
import { step } from "./step";
import type { Appliance, ApplianceKind, PlayerInput, Vec2, World } from "./types";
import { createWorld, emptyInput, nearestFreeTile, removePlayer } from "./world";

/**
 * The menu: how a kitchen grows it, and what that costs.
 *
 * Driven the way a player drives it — stand in front of the pallet, press
 * `Grab`, carry it inside, press `Grab` again — because the whole claim of a
 * card is that it is a **good**: the shop's own grammar applied to progression,
 * with no verb, no screen and no timer of its own. A test that called
 * `unlockRecipe` directly would be testing a different feature from the one
 * that shipped.
 */

/** A kitchen in the morning of `day`, with nobody due through the door. */
function morning(day = 1): World {
  const world = createWorld(LEVEL, 1);
  world.nextArrivalIn = Infinity;
  // The day is moved through `endDay` rather than assigned, so everything a
  // morning is supposed to do — landing the delivery, rolling the card — has
  // actually happened, exactly as it does in a played game.
  while (world.day < day) {
    beginDay(world);
    endDay(world);
  }
  return world;
}

function idle(): PlayerInput[] {
  return [emptyInput()];
}

function press(world: World, button: "grab"): void {
  const inputs = idle();
  inputs[0]![button] = true;
  step(world, inputs);
  step(world, idle());
}

/** Stand on the paving beside a square, facing it. */
function faceGoods(world: World, tile: Vec2): void {
  const from = seatsAround(world, tile)[0]!;
  const player = world.players[0]!;
  player.pos = { x: from.x + 0.5, y: from.y + 0.5 };
  player.prevPos = { ...player.pos };
  player.facing = { x: tile.x - from.x, y: tile.y - from.y };
}

/** Face a square and press grab: buys from it, or puts down onto it. */
function use(world: World, tile: Vec2): void {
  faceGoods(world, tile);
  press(world, "grab");
}

/** The square holding this morning's recipe card, if there is one. */
function cardSlot(world: World): Appliance | null {
  return stallSlots(world).find((slot) => slot.offer?.recipe !== undefined) ?? null;
}

/** The dish on offer this morning, or null. */
function cardOn(world: World): string | null {
  return cardSlot(world)?.offer?.recipe ?? null;
}

/** Force a square to hold a particular card, for tests about a specific dish. */
function offer(world: World, recipeId: string): Appliance {
  const slot = stallSlots(world)[0]!;
  slot.offer = { kind: "cards", source: null, recipe: recipeId };
  slot.taken = null;
  return slot;
}

/** The card in somebody's hands, if there is one. */
function carriedCard(world: World): Appliance | null {
  return [...world.appliances.values()].find((a) => a.kind === "cards") ?? null;
}

/** Buy the card standing on `slot` and carry it in to a free interior tile. */
function takeCard(world: World, slot: Appliance): void {
  use(world, slot.tile);
  const home = nearestFreeTile(world, world.door);
  if (home) use(world, home);
}

function counts(world: World, kind: ApplianceKind): number {
  return [...world.appliances.values()].filter((a) => a.kind === kind).length;
}

function crateBases(world: World): string[] {
  return [...world.appliances.values()]
    .filter((a) => a.kind === "crate" && a.source)
    .map((a) => a.source!.base)
    .sort();
}

describe("a kitchen starts with one dish", () => {
  test("the menu is the salad, and nothing else", () => {
    const world = morning();
    expect(world.unlocked).toEqual(STARTING_RECIPES);
    expect(unlockedRecipes(world).map((r) => r.name)).toEqual(["Garden Salad"]);
  });

  test("and everyone who walks in orders it", () => {
    // The order pool *is* the menu. There is no day-slice any more, so a fresh
    // room cannot be asked for something it has never seen.
    const world = morning();
    world.nextArrivalIn = 0;
    beginDay(world);
    for (let i = 0; i < 3000; i++) step(world, idle());
    expect(world.customers.length).toBeGreaterThan(0);
    for (const customer of world.customers) expect(customer.recipeId).toBe("salad");
  });

  test("the level ships nothing the salad does not need", () => {
    const world = morning();
    expect(counts(world, "fryer")).toBe(0);
    expect(counts(world, "oven")).toBe(0);
    expect(crateBases(world)).toEqual(["lettuce", "tomato"]);
  });
});

describe("the morning's card", () => {
  test("day one is delivered nothing at all", () => {
    // No goods, no card, no pallets. A kitchen with $0 has nothing to do out
    // here, and the one morning everything worth knowing is inside the walls
    // is not the morning to put four things it cannot buy outside them.
    const world = morning(1);
    expect(world.money).toBe(0);
    for (const slot of stallSlots(world)) expect(slot.offer).toBeNull();
  });

  test("and every morning after it holds one, on its own square", () => {
    for (let day = FIRST_DELIVERY_DAY; day <= 8; day++) {
      const world = morning(day);
      const cards = stallSlots(world).filter((slot) => slot.offer?.recipe !== undefined);
      expect(cards).toHaveLength(1);
      // The rest of the delivery is goods, so a card never costs the morning
      // its shop.
      expect(stallSlots(world).filter((slot) => slot.offer !== null).length).toBeGreaterThan(1);
    }
  });

  test("it stands on paving, where nothing may be built", () => {
    const world = morning(2);
    const slot = cardSlot(world)!;
    expect(world.tiles[slot.tile.y * world.width + slot.tile.x]?.placeable).toBe(false);
  });

  test("never something already on the menu", () => {
    const world = morning(2);
    world.unlocked = ["salad", "fries", "bread"];
    for (let day = 2; day < 40; day++) {
      world.day = day;
      restockStall(world);
      const card = cardOn(world);
      if (card) expect(world.unlocked).not.toContain(card);
    }
  });

  test("respects prerequisites: no cheese fries before fries", () => {
    const world = morning(2);
    for (let day = 2; day < 60; day++) {
      world.day = day;
      restockStall(world);
      const card = cardOn(world);
      const prereq = card === null ? undefined : RECIPE_BY_ID.get(card)?.prereq;
      if (prereq) expect(world.unlocked).toContain(prereq);
    }
  });

  test("offers simple dishes far more often than pizza", () => {
    // The tier weights, observed rather than asserted row by row: what matters
    // is the rhythm they produce — pizza arrives late and rare, as the event it
    // deserves to be.
    const seen = new Map<string, number>();
    for (let seed = 1; seed <= 400; seed++) {
      const world = createWorld(LEVEL, 0, seed);
      world.day = 2;
      restockStall(world);
      const card = cardOn(world);
      if (card) seen.set(card, (seen.get(card) ?? 0) + 1);
    }
    const tierOne = RECIPES.filter((r) => r.tier === 1 && !r.prereq).reduce(
      (total, r) => total + (seen.get(r.id) ?? 0),
      0,
    );
    expect(tierOne).toBeGreaterThan((seen.get("pizza") ?? 0) * 3);
    // ...and rare is not never: the whole library stays reachable.
    expect(seen.get("pizza")).toBeGreaterThan(0);
  });

  test("an exhausted library is four squares of goods", () => {
    const world = morning(2);
    world.unlocked = RECIPES.map((recipe) => recipe.id);
    restockStall(world);
    expect(cardOn(world)).toBeNull();
    for (const slot of stallSlots(world)) expect(slot.offer).not.toBeNull();
  });

  test("two hosts on one seed are offered the same card, several mornings running", () => {
    // The same guarantee the rest of the delivery has, and for the same reason:
    // the roll must come from the seed and the day, never from the live stream
    // that arrivals and seating consume at their own pace.
    const a = new Host();
    const b = new Host();

    for (let day = 1; day <= 10; day++) {
      expect(cardOn(a.world)).toEqual(cardOn(b.world));
      // Only one of them plays.
      beginDay(a.world);
      for (let i = 0; i < 600; i++) step(a.world, {});
      endDay(a.world);
      beginDay(b.world);
      endDay(b.world);
    }
    // ...and it was a real offer, not two empty squares agreeing.
    expect(cardOn(a.world)).not.toBeNull();
  });
});

describe("buying a card", () => {
  test("costs its tier, and arrives in your hands rather than on the menu", () => {
    const world = morning(2);
    const slot = offer(world, "fries");
    world.money = 500;

    use(world, slot.tile);
    expect(world.money).toBe(500 - cardFee(RECIPE_BY_ID.get("fries")!.tier));
    // Bought, not spent: the dish joins the menu when the card is set down.
    expect(world.unlocked).not.toContain("fries");
    expect(carriedCard(world)?.card).toBe("fries");
    expect(world.players[0]!.carriedAppliance).toBe(carriedCard(world)!.id);
  });

  test("a kitchen that cannot afford it is refused, out loud, and charged nothing", () => {
    const world = morning(2);
    const slot = offer(world, "pizza");
    world.money = 5;

    use(world, slot.tile);
    expect(world.money).toBe(5);
    expect(carriedCard(world)).toBeNull();
    expect(world.events.some((e) => e.text.startsWith("Need $"))).toBe(true);
  });

  test("putting it back on its pallet is a full refund, and no menu change", () => {
    const world = morning(2);
    const slot = offer(world, "fries");
    world.money = 500;

    use(world, slot.tile);
    use(world, slot.tile);
    expect(world.money).toBe(500);
    expect(world.unlocked).not.toContain("fries");
    expect(carriedCard(world)).toBeNull();
  });

  test("a kitchen with no floor left may still buy one", () => {
    // The card occupies no tile, and what it is about to deliver is the floor's
    // problem rather than the purchase's. Asking a card for a free tile would
    // refuse the one thing that can dig a room out.
    const world = morning(2);
    const slot = offer(world, "cheesybread");
    world.money = 500;
    for (let i = 0; i < world.applianceAt.length; i++) {
      if (world.tiles[i]?.placeable) world.applianceAt[i] = -1;
    }
    use(world, slot.tile);
    expect(carriedCard(world)).not.toBeNull();
  });
});

describe("setting a card down", () => {
  test("puts the dish on the menu, with exactly the missing kit around it", () => {
    const world = morning(2);
    const slot = offer(world, "fries");
    world.money = 500;
    expect(missingFor(world, RECIPE_BY_ID.get("fries")!)).toEqual({
      kinds: ["fryer"],
      crates: ["potato"],
    });

    takeCard(world, slot);

    expect(world.unlocked).toContain("fries");
    expect(counts(world, "fryer")).toBe(1);
    expect(crateBases(world)).toEqual(["lettuce", "potato", "tomato"]);
    // The card itself is gone: it is spent where it is put down.
    expect(carriedCard(world)).toBeNull();
    expect(world.players[0]!.carriedAppliance).toBeNull();

    // Never the door, never the patio: everything delivered is somewhere the
    // game is allowed to put things.
    for (const appliance of world.appliances.values()) {
      if (!applianceDef(appliance.kind).movable) continue;
      const tile = world.tiles[appliance.tile.y * world.width + appliance.tile.x];
      expect(tile?.placeable).toBe(true);
      expect(tile?.door).toBe(false);
    }
    // Said out loud, item by item: a delivery nobody can see is a kitchen that
    // has quietly rearranged itself.
    expect(world.events.some((e) => e.text === "Delivered: Fryer")).toBe(true);
    expect(world.events.some((e) => e.text === "Delivered: Potato crate")).toBe(true);
  });

  test("the log says who did it", () => {
    const world = morning(2);
    world.players[0]!.name = "Ada";
    world.money = 500;
    takeCard(world, offer(world, "fries"));
    expect(world.events.some((e) => e.text === "Ada added Fries to the menu")).toBe(true);
  });

  test("nothing the kitchen already owns", () => {
    // A room that took the fries card already has the fryer and the potato
    // crate. Cheese fries are fries plus chopped cheese, so it is owed exactly
    // one crate — not a second fryer.
    const world = morning(2);
    world.money = 500;
    takeCard(world, offer(world, "fries"));
    takeCard(world, offer(world, "cheesefries"));

    expect(counts(world, "fryer")).toBe(1);
    expect(crateBases(world)).toEqual(["cheese", "lettuce", "potato", "tomato"]);
  });

  test("one oven for a dish that bakes, however many bakes it takes", () => {
    const world = morning(2);
    world.money = 500;
    takeCard(world, offer(world, "bread"));
    expect(counts(world, "oven")).toBe(1);
    expect(crateBases(world)).toEqual(["flour", "lettuce", "tomato", "water"]);
  });

  test("never an upgrade, however cheap the card", () => {
    // The one rule standing between a $100 card and a $320 bell oven. It reads
    // as a footnote in `applianceForStation` and it is load-bearing now that a
    // card is the ordinary way to get your first of a station.
    const world = morning(2);
    world.money = 500;
    for (const recipe of RECIPES) {
      const delivery = missingFor(world, recipe);
      for (const kind of delivery.kinds) {
        expect(applianceDef(kind).upgrades).toBeNull();
      }
    }
  });

  test("a kitchen with nowhere to put it is refused, and the card stays in hand", () => {
    // The pathological case. Dropping the fryer on the floor would leave a menu
    // the room cannot cook and cannot diagnose, so the placement does not
    // happen — and the money is still recoverable, because the card is still
    // being carried.
    const world = morning(2);
    const slot = offer(world, "fries");
    world.money = 500;
    use(world, slot.tile);

    const home = nearestFreeTile(world, world.door)!;
    for (let i = 0; i < world.applianceAt.length; i++) {
      if (world.tiles[i]?.placeable && (world.applianceAt[i] ?? 0) === 0) world.applianceAt[i] = -1;
    }
    world.applianceAt[home.y * world.width + home.x] = 0;
    use(world, home);

    expect(world.unlocked).not.toContain("fries");
    expect(carriedCard(world)).not.toBeNull();
    expect(world.events.some((e) => e.text.startsWith("No room for"))).toBe(true);

    // And the refund is still there to be had.
    use(world, slot.tile);
    expect(world.money).toBe(500);
  });

  test("it cannot be put down outside, where nothing may be built", () => {
    const world = morning(2);
    const slot = offer(world, "fries");
    world.money = 500;
    use(world, slot.tile);

    // Another patio square: paving, and so refused by the same rule that
    // refuses an oven there. The card stays in hand.
    const other = stallSlots(world).find((s) => s.id !== slot.id)!;
    const paving = seatsAround(world, other.tile)[0]!;
    use(world, paving);
    expect(world.unlocked).not.toContain("fries");
    expect(carriedCard(world)).not.toBeNull();
  });

  test("a save written while somebody holds one keeps the money, not the card", () => {
    // The same problem `parkFittings` solves for a carried board, in the
    // currency a card has instead of a tile. `snapshot` may not mutate, so the
    // fee goes into the file rather than into the running kitchen.
    const world = morning(2);
    world.money = 500;
    use(world, offer(world, "fries").tile);
    expect(world.money).toBeLessThan(500);

    const file = snapshot(world);
    expect(file.money).toBe(500);
    expect(file.appliances.some((a) => a.kind === "cards")).toBe(false);

    const restored = createWorld(LEVEL, 1);
    restore(restored, file);
    expect(restored.money).toBe(500);
    expect(restored.unlocked).not.toContain("fries");
  });

  test("a chef who disconnects holding one gets the room its money back", () => {
    // A card has no home to go back to, so it goes back as the money — which is
    // exactly what the pallet would still have paid all morning. Guessing a
    // dish on everybody else's behalf is the one thing worse than a refund.
    const world = morning(2);
    world.money = 500;
    const slot = offer(world, "fries");
    use(world, slot.tile);
    expect(world.money).toBeLessThan(500);

    removePlayer(world, world.players[0]!.id);
    expect(world.money).toBe(500);
    expect(carriedCard(world)).toBeNull();
    expect(world.unlocked).not.toContain("fries");
  });
});

describe("the day after", () => {
  test("the newest dish takes about half the orders, then joins the pool", () => {
    const world = morning(2);
    world.money = 500;
    takeCard(world, offer(world, "fries"));

    const share = (target: World): number => {
      let fries = 0;
      const total = 400;
      for (let i = 0; i < total; i++) {
        target.customers.length = 0;
        target.nextArrivalIn = 0;
        for (let t = 0; t < 40 && target.customers.length === 0; t++) step(target, idle());
        if (target.customers[0]?.recipeId === "fries") fries++;
      }
      return fries / total;
    };

    beginDay(world);
    const launch = share(world);
    expect(launch).toBeGreaterThan(0.3);
    expect(launch).toBeLessThan(0.7);

    endDay(world);
    beginDay(world);
    const settled = share(world);
    expect(settled).toBeGreaterThan(0.2);
    expect(settled).toBeLessThan(0.8);
    expect(settled).toBeLessThan(launch);
  });
});
