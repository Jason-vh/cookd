import { describe, expect, test } from "bun:test";
import { applianceDef } from "../data/appliances";
import { CARD_SLOTS, STARTING_RECIPES } from "../data/progression";
import { LEVEL } from "../data/level";
import { RECIPES, RECIPE_BY_ID } from "../data/recipes";
import { Host } from "../game/host";
import { cardStands, isCardMorning, missingFor, restockCards, unlockedRecipes } from "./cards";
import { seatsAround } from "./pathing";
import { canPlace } from "./queries";
import { beginDay, endDay } from "./day";
import { step } from "./step";
import type { Appliance, ApplianceKind, PlayerInput, Vec2, World } from "./types";
import { createWorld, emptyInput } from "./world";

/**
 * The recipe boards: how a kitchen's menu grows.
 *
 * Driven the way a player drives it — stand in front of a card, press `Grab`,
 * press it again — because the whole claim of the board is that it is the
 * hatch's grammar applied to progression: **zero new verbs, one new place**. A
 * test that called `unlockRecipe` directly would be testing a different feature
 * from the one that shipped.
 */

/** A kitchen in the morning of `day`, with nobody due through the door. */
function morning(day = 1): World {
  const world = createWorld(LEVEL, 1);
  world.nextArrivalIn = Infinity;
  // The day is moved through `endDay` rather than assigned, so everything a
  // morning is supposed to do — restocking the stall, rolling the cards — has
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

/**
 * Stand on the paving beside a square, facing it.
 *
 * Any side will do — what stands there is an appliance with four sides, not a
 * counter with a front — so this takes the first walkable neighbour, which is
 * also a small guarantee that the delivery has landed somewhere reachable.
 */
function faceGoods(world: World, tile: Vec2): void {
  const from = seatsAround(world, tile)[0]!;
  const player = world.players[0]!;
  player.pos = { x: from.x + 0.5, y: from.y + 0.5 };
  player.prevPos = { ...player.pos };
  player.facing = { x: tile.x - from.x, y: tile.y - from.y };
}

/** Face card `index` and press grab. */
function useCard(world: World, index: number): Appliance {
  const stand = cardStands(world)[index]!;
  faceGoods(world, stand.tile);
  press(world, "grab");
  return stand;
}

function cardsOn(world: World): (string | null)[] {
  return cardStands(world).map((stand) => stand.card);
}

/** Force a stand to hold a particular recipe, for tests about a specific dish. */
function offer(world: World, index: number, recipeId: string): Appliance {
  const stand = cardStands(world)[index]!;
  stand.card = recipeId;
  return stand;
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
    // The kitchen is a starting point: no heat, and two crates. Everything else
    // is a choice somebody makes at the stand or at the stall.
    const world = morning();
    expect(counts(world, "fryer")).toBe(0);
    expect(counts(world, "oven")).toBe(0);
    expect(crateBases(world)).toEqual(["lettuce", "tomato"]);
  });
});

