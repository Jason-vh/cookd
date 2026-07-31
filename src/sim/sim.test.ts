import { describe, expect, test } from "bun:test";
import { applianceDef } from "../data/appliances";
import { CUSTOMER_KINDS, customerKind } from "../data/customers";
import { HIGHWAY_STOP, LEVEL } from "../data/level";
import { RECIPES, RECIPE_BY_ID } from "../data/recipes";
import { endDay, restartDay } from "./day";
import { DT, step } from "./step";
import {
  canPlace,
  customerSpeed,
  kitchenWarnings,
  mealLeft,
  unreachableAppliances,
  unreachableTables,
} from "./queries";
import { isDirty, isPlate, makeItem, specKey } from "./items";
import { seatsAround } from "./pathing";
import { across, edgeSeam, wallBetween } from "./walls";
import { LANE_QUEUE, laneCars, laneSpot } from "./lane";
import { snapshot } from "../save";
import { plateCount, platesInWorld } from "./plates";
import type { Appliance, ApplianceKind, Customer, Item, Player, PlayerInput, World } from "./types";
import { DOOR_QUEUE, DOOR_WAIT, eatTime } from "./systems/customers";
import {
  addPlayer,
  applianceAtTile,
  createWorld,
  emptyInput,
  isSolid,
  PLAYER_RADIUS,
  removePlayer,
  spawnAppliance,
} from "./world";

/**
 * These tests drive the simulation exactly like a player would — through
 * PlayerInput — which is only possible because `sim` has no DOM dependencies.
 * They double as executable documentation of the recipe pipeline.
 */

/**
 * A kitchen with the door closed, already open for business.
 *
 * Two things are being skipped past. Customers arrive on their own, and a test
 * about chopping a tomato should not be at the mercy of who walked in while it
 * ran — tests that *are* about the dining room open the door again by setting
 * `nextArrivalIn`. And a world now wakes in the **build phase**, which is right
 * for a player and wrong for a test about a fryer; `openWorld` is the one line
 * that says "assume somebody pressed Start".
 */
function makeWorld(): World {
  const world = createWorld(LEVEL, 1);
  world.nextArrivalIn = Infinity;
  equip(world);
  openWorld(world);
  return world;
}

/**
 * Give the kitchen the equipment a fully-grown one has.
 *
 * The park kitchen is a **starting point** now: salad only, two crates, and no
 * heat. Everything else arrives on a recipe card, which delivers it (see
 * `sim/cards.ts`). These tests are about the cooking rules rather than about
 * progression, so they equip the kitchen directly — on the tiles the level used
 * to put these things on, so every coordinate below still means what it says. The menu is opened up for the same reason: a customer cannot order a
 * pizza the room has never unlocked, and half of these tests are about pizza.
 */
function equip(world: World): void {
  for (const [base, tile] of Object.entries(CRATE)) {
    if (!applianceAtTile(world, tile[0], tile[1])) {
      spawnAppliance(world, "crate", { x: tile[0], y: tile[1] }, { base, processes: [] });
    }
  }
  spawnAppliance(world, "oven", { x: OVEN[0], y: OVEN[1] });
  spawnAppliance(world, "fryer", { x: FRYER[0], y: FRYER[1] });
  world.unlocked = RECIPES.map((recipe) => recipe.id);
}

/** Put a world into service without going through a morning. */
function openWorld(world: World): void {
  world.phase = "service";
  world.dayTime = world.dayLength;
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

// Tile coordinates from data/level.ts. The kitchen sits two columns east and
// two rows south of the grid's origin: the patio ring is part of the world.
const CRATE = {
  tomato: [9, 2],
  lettuce: [10, 2],
  cheese: [11, 2],
  flour: [12, 2],
  water: [13, 2],
  potato: [14, 2],
} as const;
const PLATES = [15, 2] as const;
const SINK = [16, 2] as const;
const BIN = [19, 2] as const;
const BOARD = [11, 4] as const;
const COUNTER = [10, 4] as const;
// Not in the level any more: `equip` stands them here, as a card's delivery
// would. An oven used to be embedded in the east wall; a delivered one lands on
// an interior tile, which is the only place the game may put anything.
const OVEN = [19, 5] as const;
const FRYER = [19, 8] as const;
const PASS = [8, 5] as const;
/** A table in the dining room, approached from the tile above it. */
const TABLE = [3, 3] as const;
/** The dining room's other table, for tests that need two people at once. */
const TABLE2 = [3, 7] as const;
/** The middle slot of the market stall, faced from the patio beside it. */
const STALL = [0, 3] as const;
/** The sign, standing against the wall beside the door, faced from the east. */
const SIGN = [2, 4] as const;

/**
 * Turn the sign: the only way in or out of service a player has.
 *
 * The verb is a plain `Grab` at a tile, which is the entire point of the sign
 * existing — opening the restaurant is a chef walking somewhere and doing
 * something, like every other rule in the game.
 */
function flipSign(world: World): void {
  face(world.players[0]!, SIGN[0], SIGN[1], -1, 0);
  press(world, "grab");
}

/**
 * Sit somebody at a table with an order already placed — the state the delivery
 * rules care about, without walking them in from the park first.
 *
 * An ordinary regular unless a test says otherwise, so every multiplier in
 * `data/customers.ts` is 1 and the recipe's own numbers still mean what they
 * say.
 */
function seatCustomer(
  world: World,
  recipeId: string,
  tile: readonly [number, number] = TABLE,
  kind = "regular",
): Customer {
  const table = applianceAtTile(world, tile[0], tile[1])!;
  const recipe = RECIPE_BY_ID.get(recipeId)!;
  const patience = recipe.patience * customerKind(kind).patience;
  const seat = { x: tile[0] + 1, y: tile[1] };
  const customer: Customer = {
    id: world.nextId++,
    state: "ordering",
    pos: { x: seat.x + 0.5, y: seat.y + 0.5 },
    prevPos: { x: seat.x + 0.5, y: seat.y + 0.5 },
    facing: { x: -1, y: 0 },
    table: table.id,
    seat,
    party: 0,
    plate: null,
    recipeId,
    kind,
    path: [],
    timer: 0,
    remaining: patience,
    patience,
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
function workOn(world: World, tile: readonly [number, number], seconds: number): void {
  face(world.players[0]!, tile[0], tile[1], 0, -1);
  hold(world, 2 * DT, null);
  hold(world, seconds);
}

/**
 * Leave a dirty plate on every table: a dining room with nowhere to sit, which
 * is what the door queue is for. Returns the tables, so a test can bus one.
 */
function blockTables(world: World): Appliance[] {
  const tables = [...world.appliances.values()].filter((a) => a.kind === "table");
  for (const table of tables) {
    table.item = { id: table.id, base: "plate", processes: ["dirty"], contents: [] };
  }
  return tables;
}

/** A used plate, put somewhere directly — no customer required. */
function dirtyPlate(world: World, tile: readonly [number, number]): Item {
  const plate: Item = { id: world.nextId++, base: "plate", processes: ["dirty"], contents: [] };
  applianceAtTile(world, tile[0], tile[1])!.item = plate;
  return plate;
}

/** Build a portion of fries from scratch, plate it, and hold it. */
function makeFries(world: World): void {
  takeFrom(world, CRATE.potato);
  putOn(world, BOARD);
  workOn(world, BOARD, 2.6);
  takeFrom(world, BOARD);
  putOn(world, FRYER, 1, 0);
  hold(world, 5.1, null);
  takeFrom(world, FRYER, 1, 0);
  putOn(world, COUNTER);
  takeFrom(world, PLATES);
  putOn(world, COUNTER);
  takeFrom(world, COUNTER);
}

/** Build a garden salad from scratch, plate it, and hold it. */
function makeSalad(world: World): void {
  takeFrom(world, CRATE.lettuce);
  putOn(world, BOARD);
  workOn(world, BOARD, 2.1);
  takeFrom(world, BOARD);
  putOn(world, COUNTER);
  takeFrom(world, CRATE.tomato);
  putOn(world, BOARD);
  workOn(world, BOARD, 2.1);
  takeFrom(world, BOARD);
  putOn(world, COUNTER); // combines into a salad
  takeFrom(world, PLATES);
  putOn(world, COUNTER); // plate the salad
  takeFrom(world, COUNTER);
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
    workOn(world, BOARD, 2.1);
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
    workOn(world, CRATE.lettuce, 0); // (no-op, keeps the sequence readable)
    putOn(world, BOARD);
    workOn(world, BOARD, 2.1);
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
    workOn(world, BOARD, 2.1);
    takeFrom(world, BOARD);
    takeFrom(world, PLATES); // plated lettuce
    putOn(world, COUNTER);

    takeFrom(world, CRATE.tomato);
    putOn(world, BOARD);
    workOn(world, BOARD, 2.1);
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

    workOn(world, BOARD, 2.1);
    expect(applianceAtTile(world, BOARD[0], BOARD[1])!.item!.processes).toEqual(["chopped"]);
  });

  test("walking flush along a wall of appliances does not teleport the player", () => {
    // Regression: `2.32 - 0.32` is 1.9999... in floating point, which used to
    // make the collision code think the player overlapped the tile above and
    // eject them sideways out of the kitchen.
    const world = makeWorld();
    const player = world.players[0]!;
    player.pos.x = 9.33;
    player.pos.y = 3.32; // pressed flush against the crate row

    const inputs = idle();
    inputs[0]!.move.x = 1;
    for (let i = 0; i < 60; i++) step(world, inputs);

    expect(player.pos.y).toBeCloseTo(3.32, 6);
    expect(player.pos.x).toBeGreaterThan(12);
    expect(player.pos.x).toBeLessThan(world.width);
  });

  test("you can prep on any counter, just more slowly than on a board", () => {
    const counterWorld = makeWorld();
    takeFrom(counterWorld, CRATE.tomato);
    putOn(counterWorld, COUNTER);
    workOn(counterWorld, COUNTER, 2.1);
    expect(applianceAtTile(counterWorld, COUNTER[0], COUNTER[1])!.item!.processes).toEqual([
      "chopped",
    ]);

    // The board is 1.75x faster, so the same work is done well before 2s.
    const boardWorld = makeWorld();
    takeFrom(boardWorld, CRATE.tomato);
    putOn(boardWorld, BOARD);
    workOn(boardWorld, BOARD, 1.25);
    expect(applianceAtTile(boardWorld, BOARD[0], BOARD[1])!.item!.processes).toEqual(["chopped"]);

    // ...and a counter is not finished by then.
    const slowWorld = makeWorld();
    takeFrom(slowWorld, CRATE.tomato);
    putOn(slowWorld, COUNTER);
    workOn(slowWorld, COUNTER, 1.25);
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
    workOn(world, BOARD, 2.6);
    takeFrom(world, BOARD);
    putOn(world, FRYER, 1, 0);

    hold(world, 5.1, null);
    expect(applianceAtTile(world, FRYER[0], FRYER[1])!.item!.base).toBe("fries");

    hold(world, 6.1, null);
    expect(applianceAtTile(world, FRYER[0], FRYER[1])!.item!.processes).toContain("burnt");
  });
});

