import { describe, expect, test } from "bun:test";
import { applianceDef } from "../data/appliances";
import { PLATE_PRICE, SELLBACK, STALL_SLOTS, rentFor } from "../data/economy";
import { LEVEL } from "../data/level";
import { Host } from "../game/host";
import { platesInWorld } from "./plates";
import { canPlace } from "./queries";
import { offerPrice, stallSlots } from "./shop";
import { endDay, step } from "./step";
import type { Appliance, ApplianceKind, PlayerInput, World } from "./types";
import { applianceAtTile, createWorld, emptyInput, removePlayer } from "./world";

/**
 * The stall, the ledger and the morning.
 *
 * Everything here is driven the way a player drives it — stand in front of a
 * slot, press `Grab` — because the whole design claim of the shop is that it
 * introduces **no new verbs**. A test that reached in and called a `buy()`
 * function would be testing a different feature from the one that shipped.
 */

/** A kitchen in its morning, with nobody due through the door. */
function morning(): World {
  const world = createWorld(LEVEL, 1);
  world.nextArrivalIn = Infinity;
  return world;
}

function idle(): PlayerInput[] {
  return [emptyInput()];
}

function press(world: World, button: "grab" | "start"): void {
  const inputs = idle();
  inputs[0]![button] = true;
  step(world, inputs);
  step(world, idle());
}

/** Stand on the tile east of `tile`, facing west at it. */
function faceWest(world: World, tile: { x: number; y: number }): void {
  const player = world.players[0]!;
  player.pos.x = tile.x + 1.5;
  player.pos.y = tile.y + 0.5;
  player.prevPos = { ...player.pos };
  player.facing = { x: -1, y: 0 };
}

/** Face slot `index` and press grab. */
function useSlot(world: World, index: number): Appliance {
  const slot = stallSlots(world)[index]!;
  faceWest(world, slot.tile);
  press(world, "grab");
  return slot;
}

/** Force a slot to hold a particular thing, for tests about a specific price. */
function stock(world: World, index: number, kind: ApplianceKind): Appliance {
  const slot = stallSlots(world)[index]!;
  slot.offer = { good: "appliance", kind, source: null };
  slot.taken = null;
  return slot;
}

function counts(world: World, kind: ApplianceKind): number {
  return [...world.appliances.values()].filter((a) => a.kind === kind).length;
}

/** What the stall is showing, as one comparable string. */
function shown(world: World): string {
  return stallSlots(world)
    .map((slot) =>
      slot.offer === null
        ? "-"
        : slot.offer.good === "plate"
          ? "plate"
          : `${slot.offer.kind}:${slot.offer.source?.base ?? ""}:${offerPrice(slot.offer)}`,
    )
    .join("|");
}

/**
 * Average arrival interval over many rolls, so the jitter does not decide it.
 *
 * Customers are cleared between rolls because they *take* the seats they were
 * drawn by, and a queue building up over four hundred samples would measure the
 * room filling rather than the room's size.
 */
function meanInterval(world: World): number {
  let total = 0;
  for (let i = 0; i < 400; i++) {
    world.customers.length = 0;
    world.nextArrivalIn = 0;
    step(world, {});
    total += world.nextArrivalIn;
  }
  return total / 400;
}