describe("the stand", () => {
  test("hangs on the wall, and nothing may be built under it", () => {
    const world = morning();
    const stands = cardStands(world);
    expect(stands).toHaveLength(CARD_SLOTS);
    for (const stand of stands) {
      expect(canPlace(world, stand.tile.x, stand.tile.y, "counter")).toBe(false);
      expect(world.tiles[stand.tile.y * world.width + stand.tile.x]?.placeable).toBe(false);
    }
  });

  test("comes out on day 2, then every third morning", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 11].map(isCardMorning)).toEqual([
      false,
      true,
      false,
      false,
      true,
      false,
      false,
      true,
      true,
    ]);
  });

  test("day one is bare, day two is a choice", () => {
    expect(cardsOn(morning(1))).toEqual([null, null]);
    const second = morning(2);
    expect(second.unlocked).toEqual(STARTING_RECIPES); // still salad-only until picked
    for (const card of cardsOn(second)) expect(card).not.toBeNull();
  });

  test("never offers the same recipe twice", () => {
    // Two cards, two dishes: a stand offering fries beside fries is not a choice.
    for (let day = 2; day <= 20; day += 3) {
      const cards = cardsOn(morning(day)).filter((card) => card !== null);
      expect(new Set(cards).size).toBe(cards.length);
    }
  });

  test("never offers something already on the menu", () => {
    const world = morning(2);
    world.unlocked = ["salad", "fries", "bread"];
    restockCards(world);
    for (const card of cardsOn(world)) expect(world.unlocked).not.toContain(card);
  });

  test("respects prerequisites: no cheese fries before fries", () => {
    const world = morning(2);
    for (let day = 2; day < 60; day += 3) {
      world.day = day;
      restockCards(world);
      for (const card of cardsOn(world)) {
        const prereq = card === null ? undefined : RECIPE_BY_ID.get(card)?.prereq;
        if (prereq) expect(world.unlocked).toContain(prereq);
      }
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
      restockCards(world);
      for (const card of cardsOn(world)) {
        if (card) seen.set(card, (seen.get(card) ?? 0) + 1);
      }
    }
    const tierOne = RECIPES.filter((r) => r.tier === 1 && !r.prereq).reduce(
      (total, r) => total + (seen.get(r.id) ?? 0),
      0,
    );
    expect(tierOne).toBeGreaterThan((seen.get("pizza") ?? 0) * 3);
    // ...and rare is not never: the whole library stays reachable.
    expect(seen.get("pizza")).toBeGreaterThan(0);
  });

  test("an exhausted library means no stand at all", () => {
    const world = morning(2);
    world.unlocked = RECIPES.map((recipe) => recipe.id);
    restockCards(world);
    expect(cardsOn(world)).toEqual([null, null]);
  });

  test("two hosts on one seed are offered the same pair, several offers running", () => {
    // The same guarantee the stall's stock has, and for the same reason: the
    // roll must come from the seed and the day, never from the live stream that
    // arrivals and seating consume at their own pace.
    const a = new Host();
    const b = new Host();

    for (let day = 1; day <= 10; day++) {
      expect(cardsOn(a.world)).toEqual(cardsOn(b.world));
      // Only one of them plays.
      beginDay(a.world);
      for (let i = 0; i < 600; i++) step(a.world, {});
      endDay(a.world);
      beginDay(b.world);
      endDay(b.world);
    }
    // ...and it was a real offer, not two empty stands agreeing.
    expect(cardsOn(a.world).filter((card) => card !== null).length).toBe(CARD_SLOTS);
  });
});