/** A pizza that has just come out, put straight onto an appliance. */
function bakedPizza(): Item {
  return { id: 1, base: "pizza", processes: ["sauced", "topped", "baked"], contents: [] };
}

/**
 * Upgrades: the first purchase that changes how a kitchen works rather than how
 * much of it there is.
 *
 * Both of them are built out of columns that already existed — `speed` and
 * `patience` — so what these tests really pin is that a better appliance is a
 * row in `data/appliances.ts` and nothing anywhere else.
 */
describe("upgrades", () => {
  /** Free interior tiles, faced from the row above, as everything here is. */
  const STEEL_BOARD = [15, 6] as const;
  const BELL_OVEN = [18, 6] as const;

  test("a steel board finishes a chop a wooden one is still working on", () => {
    const world = makeWorld();
    spawnAppliance(world, "steel_board", { x: STEEL_BOARD[0], y: STEEL_BOARD[1] });
    takeFrom(world, CRATE.tomato);
    putOn(world, STEEL_BOARD);
    workOn(world, STEEL_BOARD, 0.8);
    expect(applianceAtTile(world, STEEL_BOARD[0], STEEL_BOARD[1])!.item!.processes).toEqual([
      "chopped",
    ]);

    // The same 0.8s on the wooden board it improves on is not enough.
    const wooden = makeWorld();
    takeFrom(wooden, CRATE.tomato);
    putOn(wooden, BOARD);
    workOn(wooden, BOARD, 0.8);
    expect(applianceAtTile(wooden, BOARD[0], BOARD[1])!.item!.processes).toEqual([]);
  });

  test("a bell oven sells time: the same pizza lasts three times as long", () => {
    // This is about what happens *after* the timer finishes, which is the only
    // moment heat is dangerous.
    const world = makeWorld();
    applianceAtTile(world, OVEN[0], OVEN[1])!.item = bakedPizza();
    spawnAppliance(world, "bell_oven", { x: BELL_OVEN[0], y: BELL_OVEN[1] });
    applianceAtTile(world, BELL_OVEN[0], BELL_OVEN[1])!.item = bakedPizza();

    // A pizza burns after 8s on a plain oven, and the bell one is still fine.
    hold(world, 8.2, null);
    expect(applianceAtTile(world, OVEN[0], OVEN[1])!.item!.processes).toContain("burnt");
    expect(applianceAtTile(world, BELL_OVEN[0], BELL_OVEN[1])!.item!.processes).not.toContain(
      "burnt",
    );

    // It is a longer fuse, not a fireproof one: forget it entirely and it goes
    // the same way. Nothing in this kitchen looks after itself.
    hold(world, 16.2, null);
    expect(applianceAtTile(world, BELL_OVEN[0], BELL_OVEN[1])!.item!.processes).toContain("burnt");
  });
});

/**
 * The plate economy: finite crockery, and the sink that keeps it moving.
 *
 * The invariant these are really about is that **plates are conserved**. A game
 * where the supply can shrink is a game that soft-locks a few days in, from a
 * save nobody can repair — so the last test here counts them across everything
 * that could quietly eat one.
 */