describe("the stall", () => {
  test("the level stands three slots on the patio, and nothing may be built there", () => {
    const world = morning();
    const slots = stallSlots(world);
    expect(slots).toHaveLength(STALL_SLOTS);

    for (const slot of slots) {
      // A slot is not a placement target, and neither is the paving it stands
      // on: the ring is walkable and unplaceable, which are two separate facts.
      expect(canPlace(world, slot.tile.x, slot.tile.y)).toBe(false);
      expect(canPlace(world, slot.tile.x + 1, slot.tile.y)).toBe(false);
      expect(world.tiles[slot.tile.y * world.width + slot.tile.x]?.placeable).toBe(false);
    }
  });

  test("every slot is stocked in the morning", () => {
    const world = morning();
    for (const slot of stallSlots(world)) expect(slot.offer).not.toBeNull();
  });

  test("buying deducts the money and hands over a held ghost", () => {
    const world = morning();
    world.money = 100;
    const slot = stock(world, 0, "board");
    const price = applianceDef("board").price;

    const boards = counts(world, "board");
    useSlot(world, 0);

    expect(world.money).toBe(100 - price);
    expect(counts(world, "board")).toBe(boards + 1);

    // Held, not placed: it is answering "where would this go", exactly as an
    // appliance lifted off the kitchen floor does.
    const bought = world.appliances.get(world.players[0]!.carriedAppliance!)!;
    expect(bought.kind).toBe("board");
    expect(bought.heldBy).toBe(world.players[0]!.id);
    expect(world.applianceAt.includes(bought.id)).toBe(false);
    // The slot is empty, but remembers what it handed out.
    expect(slot.taken).toBe(bought.id);
  });

  test("a held ghost can be placed, and never lands on the door or the patio", () => {
    const world = morning();
    world.money = 100;
    stock(world, 0, "counter");
    useSlot(world, 0);
    const bought = world.players[0]!.carriedAppliance!;

    // Its *home* — where it would go if the buyer vanished — is a real kitchen
    // tile, chosen by the same guard that sends a leaver's oven home.
    const home = world.appliances.get(bought)!.tile;
    expect(world.tiles[home.y * world.width + home.x]?.placeable).toBe(true);
    expect(home).not.toEqual(world.door);

    // And that is exactly what happens when they do vanish.
    removePlayer(world, world.players[0]!.id);
    const landed = world.appliances.get(bought)!;
    expect(landed.heldBy).toBeNull();
    expect(applianceAtTile(world, landed.tile.x, landed.tile.y)?.id).toBe(bought);
    expect(world.tiles[landed.tile.y * world.width + landed.tile.x]?.placeable).toBe(true);
  });

  test("broke is a refusal you can read, and it changes nothing", () => {
    const world = morning();
    world.money = 0;
    stock(world, 0, "oven");

    const before = world.appliances.size;
    useSlot(world, 0);

    expect(world.money).toBe(0);
    expect(world.appliances.size).toBe(before);
    expect(world.players[0]!.carriedAppliance).toBeNull();
    // Never a silent no: the log says the number, and a cue fires for the flash.
    expect(world.events.at(-1)?.text).toContain(`$${applianceDef("oven").price}`);
    expect(world.effects.some((cue) => cue.kind === "refused")).toBe(true);
  });

  test("negative money blocks buying, and is the only thing rent does", () => {
    const world = morning();
    world.money = 5;
    press(world, "start");
    world.dayTime = 0.05;
    for (let i = 0; i < 20; i++) step(world, idle());

    expect(world.money).toBe(5 - rentFor(1));
    expect(world.money).toBeLessThan(0);
    // No fail state; just a poor morning, and a stall you cannot shop at.
    expect(world.phase).toBe("build");

    stock(world, 0, "counter");
    useSlot(world, 0);
    expect(world.players[0]!.carriedAppliance).toBeNull();
  });

  test("putting it straight back is an undo, not a sale", () => {
    const world = morning();
    world.money = 200;
    stock(world, 0, "fryer");

    useSlot(world, 0);
    expect(world.money).toBe(200 - applianceDef("fryer").price);

    // Same slot, same unit, same morning: all of it back.
    useSlot(world, 0);
    expect(world.money).toBe(200);
    expect(world.players[0]!.carriedAppliance).toBeNull();
    // ...and the fryer is gone with it. A new kitchen owns none — the level is
    // a starting point now, and heat arrives on a recipe card.
    expect(counts(world, "fryer")).toBe(0);
  });

  test("selling pays half of list price", () => {
    const world = morning();
    const slot = stallSlots(world)[0]!;
    slot.offer = null;
    slot.taken = null;

    // Lift the kitchen's own board and carry it out to the stall.
    const board = [...world.appliances.values()].find((a) => a.kind === "board")!;
    const player = world.players[0]!;
    player.pos = { x: board.tile.x + 0.5, y: board.tile.y + 1.5 };
    player.prevPos = { ...player.pos };
    player.facing = { x: 0, y: -1 };
    press(world, "grab");
    expect(player.carriedAppliance).toBe(board.id);

    useSlot(world, 0);
    expect(world.money).toBe(Math.floor(applianceDef("board").price * SELLBACK));
    expect(counts(world, "board")).toBe(0);
    expect(player.carriedAppliance).toBeNull();
  });

  test("the last of an essential kind is not for sale", () => {
    const world = morning();
    const slot = stallSlots(world)[0]!;
    slot.offer = null;

    for (const kind of ["sink", "plates"] as const) {
      const only = [...world.appliances.values()].find((a) => a.kind === kind)!;
      const player = world.players[0]!;
      player.pos = { x: only.tile.x + 0.5, y: only.tile.y + 1.5 };
      player.prevPos = { ...player.pos };
      player.facing = { x: 0, y: -1 };
      press(world, "grab");
      expect(player.carriedAppliance).toBe(only.id);

      const money = world.money;
      useSlot(world, 0);
      expect(world.money).toBe(money);
      expect(counts(world, kind)).toBe(1);
      expect(player.carriedAppliance).toBe(only.id);

      // Put it back where it came from, so the next kind starts clean.
      player.pos = { x: only.tile.x + 0.5, y: only.tile.y + 1.5 };
      player.facing = { x: 0, y: -1 };
      press(world, "grab");
    }
  });

  test("the stall is shuttered during service", () => {
    const world = morning();
    world.money = 100;
    stock(world, 0, "counter");
    press(world, "start");
    expect(world.phase).toBe("service");

    useSlot(world, 0);
    expect(world.money).toBe(100);
    expect(world.players[0]!.carriedAppliance).toBeNull();
  });
});

