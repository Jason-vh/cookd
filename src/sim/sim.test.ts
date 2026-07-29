import { describe, expect, test } from "bun:test";
import { LEVEL } from "../data/level";
import { RECIPE_BY_ID } from "../data/recipes";
import { DT, step } from "./step";
import { unreachableTables } from "./queries";
import { specKey } from "./items";
import type { Customer, Player, PlayerInput, World } from "./types";
import { applianceAtTile, createWorld, emptyInput, isSolid } from "./world";

/**
 * These tests drive the simulation exactly like a player would — through
 * PlayerInput — which is only possible because `sim` has no DOM dependencies.
 * They double as executable documentation of the recipe pipeline.
 */

/**
 * A kitchen with the door closed.
 *
 * Customers arrive on their own now, and a test about chopping a tomato should
 * not be at the mercy of who walked in while it ran. Tests that *are* about the
 * dining room open the door again by setting `nextArrivalIn`.
 */
function makeWorld(): World {
  const world = createWorld(LEVEL, 1);
  world.nextArrivalIn = Infinity;
  return world;
}

function idle(): PlayerInput[] {
  return [emptyInput()];
}

/**
 * Teleport the player onto the tile adjacent to (tx,ty) in the -(dx,dy)
 * direction, facing (dx,dy) — i.e. (dx,dy) points *at* the target tile.
 */
function face(player: Player, tx: number, ty: number, dx: number, dy: number): void {
  player.pos.x = tx + 0.5 - dx;
  player.pos.y = ty + 0.5 - dy;
  player.prevPos.x = player.pos.x;
  player.prevPos.y = player.pos.y;
  player.facing.x = dx;
  player.facing.y = dy;
}

function press(world: World, button: "grab" | "use" | "start"): void {
  const inputs = idle();
  inputs[0]![button] = true;
  step(world, inputs);
  step(world, idle());
}

function hold(world: World, seconds: number, button: "use" | null = "use"): void {
  const inputs = idle();
  if (button) inputs[0]![button] = true;
  for (let i = 0; i < Math.ceil(seconds / DT); i++) step(world, inputs);
}

// Tile coordinates from data/level.ts
const CRATE = {
  tomato: [8, 1],
  lettuce: [9, 1],
  cheese: [10, 1],
  flour: [11, 1],
  water: [12, 1],
  potato: [13, 1],
} as const;
const PLATES = [14, 1] as const;
const BOARD = [10, 3] as const;
const COUNTER = [9, 3] as const;
const OVEN = [19, 4] as const;
const FRYER = [18, 7] as const;
const PASS = [7, 4] as const;
/** A table in the dining room, approached from the tile above it. */
const TABLE = [5, 2] as const;

/**
 * Sit somebody at a table with an order already placed — the state the delivery
 * rules care about, without walking them in from the park first.
 */
function seatCustomer(world: World, recipeId: string, tile = TABLE): Customer {
  const table = applianceAtTile(world, tile[0], tile[1])!;
  const recipe = RECIPE_BY_ID.get(recipeId)!;
  const seat = { x: tile[0] + 1, y: tile[1] };
  const customer: Customer = {
    id: world.nextId++,
    state: "ordering",
    pos: { x: seat.x + 0.5, y: seat.y + 0.5 },
    prevPos: { x: seat.x + 0.5, y: seat.y + 0.5 },
    facing: { x: -1, y: 0 },
    table: table.id,
    seat,
    recipeId,
    path: [],
    timer: 0,
    remaining: recipe.patience,
    patience: recipe.patience,
    tip: 0,
  };
  world.customers.push(customer);
  return customer;
}

function takeFrom(world: World, tile: readonly [number, number], dx = 0, dy = -1): void {
  face(world.players[0]!, tile[0], tile[1], dx, dy);
  press(world, "grab");
}

function putOn(world: World, tile: readonly [number, number], dx = 0, dy = -1): void {
  face(world.players[0]!, tile[0], tile[1], dx, dy);
  press(world, "grab");
}