describe("plates", () => {
  test("the kitchen owns a fixed number of plates, and can run out", () => {
    const world = makeWorld();
    const stack = applianceAtTile(world, PLATES[0], PLATES[1])!;
    expect(plateCount(stack.item)).toBe(LEVEL.plates);

    takeFrom(world, PLATES);
    expect(world.players[0]!.carried?.base).toBe("plate");
    expect(plateCount(stack.item)).toBe(LEVEL.plates - 1);

    // The last plate leaves an empty stack, and an empty stack hands out
    // nothing. This is the pressure the whole feature exists to create.
    stack.item = null;
    putOn(world, COUNTER);
    takeFrom(world, PLATES);
    expect(world.players[0]!.carried).toBeNull();

    // ...including for the shortcut that plates food where it stands.
    takeFrom(world, CRATE.tomato);
    takeFrom(world, PLATES);
    expect(world.players[0]!.carried?.base).toBe("tomato");
  });

  test("dirty plates stack in hand, and the sink washes them one at a time", () => {
    const world = makeWorld();
    dirtyPlate(world, COUNTER);
    dirtyPlate(world, PASS);

    takeFrom(world, COUNTER);
    takeFrom(world, PASS);
    // One bussing sweep, not one trip per plate.
    expect(plateCount(world.players[0]!.carried)).toBe(2);

    putOn(world, SINK);
    const sink = applianceAtTile(world, SINK[0], SINK[1])!;
    expect(plateCount(sink.item)).toBe(2);

    // One hold, one plate — and the pile still reads dirty while any of it is,
    // because the plate that gives it its identity is washed last.
    workOn(world, SINK, 1.6);
    expect(isDirty(sink.item)).toBe(true);
    expect(plateCount(sink.item)).toBe(2);

    workOn(world, SINK, 1.6);
    expect(isDirty(sink.item)).toBe(false);

    takeFrom(world, SINK);
    putOn(world, PLATES);
    expect(world.players[0]!.carried).toBeNull();
    expect(plateCount(applianceAtTile(world, PLATES[0], PLATES[1])!.item)).toBe(LEVEL.plates + 2);
  });

  test("a dirty plate refuses food, and the stack refuses a dirty plate", () => {
    const world = makeWorld();
    dirtyPlate(world, COUNTER);
    takeFrom(world, COUNTER);

    putOn(world, PLATES);
    expect(isDirty(world.players[0]!.carried)).toBe(true);

    // A dirty plate is not a workspace either — see `tryPlate`.
    const before = plateCount(world.players[0]!.carried);
    putOn(world, CRATE.tomato);
    expect(plateCount(world.players[0]!.carried)).toBe(before);
    expect(world.players[0]!.carried!.contents).toHaveLength(0);
  });

  test("the bin scrapes a plate rather than swallowing it", () => {
    const world = makeWorld();
    makeSalad(world);
    expect(world.players[0]!.carried!.contents).toHaveLength(1);

    putOn(world, BIN);
    const kept = world.players[0]!.carried!;
    expect(kept.base).toBe("plate");
    expect(kept.contents).toHaveLength(0);
    // Scraped, so it goes to the sink like any other used plate. The bin is not
    // a way to make a mistake disappear entirely.
    expect(isDirty(kept)).toBe(true);
  });

  test("a customer standing up scrapes what is on the table, whatever it is", () => {
    const world = makeWorld();
    const diner = seatCustomer(world, "salad");
    makeSalad(world);
    putOn(world, TABLE, 0, 1);
    const table = applianceAtTile(world, TABLE[0], TABLE[1])!;

    // Clear the table mid-meal and leave a pile of clean plates there instead.
    // Nothing stops a chef doing this, and rewriting whatever is on the table
    // into "one dirty plate" used to destroy the rest of the pile.
    takeFrom(world, TABLE, 0, 1);
    putOn(world, SINK);
    takeFrom(world, PLATES);
    putOn(world, PASS);
    takeFrom(world, PLATES);
    takeFrom(world, PASS);
    expect(plateCount(world.players[0]!.carried)).toBe(2);
    putOn(world, TABLE, 0, 1);

    const before = platesInWorld(world);
    hold(world, 13, null);
    expect(diner.state).toBe("leaving");
    expect(platesInWorld(world)).toBe(before);
    expect(plateCount(table.item)).toBe(2);
    // Nothing was eaten off them, so they are still clean.
    expect(isDirty(table.item)).toBe(false);
  });

  test("a customer cannot conjure a plate out of whatever was left on the table", () => {
    const world = makeWorld();
    const diner = seatCustomer(world, "salad");
    makeSalad(world);
    putOn(world, TABLE, 0, 1);

    takeFrom(world, TABLE, 0, 1);
    putOn(world, SINK);
    takeFrom(world, CRATE.tomato);
    putOn(world, TABLE, 0, 1);

    const before = platesInWorld(world);
    hold(world, 13, null);
    expect(diner.state).toBe("leaving");
    expect(platesInWorld(world)).toBe(before);
    expect(applianceAtTile(world, TABLE[0], TABLE[1])!.item?.base).toBe("tomato");
  });

  test("the sink takes more than a chef can carry, but not onto clean ones", () => {
    const world = makeWorld();
    const sink = applianceAtTile(world, SINK[0], SINK[1])!;

    // Five, which is more than one chef can carry: a sink is where the
    // washing-up goes, and the hands' limit has no business being its capacity.
    for (let i = 0; i < 5; i++) {
      dirtyPlate(world, COUNTER);
      takeFrom(world, COUNTER);
      putOn(world, SINK);
    }
    expect(plateCount(sink.item)).toBe(5);

    // Washed, and still in the basin: dirty plates must not be piled on top of
    // them, or they are washing-up hidden inside a pile that reads as clean.
    workOn(world, SINK, 8);
    expect(isDirty(sink.item)).toBe(false);

    dirtyPlate(world, COUNTER);
    takeFrom(world, COUNTER);
    putOn(world, SINK);
    expect(plateCount(sink.item)).toBe(5);
    expect(isDirty(world.players[0]!.carried)).toBe(true);
  });

  test("a day cannot start under somebody carrying the plate stack", () => {
    const world = makeWorld();
    world.phase = "build";
    const player = world.players[0]!;
    face(player, PLATES[0], PLATES[1], 0, -1);
    press(world, "grab");
    expect(player.carriedAppliance).not.toBeNull();

    // Both routes into service refuse. Opening a day always did; restarting one
    // did not, and it wipes the kitchen on the way — with the only plate stack
    // in somebody's hands, that wipe had nowhere to put the plates and the
    // kitchen came back with none. It also strands the holder: there is no way
    // to put an appliance down during service.
    //
    // Note the sign is turned *while carrying the plate stack*, which is a
    // thing a player can now do: refusing has to be the day's rule, not an
    // accident of not being able to reach the sign with your hands full.
    flipSign(world);
    restartDay(world);
    expect(world.phase).toBe("build");
    expect(player.carriedAppliance).not.toBeNull();
    expect(platesInWorld(world)).toBe(LEVEL.plates);
  });

  test("plates are conserved: served, binned, carried off, closed up, rebuilt", () => {
    const world = makeWorld();
    const owned = LEVEL.plates;
    expect(platesInWorld(world)).toBe(owned);

    // A customer eats off one and leaves it dirty on the table.
    seatCustomer(world, "salad");
    makeSalad(world);
    putOn(world, TABLE, 0, 1);
    hold(world, 13, null);
    expect(platesInWorld(world)).toBe(owned);

    // A ruined dish goes in the bin.
    makeSalad(world);
    putOn(world, BIN);
    expect(platesInWorld(world)).toBe(owned);

    // Somebody's connection drops while they are holding the washing-up.
    const leaver = addPlayer(world, LEVEL, "Ghost");
    leaver.carried = world.players[0]!.carried;
    world.players[0]!.carried = null;
    removePlayer(world, leaver.id);
    expect(platesInWorld(world)).toBe(owned);

    // Closing time wipes the kitchen, dirty plates and all.
    endDay(world);
    expect(platesInWorld(world)).toBe(owned);
    expect(plateCount(applianceAtTile(world, PLATES[0], PLATES[1])!.item)).toBe(owned);

    // And the build phase, where lifting an appliance empties it — including
    // the plate stack, whose contents are the kitchen's entire supply.
    const player = world.players[0]!;
    face(player, PLATES[0], PLATES[1], 0, -1);
    press(world, "grab");
    expect(platesInWorld(world)).toBe(owned);
    face(player, COUNTER[0], COUNTER[1], 0, -1);
    press(world, "grab");
    expect(platesInWorld(world)).toBe(owned);
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
    workOn(world, BOARD, 3.1);
    takeFrom(world, BOARD);
    putOn(world, COUNTER);

    // Sauce = tomato chopped *twice*, which one long hold will do: keeping USE
    // down means keeping working, straight through the finished first chop.
    takeFrom(world, CRATE.tomato);
    putOn(world, BOARD);
    workOn(world, BOARD, 3.0);
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
    workOn(world, BOARD, 2.1);
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
    face(world.players[0]!, 15, 5, 0, -1);
    press(world, "grab");
    expect(applianceAtTile(world, 15, 5)!.id).toBe(board.id);

    flipSign(world);
    expect(world.phase).toBe("service");
  });

  test("a room wakes into the morning, and the day turns at closing time", () => {
    // The build phase is the morning of the day it precedes, not the wreckage
    // of the one before. A fresh kitchen is therefore standing in day one's
    // morning, and nothing happens until somebody opens it.
    const world = createWorld(LEVEL, 1);
    world.nextArrivalIn = Infinity;
    expect(world.phase).toBe("build");
    expect(world.day).toBe(1);

    flipSign(world);
    expect(world.phase).toBe("service");
    expect(world.day).toBe(1); // still day one — opening does not advance it

    world.dayTime = 0.05;
    hold(world, 0.2, null);
    expect(world.phase).toBe("build");
    expect(world.day).toBe(2); // ...closing does
  });

  test("closing takes nothing out of the till", () => {
    // A day's takings are the day's takings. There is no rent and no standing
    // cost of any kind: the pressure is what a kitchen cannot afford to buy,
    // never a number that arrives while nobody is looking.
    const world = makeWorld();
    world.money = 10;
    world.dayTime = 0.05;
    hold(world, 0.2, null);

    expect(world.money).toBe(10);
    expect(world.phase).toBe("build");
  });
});