describe("plates are the one thing the game will make", () => {
  test("a bought plate is counted, and survives a whole day loop", () => {
    const world = morning();
    world.money = PLATE_PRICE;
    const slot = stallSlots(world)[0]!;
    slot.offer = { good: "plate" };
    slot.taken = null;

    expect(platesInWorld(world)).toBe(LEVEL.plates);
    useSlot(world, 0);
    expect(world.money).toBe(0);
    expect(platesInWorld(world)).toBe(LEVEL.plates + 1);
    // Into your hands, to be carried to the stack — and the slot is simply
    // gone, because handing the money back would mean destroying a plate.
    expect(world.players[0]!.carried?.base).toBe("plate");
    expect(slot.offer).toBeNull();

    // Through service, closing time and into the next morning. Closing counts
    // plates out and counts them back in, so a miscount shows up here.
    press(world, "start");
    for (let i = 0; i < 120; i++) step(world, idle());
    endDay(world);
    expect(platesInWorld(world)).toBe(LEVEL.plates + 1);

    press(world, "start");
    endDay(world);
    expect(platesInWorld(world)).toBe(LEVEL.plates + 1);
  });
});

describe("the stock is the same shop for everybody", () => {
  test("two hosts on one seed stock identically, several days running", () => {
    const a = new Host();
    const b = new Host();

    for (let day = 1; day <= 5; day++) {
      expect(shown(a.world)).toBe(shown(b.world));
      // ...and it is a real shop, not three empty slots agreeing.
      expect(shown(a.world)).not.toBe("-|-|-");

      // Only one of them plays: the roll must not depend on the live RNG
      // stream, which arrivals and seating consume at their own pace.
      a.menu("startDay");
      for (let i = 0; i < 600; i++) step(a.world, {});
      endDay(a.world);
      b.menu("startDay");
      endDay(b.world);
      expect(a.world.day).toBe(b.world.day);
    }
  });

  test("a morning always holds something the kitchen is short of", () => {
    // Three duds is a shop players stop walking to. The lean starting kitchen
    // owns one of almost everything, so the guarantee has plenty to choose from.
    const world = morning();
    const kinds = stallSlots(world)
      .map((slot) => (slot.offer?.good === "appliance" ? slot.offer.kind : null))
      .filter((kind) => kind !== null);
    const scarce = kinds.some((kind) => counts(world, kind) < 2);
    expect(scarce || kinds.length < STALL_SLOTS).toBe(true);
  });
});