/** One press-and-hold. Starts from released, because a press always does. */
function chopOn(world: World, tile: readonly [number, number], seconds: number): void {
  face(world.players[0]!, tile[0], tile[1], 0, -1);
  hold(world, 2 * DT, null);
  hold(world, seconds);
}

describe("kitchen basics", () => {
  test("a crate dispenses its ingredient and a counter holds it", () => {
    const world = makeWorld();
    takeFrom(world, CRATE.tomato);
    expect(world.players[0]!.carried?.base).toBe("tomato");

    putOn(world, COUNTER);
    expect(world.players[0]!.carried).toBeNull();
    expect(applianceAtTile(world, COUNTER[0], COUNTER[1])!.item?.base).toBe("tomato");
  });

  test("dropping an appliance onto another swaps them", () => {
    const world = makeWorld();
    world.phase = "build";
    const player = world.players[0]!;

    face(player, COUNTER[0], COUNTER[1], 0, -1);
    press(world, "grab");
    const counterId = player.carriedAppliance!;
    expect(world.appliances.get(counterId)!.kind).toBe("counter");

    face(player, BOARD[0], BOARD[1], 0, -1);
    press(world, "grab");

    expect(applianceAtTile(world, BOARD[0], BOARD[1])!.id).toBe(counterId);
    expect(world.appliances.get(player.carriedAppliance!)!.kind).toBe("board");
  });

  test("carrying an appliance in the build phase costs no speed", () => {
    const walk = (carrying: boolean): number => {
      const world = makeWorld();
      world.phase = "build";
      const player = world.players[0]!;
      if (carrying) {
        face(player, COUNTER[0], COUNTER[1], 0, -1);
        press(world, "grab");
        expect(player.carriedAppliance).not.toBeNull();
      }
      // Measure down the open middle of the kitchen either way, so the two
      // runs differ only by what's in the player's hands.
      player.pos.x = 6.5;
      player.pos.y = 4.5;
      player.prevPos.x = player.pos.x;
      player.prevPos.y = player.pos.y;
      const startY = player.pos.y;
      const inputs = idle();
      inputs[0]!.move.y = 1;
      for (let i = 0; i < 30; i++) step(world, inputs);
      return player.pos.y - startY;
    };
    expect(walk(true)).toBeCloseTo(walk(false), 5);
  });

  test("a source takes back exactly what it hands out", () => {
    const world = makeWorld();

    // Untouched: goes back in the crate.
    takeFrom(world, CRATE.tomato);
    putOn(world, CRATE.tomato);
    expect(world.players[0]!.carried).toBeNull();

    // Changed: the crate refuses it, so you're still holding it.
    takeFrom(world, CRATE.tomato);
    putOn(world, BOARD);
    chopOn(world, BOARD, 2.1);
    takeFrom(world, BOARD);
    putOn(world, CRATE.tomato);
    expect(world.players[0]!.carried?.processes).toEqual(["chopped"]);

    // Wrong crate refuses it too.
    putOn(world, CRATE.lettuce);
    expect(world.players[0]!.carried?.base).toBe("tomato");
  });

  test("a clean plate goes back on the stack, a loaded one does not", () => {
    const world = makeWorld();
    takeFrom(world, PLATES);
    putOn(world, PLATES);
    expect(world.players[0]!.carried).toBeNull();

    takeFrom(world, CRATE.tomato);
    putOn(world, COUNTER);
    takeFrom(world, PLATES);
    putOn(world, COUNTER); // plate picks up the tomato
    takeFrom(world, COUNTER);
    expect(world.players[0]!.carried?.contents.length).toBe(1);

    putOn(world, PLATES);
    expect(world.players[0]!.carried?.contents.length).toBe(1);
  });

  test("a source hands its item into what you're already carrying", () => {
    const world = makeWorld();
    takeFrom(world, CRATE.lettuce);
    chopOn(world, CRATE.lettuce, 0); // (no-op, keeps the sequence readable)
    putOn(world, BOARD);
    chopOn(world, BOARD, 2.1);
    takeFrom(world, BOARD);

    // Walk chopped lettuce to the plate stack: you leave with it plated.
    takeFrom(world, PLATES);
    const held = world.players[0]!.carried!;
    expect(held.base).toBe("plate");
    expect(specKey(held.contents[0]!)).toBe("lettuce|chopped");
  });

  test("a plate is a workspace: contents combine in place", () => {
    const world = makeWorld();
    takeFrom(world, CRATE.lettuce);
    putOn(world, BOARD);
    chopOn(world, BOARD, 2.1);
    takeFrom(world, BOARD);
    takeFrom(world, PLATES); // plated lettuce
    putOn(world, COUNTER);

    takeFrom(world, CRATE.tomato);
    putOn(world, BOARD);
    chopOn(world, BOARD, 2.1);
    takeFrom(world, BOARD);
    putOn(world, COUNTER); // onto the plate holding lettuce

    const plate = applianceAtTile(world, COUNTER[0], COUNTER[1])!.item!;
    expect(plate.base).toBe("plate");
    expect(plate.contents.length).toBe(1);
    expect(specKey(plate.contents[0]!)).toBe("salad");
  });

  test("food that combines with nothing sits alongside, and cannot be served", () => {
    const world = makeWorld();
    seatCustomer(world, "salad");
    takeFrom(world, CRATE.tomato);
    takeFrom(world, PLATES); // raw tomato on a plate
    takeFrom(world, CRATE.cheese); // cheese doesn't combine with raw tomato

    putOn(world, COUNTER);
    takeFrom(world, COUNTER);
    expect(world.players[0]!.carried!.contents.length).toBe(2);

    putOn(world, TABLE, 0, 1);
    expect(world.served).toBe(0);
    // Nothing is refused: the plate is on the table, it is simply not dinner.
    expect(applianceAtTile(world, TABLE[0], TABLE[1])!.item).not.toBeNull();
  });

  test("one chop for a salad, two for sauce — releasing is what stops it", () => {
    const world = makeWorld();
    takeFrom(world, CRATE.tomato);
    putOn(world, BOARD);
    const board = applianceAtTile(world, BOARD[0], BOARD[1])!;
    face(world.players[0]!, BOARD[0], BOARD[1], 0, -1);

    // One continuous hold, never released — the real question is how much slack
    // a player has to let go on the completion flash before the next chop
    // lands. That window is the second transform's duration: 1.7s on a board.
    hold(world, 1.3);
    expect(board.item!.processes).toEqual(["chopped"]);

    hold(world, 1.5);
    expect(board.item!.processes).toEqual(["chopped"]);

    hold(world, 0.3);
    expect(board.item!.processes).toEqual(["chopped", "crushed"]);
  });

  test("chopping only progresses while USE is held", () => {
    const world = makeWorld();
    takeFrom(world, CRATE.tomato);
    putOn(world, BOARD);

    hold(world, 1.0, null);
    expect(applianceAtTile(world, BOARD[0], BOARD[1])!.item!.processes).toEqual([]);

    chopOn(world, BOARD, 2.1);
    expect(applianceAtTile(world, BOARD[0], BOARD[1])!.item!.processes).toEqual(["chopped"]);
  });

  test("walking flush along a wall of appliances does not teleport the player", () => {
    // Regression: `2.32 - 0.32` is 1.9999... in floating point, which used to
    // make the collision code think the player overlapped the tile above and
    // eject them sideways out of the kitchen.
    const world = makeWorld();
    const player = world.players[0]!;
    player.pos.x = 8.33;
    player.pos.y = 2.32; // pressed flush against the crate row

    const inputs = idle();
    inputs[0]!.move.x = 1;
    for (let i = 0; i < 60; i++) step(world, inputs);

    expect(player.pos.y).toBeCloseTo(2.32, 6);
    expect(player.pos.x).toBeGreaterThan(11);
    expect(player.pos.x).toBeLessThan(world.width);
  });

  test("you can prep on any counter, just more slowly than on a board", () => {
    const counterWorld = makeWorld();
    takeFrom(counterWorld, CRATE.tomato);
    putOn(counterWorld, COUNTER);
    chopOn(counterWorld, COUNTER, 2.1);
    expect(applianceAtTile(counterWorld, COUNTER[0], COUNTER[1])!.item!.processes).toEqual([
      "chopped",
    ]);

    // The board is 1.75x faster, so the same work is done well before 2s.
    const boardWorld = makeWorld();
    takeFrom(boardWorld, CRATE.tomato);
    putOn(boardWorld, BOARD);
    chopOn(boardWorld, BOARD, 1.25);
    expect(applianceAtTile(boardWorld, BOARD[0], BOARD[1])!.item!.processes).toEqual(["chopped"]);

    // ...and a counter is not finished by then.
    const slowWorld = makeWorld();
    takeFrom(slowWorld, CRATE.tomato);
    putOn(slowWorld, COUNTER);
    chopOn(slowWorld, COUNTER, 1.25);
    expect(applianceAtTile(slowWorld, COUNTER[0], COUNTER[1])!.item!.processes).toEqual([]);
  });

  test("carrying a plate onto food plates it, in either direction", () => {
    // plate -> food
    const world = makeWorld();
    takeFrom(world, CRATE.tomato);
    putOn(world, COUNTER);
    takeFrom(world, PLATES);
    putOn(world, COUNTER);
    const plated = applianceAtTile(world, COUNTER[0], COUNTER[1])!.item!;
    expect(plated.base).toBe("plate");
    expect(plated.contents[0]!.base).toBe("tomato");

    // food -> plate
    const other = makeWorld();
    takeFrom(other, PLATES);
    putOn(other, COUNTER);
    takeFrom(other, CRATE.lettuce ?? CRATE.tomato);
    putOn(other, COUNTER);
    const second = applianceAtTile(other, COUNTER[0], COUNTER[1])!.item!;
    expect(second.base).toBe("plate");
    expect(second.contents).toHaveLength(1);
  });

  test("food left on the fryer burns", () => {
    const world = makeWorld();
    takeFrom(world, CRATE.potato);
    putOn(world, BOARD);
    chopOn(world, BOARD, 2.6);
    takeFrom(world, BOARD);
    putOn(world, FRYER, 1, 0);

    hold(world, 5.1, null);
    expect(applianceAtTile(world, FRYER[0], FRYER[1])!.item!.base).toBe("fries");

    hold(world, 6.1, null);
    expect(applianceAtTile(world, FRYER[0], FRYER[1])!.item!.processes).toContain("burnt");
  });
});