/**
 * The sign in the door — the whole of opening and closing a restaurant.
 *
 * It is here rather than beside the stall tests because it is the *day loop*
 * seen from the room: the same two transitions the phase system used to make on
 * a keypress, now made by a chef standing in front of an object.
 */
describe("the sign by the door", () => {
  test("turning it opens the day", () => {
    const world = createWorld(LEVEL, 1);
    world.nextArrivalIn = Infinity;

    flipSign(world);
    expect(world.phase).toBe("service");
    expect(world.dayTime).toBeGreaterThan(0);
  });

  test("...and only from in front of it", () => {
    // It is an object in a room, so it obeys the rule every other object does:
    // you have to be there. Standing one tile short of the sign, facing it.
    const world = createWorld(LEVEL, 1);
    face(world.players[0]!, 3, 5, -1, 0);
    press(world, "grab");

    expect(world.phase).toBe("build");
  });

  test("turning it during service calls last orders rather than clearing the room", () => {
    // The difference that makes this a sign and not a stop button. The dining
    // room is full of people who have ordered; closing up cannot mean sweeping
    // them out, so the clock runs out early and the closing beat every ordinary
    // day ends with takes over from there.
    const world = makeWorld();
    const diner = seatCustomer(world, "salad");

    flipSign(world);
    expect(world.phase).toBe("service");
    expect(world.dayTime).toBeLessThanOrEqual(0);
    expect(world.customers).toContain(diner);

    // Feed them and the day closes itself, exactly as it would at 0:00.
    makeSalad(world);
    putOn(world, TABLE, 0, 1);
    hold(world, eatTime(diner) + 6, null);
    expect(world.phase).toBe("build");
  });

  test("an empty room closes immediately", () => {
    const world = makeWorld();
    expect(world.customers).toHaveLength(0);

    flipSign(world);
    hold(world, 0.2, null);
    expect(world.phase).toBe("build");
    expect(world.day).toBe(2);
  });

  test("you can stand under it, and turning it is what standing there is for", () => {
    // Walking up to the sign means ending up on its tile facing the wall it
    // hangs on: the square in front is then out on the patio, and pointing at
    // nothing there would refuse the one approach anybody takes.
    const world = createWorld(LEVEL, 1);
    const player = world.players[0]!;
    player.pos = { x: SIGN[0] + 1.5, y: SIGN[1] + 0.5 };
    player.prevPos = { ...player.pos };

    const inputs = idle();
    inputs[0]!.move = { x: -1, y: 0 };
    for (let i = 0; i < 60; i++) step(world, inputs);
    expect(Math.floor(player.pos.x)).toBe(SIGN[0]);

    press(world, "grab");
    expect(world.phase).toBe("service");
  });

  test("it is furniture of the place: immovable, and never saved", () => {
    // The same contract as the stall and the card stand. A sign a player could
    // pick up and sell is a kitchen that can lose the ability to open.
    const world = createWorld(LEVEL, 1);
    const sign = [...world.appliances.values()].find((a) => a.kind === "sign")!;
    face(world.players[0]!, sign.tile.x, sign.tile.y, -1, 0);

    // A grab at it opens the day rather than lifting it, so this is asked of
    // the world it left behind: nobody is carrying anything.
    press(world, "grab");
    expect(world.players[0]!.carriedAppliance).toBeNull();
    expect(applianceDef("sign").movable).toBe(false);
    expect(snapshot(world).appliances.some((a) => a.kind === "sign")).toBe(false);
  });

  test("it hangs on the wall, so the wall plugs the hole and the sign takes no floor", () => {
    const world = createWorld(LEVEL, 1);
    const sign = [...world.appliances.values()].find((a) => a.kind === "sign")!;

    // The shell behind it is unbroken — that is what stops the building being a
    // hole with a sign in it, and it was never the sign's job.
    const seam = edgeSeam(world.room, sign.tile);
    expect(wallBetween(world, sign.tile, across(seam, sign.tile))).toBe(true);
    // So its square is ordinary floor: walk over it, build nothing on it.
    expect(isSolid(world, sign.tile.x, sign.tile.y)).toBe(false);
    expect(canPlace(world, sign.tile.x, sign.tile.y)).toBe(false);
    // ...and it is beside the door, which is the only reason a player finds it.
    const away = Math.abs(sign.tile.x - world.door.x) + Math.abs(sign.tile.y - world.door.y);
    expect(away).toBe(1);
  });
});

/**
 * The patio ring: the paving outside the walls, which is now real tiles.
 *
 * "Walkable = paved" is the whole claim. What a player can see, what collision
 * allows and what the simulation believes about the map are one thing, so the
 * stall has somewhere to stand and the ovens in the east wall have a back.
 */
/**
 * Take every appliance of these kinds out of the world, as a sale would.
 *
 * The ids are collected before the loop rather than deleted while iterating the
 * live map — a `Map` tolerates that, and relying on it is how a test starts
 * depending on something nobody promised.
 */
function sellOff(world: World, kinds: ApplianceKind[]): void {
  const doomed = [...world.appliances.values()].filter((a) => kinds.includes(a.kind));
  for (const appliance of doomed) {
    world.applianceAt[appliance.tile.y * world.width + appliance.tile.x] = 0;
    world.appliances.delete(appliance.id);
  }
}

/**
 * What the kitchen says is wrong with it.
 *
 * The house rule for this whole class of mistake is **say it, do not prevent
 * it** — the build phase's promise is that you may rearrange your own
 * restaurant into something silly, and the stall only widened the ways to do
 * that. The alternative was a shop that refuses to sell you things, and the
 * honest version of that list is most of the kitchen.
 */