/** A day whose curve is slack enough that seats are the binding constraint. */
function openRoom(): World {
  const world = morning();
  world.phase = "service";
  world.day = 4;
  world.dayTime = world.dayLength;
  return world;
}

describe("demand follows seats", () => {
  test("a table added pulls customers in sooner; one removed pushes them away", () => {
    const world = openRoom();

    const base = meanInterval(world);

    // Sell a table off the floor: fewer seats, slower door.
    const table = [...world.appliances.values()].find((a) => a.kind === "table")!;
    world.applianceAt[table.tile.y * world.width + table.tile.x] = 0;
    world.appliances.delete(table.id);
    const fewer = meanInterval(world);
    expect(fewer).toBeGreaterThan(base);

    // Put two back: more seats, busier door. This is the coupling the shop
    // needs to be honest — a table brings its own customers, so buying one is
    // capacity and chaos in the same purchase.
    for (const at of [
      { x: 4, y: 4 },
      { x: 6, y: 4 },
    ]) {
      const id = world.nextId++;
      world.appliances.set(id, { ...table, id, tile: at, item: null, tip: 0, heldBy: null });
      world.applianceAt[at.y * world.width + at.x] = id;
    }
    expect(meanInterval(world)).toBeLessThan(base);
  });

  test("the day curve is a floor: seats cannot make day one faster than it allows", () => {
    // Both halves are load-bearing. Without the floor, a dining room of ten
    // tables would open day one at a rush; without the seats, a table would be
    // free money. The floor is what stops the first, and it has to hold no
    // matter how much furniture is bought.
    const world = morning();
    world.phase = "service";
    world.dayTime = world.dayLength;

    const table = [...world.appliances.values()].find((a) => a.kind === "table")!;
    const addTables = (at: { x: number; y: number }[]): void => {
      for (const tile of at) {
        const id = world.nextId++;
        world.appliances.set(id, { ...table, id, tile, item: null, tip: 0, heldBy: null });
        world.applianceAt[tile.y * world.width + tile.x] = id;
      }
    };

    addTables([
      { x: 6, y: 4 },
      { x: 6, y: 8 },
      { x: 4, y: 6 },
      { x: 6, y: 6 },
    ]);
    const six = meanInterval(world);

    addTables([
      { x: 3, y: 3 },
      { x: 5, y: 3 },
      { x: 7, y: 3 },
      { x: 3, y: 9 },
    ]);
    const ten = meanInterval(world);

    // Ten tables on day one arrive no faster than six do: past the floor, more
    // furniture buys capacity and no extra demand at all.
    //
    // A tolerance rather than an equality, because the two means are four
    // hundred samples of the same uniform jitter drawn from different points in
    // the stream. A tenth of a second of drift is that; the effect this test
    // would catch is measured in whole seconds (see the test above, where two
    // tables' worth is three and a half).
    expect(Math.abs(ten - six)).toBeLessThan(0.5);
  });

  test("a table with a dirty plate on it is not a free seat", () => {
    const world = openRoom();
    const clear = meanInterval(world);

    for (const appliance of world.appliances.values()) {
      if (appliance.kind !== "table") continue;
      appliance.item = { id: world.nextId++, base: "plate", processes: ["dirty"], contents: [] };
    }
    // Falling behind on bussing quietly slows the door down, which is the same
    // rule seating already applies — one question, one answer.
    expect(meanInterval(world)).toBeGreaterThan(clear);
  });
});