describe("the pizza pipeline", () => {
  test("flour + water -> knead -> sauce -> cheese -> bake -> plate -> deliver", () => {
    const world = makeWorld();
    const diner = seatCustomer(world, "pizza");

    // Dough is made from base ingredients: carry flour to the water crate and
    // the source combines straight into your hands.
    takeFrom(world, CRATE.flour);
    takeFrom(world, CRATE.water);
    expect(specKey(world.players[0]!.carried!)).toBe("dough");

    // Knead it, park it on the counter.
    putOn(world, BOARD);
    chopOn(world, BOARD, 3.1);
    takeFrom(world, BOARD);
    putOn(world, COUNTER);

    // Sauce = tomato chopped *twice*, which one long hold will do: keeping USE
    // down means keeping working, straight through the finished first chop.
    takeFrom(world, CRATE.tomato);
    putOn(world, BOARD);
    chopOn(world, BOARD, 3.0);
    expect(applianceAtTile(world, BOARD[0], BOARD[1])!.item!.processes).toEqual([
      "chopped",
      "crushed",
    ]);
    takeFrom(world, BOARD);
    putOn(world, COUNTER);
    expect(specKey(applianceAtTile(world, COUNTER[0], COUNTER[1])!.item!)).toBe("pizza|sauced");

    // Topping = chopped cheese.
    takeFrom(world, CRATE.cheese);
    putOn(world, BOARD);
    chopOn(world, BOARD, 2.1);
    takeFrom(world, BOARD);
    putOn(world, COUNTER);
    expect(specKey(applianceAtTile(world, COUNTER[0], COUNTER[1])!.item!)).toBe(
      "pizza|sauced,topped",
    );

    // Bake.
    takeFrom(world, COUNTER);
    putOn(world, OVEN, 1, 0);
    hold(world, 8.2, null);
    expect(specKey(applianceAtTile(world, OVEN[0], OVEN[1])!.item!)).toBe(
      "pizza|sauced,topped,baked",
    );

    // Plate it up, then serve.
    takeFrom(world, PLATES);
    putOn(world, COUNTER);
    takeFrom(world, OVEN, 1, 0);
    putOn(world, COUNTER);
    const plated = applianceAtTile(world, COUNTER[0], COUNTER[1])!.item!;
    expect(plated.base).toBe("plate");
    expect(specKey(plated.contents[0]!)).toBe("pizza|sauced,topped,baked");

    takeFrom(world, COUNTER);
    putOn(world, TABLE, 0, 1);

    expect(world.served).toBe(1);
    expect(diner.state).toBe("eating");
    expect(world.money).toBe(16);
  });

  test("a burnt pizza cannot be plated", () => {
    const world = makeWorld();
    const counter = applianceAtTile(world, COUNTER[0], COUNTER[1])!;
    counter.item = {
      id: 1,
      base: "pizza",
      processes: ["sauced", "topped", "baked", "burnt"],
      contents: [],
    };

    takeFrom(world, PLATES);
    putOn(world, COUNTER);
    expect(world.players[0]!.carried?.base).toBe("plate");
    expect(counter.item?.processes).toContain("burnt");
  });

  test("delivery still requires the plate to hold what was ordered", () => {
    const world = makeWorld();
    const diner = seatCustomer(world, "salad");

    // A plate of raw tomato is now legal to assemble, but nobody ordered it.
    takeFrom(world, CRATE.tomato);
    putOn(world, COUNTER);
    takeFrom(world, PLATES);
    putOn(world, COUNTER);
    takeFrom(world, COUNTER);
    putOn(world, TABLE, 0, 1);

    expect(world.served).toBe(0);
    expect(diner.state).toBe("ordering");
  });
});