describe("what the kitchen says is wrong with it", () => {
  test("a kitchen that works says nothing at all", () => {
    // The one that matters most: a warning that fires on a healthy kitchen is a
    // warning players learn to read past, and then the real one is invisible.
    for (const day of [1, 2, 3, 8]) {
      const world = makeWorld();
      world.day = day;
      expect(kitchenWarnings(world)).toEqual([]);
    }
  });

  test("a dish whose station has been sold is named, because customers still order it", () => {
    // Arrivals pick from what the *room* unlocked, not from what the kitchen can
    // cook — so without this a room that sold the oven its pizza card delivered
    // takes orders it can never fill and watches them walk out with no
    // explanation.
    const world = makeWorld();
    world.unlocked = ["salad", "pizza"];
    sellOff(world, ["oven"]);
    expect(kitchenWarnings(world)).toEqual(["Pizza can't be made here"]);

    // Take pizza back off the menu and there is nothing to say: the warning is
    // about the gap between the menu and the kitchen, not about the oven.
    world.unlocked = ["salad"];
    expect(kitchenWarnings(world)).toEqual([]);
  });

  test("a kitchen that can cook nothing has one problem, not three", () => {
    // Every surface capable of holding a knife, sold. Salad, fries and pizza all
    // start with a chop, so listing them one by one would bury the actual fault.
    const world = makeWorld();
    sellOff(world, ["counter", "board"]);
    expect(kitchenWarnings(world)).toEqual(["Nothing on the menu can be made here"]);

    // Same sentence from the other end: the stations are there, the ingredients
    // are not. The check walks the recipes rather than naming appliances, so it
    // cannot drift from the content the way a hand-kept list would.
    const starved = makeWorld();
    sellOff(starved, ["crate"]);
    expect(kitchenWarnings(starved)).toEqual(["Nothing on the menu can be made here"]);
  });

  test("selling the last table, or the last bin, is allowed and reported", () => {
    const roomless = makeWorld();
    sellOff(roomless, ["table"]);
    expect(kitchenWarnings(roomless)).toEqual(["No tables — nobody can sit down"]);

    // The bin is deliberately *not* on the stall's do-not-sell list: losing it
    // costs a plate per ruined dish only until closing time, because closing up
    // washes up. So it is a sentence, not a refusal.
    const messy = makeWorld();
    sellOff(messy, ["bin"]);
    expect(kitchenWarnings(messy)).toEqual(["No bin — a ruined dish has nowhere to go"]);
  });

  test("an appliance no chef can walk up to is named", () => {
    // The other half of the walled-off dining room, from the kitchen's side: a
    // bin boxed into its corner is a bin that may as well have been sold.
    const world = makeWorld();
    expect(unreachableAppliances(world)).toHaveLength(0);

    spawnAppliance(world, "counter", { x: BIN[0], y: BIN[1] + 1 });
    expect(unreachableAppliances(world).map((appliance) => appliance.kind)).toEqual(["bin"]);
    expect(kitchenWarnings(world)).toContain("Can't be walked up to: Bin");

    // Nobody in the room, no answer to give: reachability is measured from the
    // chefs, and a kitchen with none of them is not a kitchen with a problem.
    world.players = [];
    expect(unreachableAppliances(world)).toHaveLength(0);
  });

  test("a chef who has walled themselves in has one problem, not eight", () => {
    // Seal the whole back run behind a wall of counters. Naming five appliances
    // would describe the symptoms of a single wall, so past a few it counts
    // instead — the same rule as "nothing on the menu can be made here".
    const world = makeWorld();
    for (let x = PLATES[0]; x <= BIN[0]; x++) spawnAppliance(world, "counter", { x, y: 3 });

    expect(unreachableAppliances(world)).toHaveLength(5);
    expect(kitchenWarnings(world)).toContain("5 appliances can't be walked up to");
  });

  test("a burnt dish costs a plate for the day, and not one minute longer", () => {
    // This is the load-bearing fact behind leaving the bin sellable. If it ever
    // stops being true — if food or dirt survives the night — the bin becomes
    // structural and belongs on the essential list instead.
    const world = makeWorld();
    sellOff(world, ["bin"]);

    // Take the kitchen's whole supply off the stack and bury every plate under
    // a burnt pizza. With no bin there is now no legal move: nothing can be
    // scraped, nothing can be plated, nothing can be served.
    const stack = applianceAtTile(world, PLATES[0], PLATES[1])!;
    const counter = applianceAtTile(world, COUNTER[0], COUNTER[1])!;
    stack.item = null;
    counter.item = {
      id: world.nextId++,
      base: "plate",
      processes: [],
      contents: [
        { id: world.nextId++, base: "pizza", processes: ["sauced", "burnt"], contents: [] },
      ],
    };
    expect(platesInWorld(world)).toBe(1);

    // Closing up washes up. The food is gone, the plate is back on the stack,
    // clean, and tomorrow starts whole.
    endDay(world);
    const home = applianceAtTile(world, PLATES[0], PLATES[1])!;
    expect(platesInWorld(world)).toBe(1);
    expect(plateCount(home.item)).toBe(1);
    expect(isDirty(home.item)).toBe(false);
    expect(home.item!.contents.filter((child) => child.base !== "plate")).toHaveLength(0);
  });
});

describe("walls between blocks", () => {
  test("a wall takes no floor: the divider is a line, not a column of squares", () => {
    // The whole of the change, in one assertion. The dividing wall used to be a
    // column of solid tiles as wide as the counters either side of it; the
    // square it stood on is ordinary kitchen floor now, and the wall is the
    // line down one edge of it.
    const world = makeWorld();
    expect(isSolid(world, PASS[0], PASS[1] - 1)).toBe(false);
    expect(canPlace(world, PASS[0], PASS[1] - 1)).toBe(true);
  });

  test("a chef is stopped by the line, and goes round through the gap", () => {
    const world = makeWorld();
    const player = world.players[0]!;
    const eastFrom = (y: number): number => {
      player.pos = { x: 3.5, y };
      player.prevPos = { ...player.pos };
      const inputs = idle();
      inputs[0]!.move = { x: 1, y: 0 };
      for (let i = 0; i < 120; i++) step(world, inputs);
      return player.pos.x;
    };

    // Walled: they come to rest flush against the seam, half a tile further
    // east than a wall of squares would have let them.
    expect(eastFrom(2.5)).toBeCloseTo(PASS[0] - PLAYER_RADIUS, 3);
    // The gap beside the pass: through it, and on into the kitchen.
    expect(eastFrom(PASS[1] - 0.5)).toBeGreaterThan(PASS[0] + 1);
  });

  test("turning around against a wall walks away from it, not through it", () => {
    // Regression: resting flush against a seam puts the whole body in the
    // square before it, so the seam behind the new leading edge on the frame
    // the chef turns round is the wall they were leaning on. Treating it as
    // just-crossed resolved them to its far side — a step west through the
    // pass wall landed them in the kitchen.
    const world = makeWorld();
    const player = world.players[0]!;
    player.pos = { x: 3.5, y: 2.5 };
    player.prevPos = { ...player.pos };

    const inputs = idle();
    inputs[0]!.move = { x: 1, y: 0 };
    for (let i = 0; i < 120; i++) step(world, inputs);
    expect(player.pos.x).toBeCloseTo(PASS[0] - PLAYER_RADIUS, 3);

    inputs[0]!.move = { x: -1, y: 0 };
    step(world, inputs);
    expect(player.pos.x).toBeLessThan(PASS[0] - PLAYER_RADIUS);
  });

  test("a square against the wall has three sides, and the fourth is not one", () => {
    // What `seatsAround` is for, and why it had to learn about walls: the tile
    // west of the sign is paving, walkable, and on the other side of the shell.
    // A chair there is a chair nobody can sit in.
    const world = makeWorld();
    expect(seatsAround(world, { x: SIGN[0], y: SIGN[1] })).toHaveLength(3);
  });
});