describe("choosing a card", () => {
  test("arms first, then confirms", () => {
    const world = morning(2);
    const stand = offer(world, 0, "fries");

    useCard(world, 0);
    expect(stand.armedBy).toBe(world.players[0]!.id);
    expect(world.unlocked).not.toContain("fries");
    expect(world.events.some((e) => e.text.includes("considering Fries"))).toBe(true);

    useCard(world, 0);
    expect(world.unlocked).toContain("fries");
  });

  test("walking away puts it back down", () => {
    const world = morning(2);
    const stand = offer(world, 0, "fries");
    useCard(world, 0);
    expect(stand.armedBy).not.toBeNull();

    // Turn to look at anything else and the choice is off. Coming back and
    // pressing once arms it again rather than taking it.
    world.players[0]!.facing = { x: 1, y: 0 };
    step(world, idle());
    expect(stand.armedBy).toBeNull();

    useCard(world, 0);
    expect(world.unlocked).not.toContain("fries");
  });

  test("arming times out", () => {
    const world = morning(2);
    const stand = offer(world, 0, "fries");
    useCard(world, 0);
    for (let i = 0; i < 60 * 5; i++) step(world, idle());
    expect(stand.armedBy).toBeNull();
  });

  test("arming the other card is a change of mind about the first", () => {
    const world = morning(2);
    const first = offer(world, 0, "fries");
    const second = offer(world, 1, "bread");
    useCard(world, 0);
    useCard(world, 1);
    expect(first.armedBy).toBeNull();
    expect(second.armedBy).toBe(world.players[0]!.id);
  });

  test("taking one card takes the offer: it is a choice, not two purchases", () => {
    const world = morning(2);
    offer(world, 0, "fries");
    offer(world, 1, "bread");
    useCard(world, 0);
    useCard(world, 0);

    expect(world.unlocked).toEqual(["salad", "fries"]);
    expect(cardsOn(world)).toEqual([null, null]);
    // And no second offer this morning, however the stands are restocked.
    restockCards(world);
    expect(cardsOn(world)).toEqual([null, null]);
  });

  test("the log says who did it", () => {
    const world = morning(2);
    world.players[0]!.name = "Ada";
    offer(world, 0, "fries");
    useCard(world, 0);
    useCard(world, 0);
    expect(world.events.some((e) => e.text.startsWith("Ada is considering"))).toBe(true);
    expect(world.events.some((e) => e.text === "Ada added Fries to the menu")).toBe(true);
  });

  test("unpicked cards leave when the day opens, and the next offer still comes", () => {
    const world = morning(2);
    expect(cardsOn(world).filter((card) => card !== null).length).toBe(CARD_SLOTS);

    // Cards ride the layout message, so them leaving is a layout change like
    // an oven moving. A client that is not told keeps drawing an offer the
    // room has already lost.
    const before = world.layoutVersion;
    beginDay(world);
    expect(world.layoutVersion).toBeGreaterThan(before);
    expect(cardsOn(world)).toEqual([null, null]);

    // Day 3 and 4: nothing. Day 5: the next offer, on schedule, whether or not
    // anybody took the last one. A room may consolidate on purpose.
    endDay(world);
    expect(cardsOn(world)).toEqual([null, null]);
    beginDay(world);
    endDay(world);
    expect(cardsOn(world)).toEqual([null, null]);
    beginDay(world);
    endDay(world);
    expect(world.day).toBe(5);
    expect(cardsOn(world).filter((card) => card !== null).length).toBe(CARD_SLOTS);
  });
});