describe("day loop", () => {
  test("service ends into the build phase, and appliances can be moved", () => {
    const world = makeWorld();
    world.dayTime = 0.05;
    hold(world, 0.2, null);
    expect(world.phase).toBe("build");

    const board = applianceAtTile(world, BOARD[0], BOARD[1])!;
    face(world.players[0]!, BOARD[0], BOARD[1], 0, -1);
    press(world, "grab");
    expect(board.heldBy).toBe(0);
    expect(applianceAtTile(world, BOARD[0], BOARD[1])).toBeNull();

    // Drop it one tile to the right, on what used to be counter-free floor.
    face(world.players[0]!, 13, 3, 0, -1);
    press(world, "grab");
    expect(applianceAtTile(world, 13, 3)!.id).toBe(board.id);

    press(world, "start");
    expect(world.phase).toBe("service");
    expect(world.day).toBe(2);
  });
});

/**
 * The dining room, which is the order queue made physical: capacity is chairs,
 * patience is a person, and a lost order is somebody standing up and leaving.
 */
describe("the dining room", () => {
  /** Build the salad the seated customer is waiting for, and hold it. */
  function makeSalad(world: World): void {
    takeFrom(world, CRATE.lettuce);
    putOn(world, BOARD);
    chopOn(world, BOARD, 2.1);
    takeFrom(world, BOARD);
    putOn(world, COUNTER);
    takeFrom(world, CRATE.tomato);
    putOn(world, BOARD);
    chopOn(world, BOARD, 2.1);
    takeFrom(world, BOARD);
    putOn(world, COUNTER); // combines into a salad
    takeFrom(world, PLATES);
    putOn(world, COUNTER); // plate the salad
    takeFrom(world, COUNTER);
  }

  test("the pass is two ordinary counters standing in the dividing wall", () => {
    const world = makeWorld();
    const pass = applianceAtTile(world, PASS[0], PASS[1])!;
    expect(pass.kind).toBe("counter");

    // It used to be a hatch food disappeared through, and then briefly a kind
    // of its own that did nothing. It is a place, not an object: put a plate
    // down from the kitchen side, pick it up from the dining side.
    takeFrom(world, PLATES);
    putOn(world, PASS, -1, 0);
    expect(world.players[0]!.carried).toBeNull();
    expect(pass.item?.base).toBe("plate");
    expect(world.served).toBe(0);

    takeFrom(world, PASS, -1, 0);
    expect(world.players[0]!.carried?.base).toBe("plate");
  });

  test("lifting the pass widens the opening between the two rooms", () => {
    const world = makeWorld();
    world.dayTime = 0.05;
    hold(world, 0.2, null);
    expect(world.phase).toBe("build");

    // The wall between kitchen and dining room is now a decision, not a fixed
    // feature: the counters in it can be carried away like any other.
    expect(isSolid(world, PASS[0], PASS[1])).toBe(true);
    face(world.players[0]!, PASS[0], PASS[1], -1, 0);
    press(world, "grab");
    expect(isSolid(world, PASS[0], PASS[1])).toBe(false);
  });

  test("a customer walks in, sits down and asks for something", () => {
    const world = makeWorld();
    world.nextArrivalIn = 0;
    hold(world, 12, null);

    const customer = world.customers[0]!;
    expect(customer.table).not.toBeNull();
    expect(customer.state).toBe("ordering");
    // They are sitting beside their table, not standing in the doorway.
    const table = world.appliances.get(customer.table!)!;
    const distance = Math.hypot(
      customer.pos.x - (table.tile.x + 0.5),
      customer.pos.y - (table.tile.y + 0.5),
    );
    expect(distance).toBeLessThan(1.1);
  });

  test("the wrong dish sits on the table and can be taken back", () => {
    const world = makeWorld();
    const diner = seatCustomer(world, "pizza");
    makeSalad(world);
    putOn(world, TABLE, 0, 1);

    // No refusal, no penalty: the plate is just on the table, and the bubble
    // still says pizza.
    expect(diner.state).toBe("ordering");
    expect(world.served).toBe(0);
    expect(applianceAtTile(world, TABLE[0], TABLE[1])!.item).not.toBeNull();

    takeFrom(world, TABLE, 0, 1);
    expect(world.players[0]!.carried?.base).toBe("plate");
    expect(applianceAtTile(world, TABLE[0], TABLE[1])!.item).toBeNull();
  });

  test("delivery pays the reward now and leaves the tip on the table", () => {
    const world = makeWorld();
    const diner = seatCustomer(world, "salad");
    makeSalad(world);
    putOn(world, TABLE, 0, 1);

    const table = applianceAtTile(world, TABLE[0], TABLE[1])!;
    expect(diner.state).toBe("eating");
    expect(world.money).toBe(8); // the base reward, and only that
    expect(diner.tip).toBeGreaterThan(0);
    expect(table.tip).toBe(0); // not until they leave

    // They eat, then go — leaving the plate and the tip behind. (They are still
    // walking to the door: leaving the room is not instant either.)
    hold(world, 13, null);
    expect(diner.state).toBe("leaving");
    expect(table.item!.processes).toContain("dirty");
    expect(table.tip).toBeGreaterThan(0);
  });

  test("bussing the plate collects the tip, and the stack washes it", () => {
    const world = makeWorld();
    seatCustomer(world, "salad");
    makeSalad(world);
    putOn(world, TABLE, 0, 1);
    hold(world, 13, null);

    const table = applianceAtTile(world, TABLE[0], TABLE[1])!;
    const tip = table.tip;
    const before = world.money;

    takeFrom(world, TABLE, 0, 1);
    expect(world.money).toBe(before + tip);
    expect(table.tip).toBe(0);
    expect(world.players[0]!.carried!.processes).toContain("dirty");

    putOn(world, PLATES);
    expect(world.players[0]!.carried).toBeNull();
  });

  test("food already on the table is picked up when the order lands", () => {
    const world = makeWorld();
    const diner = seatCustomer(world, "salad");
    makeSalad(world);

    // Run the food over before they have decided — prepping ahead of a table
    // that has only just sat down.
    diner.state = "deciding";
    diner.timer = 0.2;
    putOn(world, TABLE, 0, 1);
    expect(world.served).toBe(0);

    hold(world, 0.4, null);
    expect(world.customers[0]!.state).toBe("eating");
    expect(world.served).toBe(1);
  });

  test("a dirty plate is not a workspace", () => {
    const world = makeWorld();
    const counter = applianceAtTile(world, COUNTER[0], COUNTER[1])!;
    counter.item = { id: 1, base: "plate", processes: ["dirty"], contents: [] };

    takeFrom(world, CRATE.tomato);
    putOn(world, COUNTER);
    expect(counter.item.contents).toHaveLength(0);
    expect(world.players[0]!.carried?.base).toBe("tomato");
  });

  test("a table still holding a dirty plate cannot be sat at", () => {
    const world = makeWorld();
    for (const appliance of world.appliances.values()) {
      if (appliance.kind !== "table") continue;
      appliance.item = { id: appliance.id, base: "plate", processes: ["dirty"], contents: [] };
    }
    world.nextArrivalIn = 0;
    hold(world, 6, null);

    expect(world.customers).toHaveLength(1);
    expect(world.customers[0]!.state).toBe("waiting");
  });

  test("patience runs out and the customer walks out", () => {
    const world = makeWorld();
    const diner = seatCustomer(world, "fries");
    diner.remaining = 0.1;
    hold(world, 0.3, null);

    expect(diner.state).toBe("leaving");
    expect(world.lost).toBe(1);
  });

  test("a dining room walled off from the door is reported, not silently broken", () => {
    const world = makeWorld();
    expect(unreachableTables(world)).toHaveLength(0);

    // A player parks a counter in the doorway during the build phase — the
    // mistake somebody will make in their first week.
    const counter = applianceAtTile(world, COUNTER[0], COUNTER[1])!;
    world.applianceAt[COUNTER[1] * world.width + COUNTER[0]] = 0;
    counter.tile = { x: world.door.x + 1, y: world.door.y };
    world.applianceAt[counter.tile.y * world.width + counter.tile.x] = counter.id;

    expect(unreachableTables(world)).toHaveLength(4);

    // Nobody can sit, so nobody does — they wait at the door and give up.
    world.nextArrivalIn = 0;
    hold(world, 6, null);
    expect(world.customers[0]!.state).toBe("waiting");
  });

  test("the day does not end until the last customer has gone", () => {
    const world = makeWorld();
    const diner = seatCustomer(world, "salad");
    world.dayTime = 0.05;
    hold(world, 1, null);

    // Closing time has passed, but somebody is still sitting there.
    expect(world.phase).toBe("service");
    expect(world.dayTime).toBeLessThan(0);

    diner.remaining = 0.05;
    hold(world, 6, null);
    expect(world.phase).toBe("build");
  });

  test("arrivals stop before closing time", () => {
    const world = makeWorld();
    world.dayTime = 20; // inside the last-orders window
    world.nextArrivalIn = 0;
    hold(world, 5, null);
    expect(world.customers).toHaveLength(0);
  });
});