describe("the patio ring", () => {
  test("a chef can walk right round the building, and no further", () => {
    const world = makeWorld();
    const player = world.players[0]!;
    player.pos = { x: 0.5, y: 0.5 };
    player.prevPos = { ...player.pos };

    // East along the top of the ring, then south down its far side. Walls stop
    // them going in; the edge of the world stops them going out.
    const walk = (dx: number, dy: number, ticks: number): void => {
      const inputs = idle();
      inputs[0]!.move = { x: dx, y: dy };
      for (let i = 0; i < ticks; i++) step(world, inputs);
    };

    walk(1, 0, 400);
    expect(player.pos.x).toBeGreaterThan(world.width - 2);
    expect(player.pos.x).toBeLessThan(world.width);
    expect(player.pos.y).toBeCloseTo(0.5, 3); // never entered the building

    walk(0, 1, 400);
    expect(player.pos.y).toBeGreaterThan(world.height - 2);
    expect(player.pos.y).toBeLessThan(world.height);

    walk(-1, 0, 400);
    expect(player.pos.x).toBeGreaterThan(0);
    expect(player.pos.x).toBeLessThan(2);
  });

  test("nothing may be built on the paving, but the doorway is the player's business", () => {
    const world = makeWorld();
    // Patio: refused, and the ghost turns red because it asks the same question.
    expect(canPlace(world, 0, 0)).toBe(false);
    expect(canPlace(world, world.width - 1, world.height - 1)).toBe(false);
    // Kitchen floor: allowed.
    expect(canPlace(world, COUNTER[0], COUNTER[1])).toBe(true);
    // The doorway is allowed, deliberately: sealing your own dining room off is
    // a mistake the build phase warns about rather than prevents.
    expect(canPlace(world, world.door.x, world.door.y)).toBe(true);
  });

  test("an appliance against the wall has one side, and it is the inside", () => {
    // Walls stand on the seams between tiles now, so the back of an oven on the
    // east run is the wall itself. A chef out on the paving is facing the
    // *square* it stands on and can no longer touch what is on it — which is
    // the rule that used to come for free when a wall was a tile in between.
    const world = makeWorld();
    const oven = { x: 19, y: 6 };
    spawnAppliance(world, "oven", oven);

    takeFrom(world, CRATE.tomato);
    putOn(world, [oven.x, oven.y] as const, -1, 0); // from the patio, through the wall
    expect(applianceAtTile(world, oven.x, oven.y)!.item).toBeNull();
    expect(world.players[0]!.carried).not.toBeNull();

    putOn(world, [oven.x, oven.y] as const, 1, 0); // from inside the kitchen
    expect(applianceAtTile(world, oven.x, oven.y)!.item?.base).toBe("tomato");
    expect(world.players[0]!.carried).toBeNull();
  });

  test("a customer walks in over the paving, not through it", () => {
    // The approach used to be a straight line drawn from off-grid to the door,
    // which was fine while "outside" was painted scenery. It is tiles now, with
    // a market stall standing on some of them, so the walk in is a real path
    // over the same map everybody else uses.
    const world = makeWorld();
    world.nextArrivalIn = 0;
    step(world, idle());
    const customer = world.customers[0]!;
    expect(customer.path.length).toBeGreaterThan(0);

    for (const point of customer.path) {
      const tile = { x: Math.floor(point.x), y: Math.floor(point.y) };
      expect(isSolid(world, tile.x, tile.y)).toBe(false);
    }
    // Through the doorway, every time: the ring goes right round the building,
    // but the only way *in* is the door.
    expect(
      customer.path.some(
        (point) => Math.floor(point.x) === world.door.x && Math.floor(point.y) === world.door.y,
      ),
    ).toBe(true);
  });

  test("the stall stands on the paving, and is not something you can pick up", () => {
    const world = makeWorld();
    const stall = applianceAtTile(world, STALL[0], STALL[1])!;
    expect(stall.kind).toBe("stall");

    // Immovable, so the build phase cannot lift it and cannot swap onto it.
    endDay(world);
    face(world.players[0]!, STALL[0], STALL[1], -1, 0);
    press(world, "grab");
    expect(world.players[0]!.carriedAppliance).toBeNull();
    expect(applianceAtTile(world, STALL[0], STALL[1])).toBe(stall);
  });
});

/**
 * The dining room, which is the order queue made physical: capacity is chairs,
 * patience is a person, and a lost order is somebody standing up and leaving.
 */