describe("a card delivers what its dish needs", () => {
  test("exactly the missing equipment, onto interior tiles", () => {
    const world = morning(2);
    offer(world, 0, "fries");
    expect(missingFor(world, RECIPE_BY_ID.get("fries")!)).toEqual({
      kinds: ["fryer"],
      crates: ["potato"],
    });

    useCard(world, 0);
    useCard(world, 0);

    expect(counts(world, "fryer")).toBe(1);
    expect(crateBases(world)).toEqual(["lettuce", "potato", "tomato"]);
    // Never the door, never the patio: everything delivered is somewhere the
    // game is allowed to put things.
    for (const appliance of world.appliances.values()) {
      // Level furniture is exempt by definition — the shop's squares are out
      // on the paving and signs and posters hang on walls, which is precisely
      // what being immovable means. Asked as a property rather than as a list of
      // kinds, so the next piece of furniture does not have to edit this test.
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

  test("nothing the kitchen already owns", () => {
    // A room that took the fries card on day 2 already has the fryer and the
    // potato crate. Cheese fries are fries plus chopped cheese, so on day 5 it
    // is owed exactly one crate — not a second fryer.
    const world = morning(2);
    offer(world, 0, "fries");
    useCard(world, 0);
    useCard(world, 0);
    while (world.day < 5) {
      beginDay(world);
      endDay(world);
    }

    offer(world, 0, "cheesefries");
    useCard(world, 0);
    useCard(world, 0);
    expect(counts(world, "fryer")).toBe(1);
    expect(crateBases(world)).toEqual(["cheese", "lettuce", "potato", "tomato"]);
  });

  test("one oven for a dish that bakes, however many bakes it takes", () => {
    const world = morning(2);
    offer(world, 0, "bread");
    useCard(world, 0);
    useCard(world, 0);
    expect(counts(world, "oven")).toBe(1);
    expect(crateBases(world)).toEqual(["flour", "lettuce", "tomato", "water"]);
  });

  test("a kitchen with nowhere to put it is refused, out loud", () => {
    // The pathological case. Dropping the fryer on the floor would leave a menu
    // the room cannot cook and cannot diagnose, so the pick does not happen.
    const world = morning(2);
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const index = y * world.width + x;
        if (!world.tiles[index]?.placeable) continue;
        if ((world.applianceAt[index] ?? 0) === 0) world.applianceAt[index] = -1;
      }
    }
    offer(world, 0, "fries");
    useCard(world, 0);
    useCard(world, 0);

    expect(world.unlocked).not.toContain("fries");
    expect(world.events.some((e) => e.text.startsWith("No room for"))).toBe(true);
  });
});

describe("the day after", () => {
  test("the newest dish takes about half the orders, then joins the pool", () => {
    const world = morning(2);
    offer(world, 0, "fries");
    useCard(world, 0);
    useCard(world, 0);

    const share = (target: World): number => {
      let fries = 0;
      const total = 400;
      for (let i = 0; i < total; i++) {
        target.nextArrivalIn = 0;
        target.customers.length = 0;
        step(target, idle());
        if (target.customers[0]?.recipeId === "fries") fries++;
      }
      return fries / total;
    };

    beginDay(world);
    const launch = share(world);
    // About half, and about half is what `LAUNCH_SHARE` says. It used to be
    // three quarters: the newest dish took its share *and* an even cut of the
    // remainder, which on a two-dish menu left the salad an afterthought on the
    // day the room learned bread.
    expect(launch).toBeGreaterThan(0.4);
    expect(launch).toBeLessThan(0.6);

    // Next day it is one dish of two, like anything else on the menu.
    endDay(world);
    beginDay(world);
    const settled = share(world);
    expect(settled).toBeGreaterThan(0.3);
    expect(settled).toBeLessThan(0.7);
  });
});

describe("the stall stocks for this restaurant", () => {
  test("no fryer before there is anything to fry", () => {
    // Ten mornings of a salad-only kitchen: heat is not on offer, because a
    // fryer bought now is an expensive thing to watch do nothing.
    const world = morning();
    for (let day = 1; day <= 10; day++) {
      for (const slot of [...world.appliances.values()].filter((a) => a.kind === "stall")) {
        expect(slot.offer?.kind).not.toBe("fryer");
        expect(slot.offer?.kind).not.toBe("oven");
      }
      beginDay(world);
      endDay(world);
    }
  });

  test("crates hold what the menu starts from, and nothing else", () => {
    const salad = morning();
    for (let day = 1; day <= 10; day++) {
      for (const slot of [...salad.appliances.values()].filter((a) => a.kind === "stall")) {
        if (slot.offer?.source) {
          expect(["tomato", "lettuce"]).toContain(slot.offer.source.base);
        }
      }
      beginDay(salad);
      endDay(salad);
    }
  });

  test("a fryer appears once fries do", () => {
    // Same room, one card later. The stall follows the menu, so the day after a
    // recipe arrives its equipment is buyable — seconds and replacements at
    // list price.
    const world = morning(2);
    offer(world, 0, "fries");
    useCard(world, 0);
    useCard(world, 0);

    let sawFryer = false;
    let sawPotato = false;
    for (let day = 0; day < 20; day++) {
      beginDay(world);
      endDay(world);
      for (const slot of [...world.appliances.values()].filter((a) => a.kind === "stall")) {
        if (slot.offer?.kind === "fryer") sawFryer = true;
        if (slot.offer?.source?.base === "potato") sawPotato = true;
      }
    }
    expect(sawFryer).toBe(true);
    expect(sawPotato).toBe(true);
  });
});