describe("the dining room", () => {
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

  test("a used plate on the table does not block the rest of the party", () => {
    const world = makeWorld();
    const table = applianceAtTile(world, TABLE[0], TABLE[1])!;
    // One of the party has eaten and gone, leaving their plate behind. Their
    // friend is still waiting, and the table has one surface.
    const used = dirtyPlate(world, TABLE);
    const friend = seatCustomer(world, "salad");

    makeSalad(world);
    putOn(world, TABLE, 0, 1);

    // The dish is handed over rather than put down, so the washing-up standing
    // in the way is no longer the reason a second order cannot be served.
    expect(friend.state).toBe("eating");
    expect(world.served).toBe(1);
    expect(world.players[0]!.carried).toBeNull();
    expect(table.item).toBe(used);
  });

  test("bussing the plate collects the tip, and the sink is what washes it", () => {
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

    // The stack used to take it back and wash it for free. It does not any
    // more, and refusing is the whole reason the sink exists.
    putOn(world, PLATES);
    expect(world.players[0]!.carried).not.toBeNull();

    putOn(world, SINK);
    const sink = applianceAtTile(world, SINK[0], SINK[1])!;
    expect(world.players[0]!.carried).toBeNull();
    expect(isDirty(sink.item)).toBe(true);

    workOn(world, SINK, 1.6);
    expect(sink.item!.processes).toEqual([]);

    takeFrom(world, SINK);
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
    blockTables(world);
    world.nextArrivalIn = 0;
    hold(world, 6, null);

    expect(world.customers).toHaveLength(1);
    expect(world.customers[0]!.state).toBe("waiting");
  });

  test("a full room grows a line outside, and the line has an end", () => {
    const world = makeWorld();
    blockTables(world);

    // Six chances to walk up the path, at a room with nowhere at all to sit.
    for (let i = 0; i < 6; i++) {
      world.nextArrivalIn = 0;
      hold(world, 0.5, null);
    }

    const queue = world.customers.filter((customer) => customer.state === "waiting");
    expect(queue).toHaveLength(DOOR_QUEUE);

    // A line, not a huddle: each one stands further back down the path than the
    // person in front, and all of them outside the door rather than in it.
    const xs = queue.map((customer) => customer.pos.x);
    expect(xs[0]).toBeGreaterThan(xs[1]!);
    expect(xs[1]).toBeGreaterThan(xs[2]!);
    for (const customer of queue) expect(customer.pos.x).toBeLessThan(world.door.x);
  });

  test("the line is served from the front", () => {
    // The tick loop walks customers backwards, so "whoever asks for a table"
    // means the person who arrived last. A queue that does that is not one.
    const world = makeWorld();
    const tables = blockTables(world);

    for (let i = 0; i < 3; i++) {
      world.nextArrivalIn = 0;
      hold(world, 0.5, null);
    }
    const [first, second] = world.customers.filter((customer) => customer.state === "waiting");
    expect(second).toBeDefined();

    // One table is bussed. Exactly one person sits down, and it is the one who
    // has been standing there longest.
    tables[0]!.item = null;
    hold(world, 0.2, null);
    expect(first!.table).not.toBeNull();
    expect(second!.state).toBe("waiting");
  });

  test("a queue is one more thing to be impatient about", () => {
    const world = makeWorld();
    blockTables(world);
    world.nextArrivalIn = 0;
    step(world, idle());

    // The kind's patience multiplies the door wait too, so the line thins from
    // the impatient end first.
    const waiting = world.customers[0]!;
    expect(waiting.state).toBe("waiting");
    expect(waiting.timer).toBeCloseTo(DOOR_WAIT * customerKind(waiting.kind).patience, 5);
  });

  test("a rush is several people on the path, not a faster clock", () => {
    const world = makeWorld();
    world.day = 10; // long enough for rushes to be at their ceiling

    let biggest = 0;
    for (let i = 0; i < 40; i++) {
      world.customers.length = 0;
      world.nextArrivalIn = 0;
      step(world, idle());
      biggest = Math.max(biggest, world.customers.length);
      // Whoever came together came in single file, spread down the path.
      const xs = world.customers.map((customer) => customer.pos.x);
      expect(new Set(xs).size).toBe(xs.length);
    }
    expect(biggest).toBeGreaterThan(1);
  });

  test("a party takes one table between them, and a chair each", () => {
    const world = makeWorld();
    world.day = 10;

    let group: Customer[] = [];
    for (let i = 0; i < 40 && group.length < 2; i++) {
      world.customers.length = 0;
      world.nextArrivalIn = 0;
      step(world, idle());
      if (world.customers.length > 1) group = [...world.customers];
    }
    expect(group.length).toBeGreaterThan(1);

    // One table, one group id, and nobody sitting in anybody's lap.
    expect(new Set(group.map((customer) => customer.table)).size).toBe(1);
    expect(group.every((customer) => customer.table !== null)).toBe(true);
    expect(new Set(group.map((customer) => customer.party)).size).toBe(1);
    expect(group[0]!.party).not.toBe(0);
    expect(new Set(group.map((c) => `${c.seat?.x},${c.seat?.y}`)).size).toBe(group.length);
  });

  test("a table with one chair is a table for one, whatever the day", () => {
    // Where the tables go decides who can be served, not only how many. A table
    // shoved into a corner takes singles for the rest of the run, and the
    // arrival roll knows it: a party nobody could ever seat is a walkout with
    // extra steps, so it is never rolled.
    const world = makeWorld();
    world.day = 10;
    sellOff(world, ["table"]);
    spawnAppliance(world, "table", { x: 4, y: 4 });
    for (const [x, y] of [
      [3, 4],
      [4, 3],
      [4, 5],
    ] as const) {
      spawnAppliance(world, "counter", { x, y });
    }

    for (let i = 0; i < 40; i++) {
      world.customers.length = 0;
      world.nextArrivalIn = 0;
      step(world, idle());
      expect(world.customers).toHaveLength(1);
    }
  });

  test("day one is never a rush", () => {
    // The curve has a shape: the room learns the loop before it is asked to
    // hold a line of four.
    const world = makeWorld();
    for (let i = 0; i < 40; i++) {
      world.customers.length = 0;
      world.nextArrivalIn = 0;
      step(world, idle());
      expect(world.customers).toHaveLength(1);
    }
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
    counter.tile = { x: world.door.x, y: world.door.y };
    world.applianceAt[counter.tile.y * world.width + counter.tile.x] = counter.id;

    expect(unreachableTables(world)).toHaveLength(2);
    expect(kitchenWarnings(world)).toContain("2 table(s) can't be reached from the door");

    // Nobody can sit, so nobody does — they wait at the door and give up.
    world.nextArrivalIn = 0;
    hold(world, 6, null);
    expect(world.customers[0]!.state).toBe("waiting");
  });

  test("a table of two is fed one plate at a time, each dish to whoever ordered it", () => {
    const world = makeWorld();
    const plates = platesInWorld(world);
    const table = applianceAtTile(world, TABLE[0], TABLE[1])!;

    // Two people, one table, two different dishes — a party, without waiting
    // for the door to roll one.
    const salad = seatCustomer(world, "salad");
    const fries = seatCustomer(world, "fries");
    fries.seat = { x: TABLE[0], y: TABLE[1] + 1 };

    makeSalad(world);
    putOn(world, TABLE, 0, -1);

    // The salad went to the person who ordered a salad, and the table is clear
    // again: their dinner is in front of *them* now, which is the only reason
    // the second dish has anywhere to land.
    expect(salad.state).toBe("eating");
    expect(fries.state).toBe("ordering");
    expect(table.item).toBeNull();
    expect(salad.plate?.base).toBe("plate");
    expect(platesInWorld(world)).toBe(plates);

    makeFries(world);
    putOn(world, TABLE, 0, -1);
    expect(fries.state).toBe("eating");
    expect(table.item).toBeNull();

    // Both finish: one pile of two dirty plates to bus, and both tips on it.
    const tips = salad.tip + fries.tip;
    hold(world, eatTime(salad) + eatTime(fries) + 0.2, null);
    expect(world.customers.every((customer) => customer.state === "leaving")).toBe(true);
    expect(plateCount(table.item)).toBe(2);
    expect(isDirty(table.item)).toBe(true);
    expect(table.tip).toBe(tips);
    expect(platesInWorld(world)).toBe(plates);
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

/**
 * Who walks in. Every kind multiplies numbers the dining room already had, so
 * these tests are about the multipliers landing in the right places — there is
 * no new rule to test, and that is the design.
 */
describe("customer variety", () => {
  test("a hurry is less patience and a shorter meal, on the same dish", () => {
    const world = makeWorld();
    const regular = seatCustomer(world, "salad");
    const hurried = seatCustomer(world, "salad", TABLE2, "hurried");

    expect(hurried.patience).toBeLessThan(regular.patience);

    // The table is the scarce thing, so appetite is the half that matters to a
    // kitchen: they are gone sooner, and the seat comes back sooner.
    makeSalad(world);
    putOn(world, TABLE, 0, 1);
    makeSalad(world);
    putOn(world, TABLE2, 0, 1);
    expect(regular.state).toBe("eating");
    expect(hurried.state).toBe("eating");
    expect(hurried.timer).toBeLessThan(regular.timer);

    // ...and the plate empties over their meal, not over the average one. This
    // is the arithmetic that used to live in the render layer.
    expect(mealLeft(hurried)).toBeCloseTo(1, 1);
    hold(world, 6.5, null);
    expect(hurried.state).toBe("leaving");
    expect(regular.state).toBe("eating");
  });

  test("the tip is what the trouble was worth", () => {
    const world = makeWorld();
    const regular = seatCustomer(world, "salad");
    makeSalad(world);
    putOn(world, TABLE, 0, 1);

    const critic = seatCustomer(world, "salad", TABLE2, "critic");
    makeSalad(world);
    putOn(world, TABLE2, 0, 1);

    // Both served the moment they ordered, so the only difference between the
    // two tips is generosity. The base reward is not generous at all: what is
    // paid on delivery is the dish's, and only what is left on the table is
    // theirs.
    expect(world.money).toBe(16);
    expect(critic.tip).toBeGreaterThan(regular.tip * 2);
  });

  test("pace is legible before they sit down", () => {
    const world = makeWorld();
    const hurried = customerSpeed({ ...seatCustomer(world, "salad"), kind: "hurried" });
    const leisurely = customerSpeed({ ...world.customers[0]!, kind: "leisurely" });
    expect(hurried).toBeGreaterThan(leisurely);
  });

  test("a room draws its crowd from the seed, and only from the seed", () => {
    // Everybody who came through the door, not just whoever is still sitting
    // there at the end of it.
    const crowd = (seed: number): string[] => {
      const world = createWorld(LEVEL, seed);
      equip(world);
      openWorld(world);
      world.nextArrivalIn = 0;
      const kinds = new Map<number, string>();
      for (let i = 0; i < Math.ceil(100 / DT); i++) {
        step(world, idle());
        for (const customer of world.customers) kinds.set(customer.id, customer.kind);
      }
      return [...kinds.values()];
    };

    // Same seed, same people: the kind is drawn from the room's stream like the
    // chair and the order are, so two clients of one kitchen cannot disagree
    // about who is sitting there.
    expect(crowd(7)).toEqual(crowd(7));

    const known = new Set(CUSTOMER_KINDS.map((kind) => kind.id));
    const seen = new Set<string>();
    for (let seed = 1; seed <= 8; seed++) for (const id of crowd(seed)) seen.add(id);
    for (const id of seen) expect(known).toContain(id);
    // A weighted draw that always returns the first row would pass everything
    // above. The crowd has to actually be a crowd.
    expect(seen.size).toBeGreaterThan(1);
  });

  test("an unknown kind is served as a regular rather than dropped", () => {
    // Content moves faster than protocols: a client one deploy behind will be
    // sent kinds it has never heard of, and the honest answer is an ordinary
    // customer rather than a crash halfway through drawing the dining room.
    expect(customerKind("food-critic-from-the-future").id).toBe("regular");
  });
});

/**
 * The drive-through, which is a whole kitchen rather than a wing of one.
 *
 * A dining room is parallel and a lane is serial, and everything below is one
 * consequence of that sentence: cars queue in arrival order, only the front one
 * can be served, and a car nobody feeds holds up every car behind it.
 */
/** The Highway Stop's serving hatch, faced from the tile inside it. */
const HATCH = [10, 7] as const;
/** The rest of its galley, all along the back wall and faced from below. */
const LANE_CRATE = { tomato: [3, 2], lettuce: [4, 2] } as const;
const LANE_COUNTER = [5, 2] as const;
const LANE_BOARD = [6, 2] as const;
const LANE_PLATES = [15, 2] as const;
const LANE_SINK = [16, 2] as const;
/** The lane tile outside the hatch, where the front car stops. */
const STOP = [10, 8] as const;

/** The Highway Stop, open for business, with nobody on the road yet. */
function makeLane(): World {
  const world = createWorld(HIGHWAY_STOP, 1);
  world.nextArrivalIn = Infinity;
  world.phase = "service";
  world.dayTime = world.dayLength;
  return world;
}

/** A car already stopped at the `rank`-th place in the lane, wanting `recipeId`. */
function queueCar(world: World, recipeId = "salad", rank = 0): Customer {
  const recipe = RECIPE_BY_ID.get(recipeId)!;
  const spot = laneSpot(world, rank);
  const car: Customer = {
    id: world.nextId++,
    state: "ordering",
    pos: { ...spot },
    prevPos: { ...spot },
    facing: { x: -1, y: 0 },
    table: null,
    seat: null,
    party: 0,
    plate: null,
    recipeId,
    kind: "regular",
    path: [],
    timer: 0,
    remaining: recipe.patience,
    patience: recipe.patience,
    tip: 0,
  };
  world.customers.push(car);
  return car;
}

/** A plated salad, straight into the chef's hands. */
function platedSalad(world: World): Item {
  const plate = makeItem(world, { base: "plate", processes: [] });
  plate.contents.push(makeItem(world, { base: "salad", processes: [] }));
  return plate;
}

describe("the drive-through", () => {
  test("cars come off the road, queue up, and shuffle forward", () => {
    const world = makeLane();
    world.nextArrivalIn = 0;
    hold(world, 60, null);

    const lane = laneCars(world);
    expect(lane.length).toBeGreaterThan(1);
    // Front car at the hatch, everybody else one tile further back down the
    // road for each car in front of them. The queue is arithmetic, not bodies.
    lane.forEach((car, rank) => {
      expect(car.state).toBe("ordering");
      expect(car.pos.x).toBeCloseTo(STOP[0] + rank + 0.5, 1);
      expect(car.pos.y).toBeCloseTo(STOP[1] + 0.5, 1);
    });
    // Past the end of the lane nobody sets off at all.
    expect(lane.length).toBeLessThanOrEqual(LANE_QUEUE);
  });

  test("the car takes the food and the plate stays behind, dirty", () => {
    const world = makeLane();
    const car = queueCar(world);
    const plates = platesInWorld(world);

    world.players[0]!.carried = platedSalad(world);
    face(world.players[0]!, HATCH[0], HATCH[1], 0, 1);
    press(world, "grab");

    // Paid on the spot — there is no table for a tip to be left on, so the
    // whole cover lands at once.
    expect(world.served).toBe(1);
    expect(world.money).toBeGreaterThan(RECIPE_BY_ID.get("salad")!.reward);
    expect(car.state).toBe("leaving");

    // The one rule takeaway needed: the crockery never leaves the kitchen, and
    // it comes back dirty in the hands that served it.
    const held = world.players[0]!.carried;
    expect(isPlate(held)).toBe(true);
    expect(isDirty(held)).toBe(true);
    expect(held.contents).toEqual([]);
    expect(platesInWorld(world)).toBe(plates + 1); // the one the test conjured
  });

  test("a dish left on the sill is handed to whoever pulls up to it", () => {
    const world = makeLane();
    const hatch = applianceAtTile(world, HATCH[0], HATCH[1])!;
    hatch.item = platedSalad(world);

    // Nobody is standing at the hatch: this is the path that lets one chef run
    // a lane, by plating ahead of the car rather than waiting at the wall.
    const car = queueCar(world);
    step(world, idle());

    expect(car.state).toBe("leaving");
    expect(world.served).toBe(1);
    expect(isDirty(hatch.item)).toBe(true);
  });

  test("only the front car can be served", () => {
    const world = makeLane();
    const first = queueCar(world, "pizza", 0);
    const second = queueCar(world, "salad", 1);

    world.players[0]!.carried = platedSalad(world);
    face(world.players[0]!, HATCH[0], HATCH[1], 0, 1);
    press(world, "grab");

    // The salad is the second car's, and the second car is behind a pizza it
    // cannot drive around. This is the pressure a dining room cannot express:
    // one order nobody has started holds up the whole lane.
    expect(world.served).toBe(0);
    expect(first.state).toBe("ordering");
    expect(second.state).toBe("ordering");

    // It is not refused, though — the hatch is a sill, so the dish waits there
    // for the car it belongs to. Serving ahead is the whole reason to put a
    // plate down at the wall rather than stand holding it.
    const sill = applianceAtTile(world, HATCH[0], HATCH[1])!;
    expect(world.players[0]!.carried).toBeNull();
    expect(sill.item?.contents[0]?.base).toBe("salad");

    first.remaining = 0.05;
    hold(world, 2, null);
    expect(world.served).toBe(1);
    expect(second.state).toBe("leaving");
  });

  test("a car that gives up drives off and the queue closes up", () => {
    const world = makeLane();
    const first = queueCar(world, "salad", 0);
    const second = queueCar(world, "salad", 1);
    first.remaining = 0.05;

    hold(world, 2, null);
    expect(world.lost).toBe(1);
    expect(first.state).toBe("leaving");
    // The one behind is now the one being served, and has moved up to say so.
    expect(laneCars(world)[0]).toBe(second);
    expect(second.pos.x).toBeCloseTo(STOP[0] + 0.5, 1);
  });

  test("a chef can cook a salad here and hand it through the hatch", () => {
    // The whole loop in one test, on this kitchen's own tiles: the level is not
    // playable unless a dish can be made *and* got out of the building, and
    // this is the only test that walks the distance between those two things.
    const world = makeLane();
    const car = queueCar(world);
    const plates = platesInWorld(world);

    for (const crate of [LANE_CRATE.lettuce, LANE_CRATE.tomato]) {
      takeFrom(world, crate);
      putOn(world, LANE_BOARD);
      workOn(world, LANE_BOARD, 2.1);
      takeFrom(world, LANE_BOARD);
      putOn(world, LANE_COUNTER); // the second one lands on the first and combines
    }
    takeFrom(world, LANE_PLATES);
    putOn(world, LANE_COUNTER);
    takeFrom(world, LANE_COUNTER);
    expect(specKey(world.players[0]!.carried!.contents[0]!)).toBe("salad");

    face(world.players[0]!, HATCH[0], HATCH[1], 0, 1);
    press(world, "grab");
    expect(car.state).toBe("leaving");

    // And the washing-up is where the loop closes: the plate that just paid for
    // itself is dirty, in your hands, four tiles from the sink.
    putOn(world, LANE_SINK);
    expect(isDirty(applianceAtTile(world, LANE_SINK[0], LANE_SINK[1])!.item)).toBe(true);
    expect(platesInWorld(world)).toBe(plates);
  });

  test("a kitchen with no dining room is not a kitchen missing one", () => {
    const world = makeLane();
    // Every warning about tables is a warning about a room this one does not
    // have. The hatch is level furniture: it cannot be sold, moved or built
    // over, so there is nothing here for a player to get wrong.
    expect(kitchenWarnings(world)).toEqual([]);
    expect(applianceDef("hatch").movable).toBe(false);
    expect(snapshot(world).appliances.some((entry) => entry.kind === "hatch")).toBe(false);
  });
});
