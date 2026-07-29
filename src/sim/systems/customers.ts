import { DISH_INDEX, RECIPES, RECIPE_BY_ID } from "../../data/recipes";
import { DIRTY } from "../../data/ingredients";
import { isDirty, isPlate, specKey } from "../items";
import { pathTo, reachableFrom, seatsAround } from "../pathing";
import type { Appliance, Customer, Vec2, World } from "../types";
import { effect, log, random, tileIndex } from "../world";

/**
 * Customers: the order queue made physical.
 *
 * A customer *is* an order — there is no ticket behind them — so everything the
 * old order system did happens here, but attached to a person you can see:
 * demand arrives by walking up the path, patience drains over a table, and a
 * lost order is somebody standing up and leaving.
 *
 * The state machine is deliberately small (see `CustomerState`). Moods,
 * reservations and menus-at-the-table all stay out until the loop has proved
 * itself.
 */

/** Tiles per second. Slower than a chef: they are on their day off. */
export const CUSTOMER_SPEED = 2.4;

/** A beat of calm between sitting down and asking for something. */
const DECIDE_TIME = 3;
/** How long a table stays occupied after the food lands. Throughput lives here. */
export const EAT_TIME = 12;
/** How long someone will stand at a full door before giving up. */
const DOOR_WAIT = 14;
/** Arrivals stop this long before closing time, so the day can finish cleanly. */
export const LAST_ORDERS = 30;
/** How much of the reward is left on the table rather than paid on delivery. */
export const TIP_FRACTION = 0.4;
/** How far outside the door customers walk on and off screen. */
const OFF_GRID = 3;

/** How fast customers arrive. This is the whole difficulty curve, as before. */
function arrivalInterval(world: World): number {
  const base = Math.max(6, 14 - world.day * 1.5);
  return base + random(world) * 4;
}

export function customerSystem(world: World, dt: number): void {
  if (world.phase !== "service") return;

  // One flood fill per tick, shared by everyone who needs it. Somebody waiting
  // at the door re-asks "is there a table yet" constantly, and doing the search
  // once here keeps that free no matter how long the queue gets.
  const reachable = reachableFrom(world, world.door);

  for (let i = world.customers.length - 1; i >= 0; i--) {
    const customer = world.customers[i]!;
    customer.prevPos.x = customer.pos.x;
    customer.prevPos.y = customer.pos.y;
    if (advance(world, customer, dt, reachable)) world.customers.splice(i, 1);
  }

  // Arrivals stop before closing time so the day ends on the last customer
  // finishing rather than on a timer cutting someone off mid-meal.
  if (world.dayTime <= LAST_ORDERS) return;
  world.nextArrivalIn -= dt;
  if (world.nextArrivalIn > 0) return;
  world.nextArrivalIn = arrivalInterval(world);
  arrive(world, reachable);
}

/** Advance one customer. Returns true when they should be removed. */
function advance(world: World, customer: Customer, dt: number, reachable: Set<number>): boolean {
  switch (customer.state) {
    case "arriving": {
      if (!walk(customer, dt)) return false;
      customer.state = "deciding";
      customer.timer = DECIDE_TIME;
      faceTable(world, customer);
      return false;
    }

    case "waiting": {
      walk(customer, dt);
      customer.timer -= dt;
      // Keep trying: a table freeing up while you wait is the whole point of
      // tolerating a queue at all.
      const table = claimTable(world, reachable);
      if (table) {
        seat(world, customer, table, reachable);
        return false;
      }
      if (customer.timer > 0) return false;
      effect(world, { kind: "walkout", tile: tileOf(customer) });
      log(world, "Someone left — no free table");
      world.lost++;
      leave(world, customer);
      return false;
    }

    case "deciding": {
      customer.timer -= dt;
      if (customer.timer > 0) return false;
      customer.state = "ordering";
      customer.remaining = customer.patience;
      // Somebody may have run the food over while this table was still making
      // up its mind. Without this, a plate already sitting there would be
      // ignored until a chef picked it up and put it down again — the one
      // silent failure in the whole delivery path.
      const early = tableOf(world, customer);
      if (early) {
        const reward = acceptDelivery(world, early, customer);
        if (reward !== null) effect(world, { kind: "paid", tile: early.tile, amount: reward });
      }
      return false;
    }

    case "ordering": {
      customer.remaining -= dt;
      if (customer.remaining > 0) return false;
      const recipe = RECIPE_BY_ID.get(customer.recipeId);
      effect(world, { kind: "walkout", tile: tileOf(customer) });
      log(world, `${recipe?.name ?? customer.recipeId} walked out`);
      world.lost++;
      leave(world, customer);
      return false;
    }

    case "eating": {
      customer.timer -= dt;
      if (customer.timer > 0) return false;
      // Standing up leaves two things behind: the plate to bus, and the reason
      // to want to.
      const table = tableOf(world, customer);
      if (table && table.item) {
        table.item.base = "plate";
        table.item.processes = [DIRTY];
        table.item.contents = [];
        table.tip = customer.tip;
      }
      leave(world, customer);
      return false;
    }

    case "leaving":
      return walk(customer, dt);
  }
}

// --- arrival -----------------------------------------------------------------

function arrive(world: World, reachable: Set<number>): void {
  const table = claimTable(world, reachable);
  // Nobody comes when there is nowhere at all to sit; a queue that can never
  // clear is just a stream of people walking in to walk out again.
  if (!table && world.customers.some((c) => c.state === "waiting")) return;

  // Early days only serve the simpler recipes, exactly as orders used to.
  const pool = RECIPES.slice(0, Math.min(RECIPES.length, 1 + world.day));
  const recipe = pool[Math.floor(random(world) * pool.length)] ?? RECIPES[0]!;

  const start = { x: world.door.x - OFF_GRID + 0.5, y: world.door.y + 0.5 };
  const customer: Customer = {
    id: world.nextId++,
    state: "arriving",
    pos: { ...start },
    prevPos: { ...start },
    facing: { x: 1, y: 0 },
    table: null,
    seat: null,
    recipeId: recipe.id,
    path: [],
    timer: 0,
    remaining: recipe.patience,
    patience: recipe.patience,
    tip: 0,
  };
  world.customers.push(customer);

  if (table) {
    seat(world, customer, table, reachable);
    return;
  }
  // No table: walk to the door and hope one frees up.
  customer.state = "waiting";
  customer.timer = DOOR_WAIT;
  customer.path = [{ x: world.door.x + 0.5, y: world.door.y + 0.5 }];
}

/**
 * A free, reachable table, or null.
 *
 * "Free" means no customer has claimed it *and* nothing is left on it — a table
 * with a dirty plate still on it cannot be sat at, which is what gives bussing
 * its urgency during a rush.
 */
function claimTable(world: World, reachable: Set<number>): Appliance | null {
  const taken = new Set(world.customers.map((c) => c.table).filter((id) => id !== null));
  let best: Appliance | null = null;
  let bestDistance = Infinity;
  for (const appliance of world.appliances.values()) {
    if (appliance.kind !== "table" || taken.has(appliance.id)) continue;
    if (appliance.item !== null || appliance.tip > 0) continue;
    const seat = pickSeat(world, appliance.tile, reachable);
    if (!seat) continue;
    // Nearest table first, so a half-empty dining room fills from the door and
    // customers do not cross the room past a free seat.
    const distance = (seat.x - world.door.x) ** 2 + (seat.y - world.door.y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = appliance;
    }
  }
  return best;
}

/** Every chair at this table the door can actually reach. */
function reachableSeats(world: World, tile: Vec2, reachable: Set<number>): Vec2[] {
  return seatsAround(world, tile).filter((seat) => reachable.has(tileIndex(world, seat.x, seat.y)));
}

/**
 * Is there anywhere to sit at this table? Deliberately does **not** consume
 * randomness: it is asked speculatively, of every table, on every tick somebody
 * is queuing at the door. Burning the RNG stream on a question would make the
 * answer depend on how many tables happen to exist.
 */
function pickSeat(world: World, tile: Vec2, reachable: Set<number>): Vec2 | null {
  return reachableSeats(world, tile, reachable)[0] ?? null;
}

function seat(world: World, customer: Customer, table: Appliance, reachable: Set<number>): void {
  // Which chair is a coin toss, drawn once, here — the only place a seat is
  // actually taken. A fixed side made a full dining room look choreographed,
  // every customer at the same o'clock of their own table.
  const options = reachableSeats(world, table.tile, reachable);
  const seat = options[Math.floor(random(world) * options.length)];
  if (!seat) return;
  customer.table = table.id;
  customer.seat = seat;
  customer.state = "arriving";
  customer.path = route(world, customer, seat);
}

// --- movement ----------------------------------------------------------------

/**
 * Follow the path. Returns true once it runs out.
 *
 * Customers are ghosts to chefs and to each other: they only ever walk tiles
 * the flood fill approved, and bodyblocking by pathing NPCs is the fastest
 * route to frustration in a game about hurrying.
 */
function walk(customer: Customer, dt: number): boolean {
  if (customer.path.length === 0) return true;

  let step = CUSTOMER_SPEED * dt;
  while (step > 0) {
    const target = customer.path[0];
    if (!target) return true;
    const dx = target.x - customer.pos.x;
    const dy = target.y - customer.pos.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= step) {
      customer.pos.x = target.x;
      customer.pos.y = target.y;
      customer.path.shift();
      step -= distance;
      continue;
    }
    customer.pos.x += (dx / distance) * step;
    customer.pos.y += (dy / distance) * step;
    customer.facing.x = dx / distance;
    customer.facing.y = dy / distance;
    return false;
  }
  return customer.path.length === 0;
}

/** Tile centres from wherever the customer is now to `to`, prefixed by the door. */
function route(world: World, customer: Customer, to: Vec2): Vec2[] {
  const from = tileOf(customer);
  const outside = from.x < 0 || from.y < 0 || from.x >= world.width || from.y >= world.height;
  const entry = outside ? world.door : from;
  const tiles = pathTo(world, entry, to) ?? [];
  const path = tiles.map((tile) => ({ x: tile.x + 0.5, y: tile.y + 0.5 }));
  if (outside) path.unshift({ x: world.door.x + 0.5, y: world.door.y + 0.5 });
  return path;
}

function leave(world: World, customer: Customer): void {
  customer.state = "leaving";
  customer.table = null;
  customer.seat = null;
  customer.path = route(world, customer, world.door);
  customer.path.push({ x: world.door.x - OFF_GRID + 0.5, y: world.door.y + 0.5 });
}

function faceTable(world: World, customer: Customer): void {
  const table = tableOf(world, customer);
  if (!table) return;
  customer.facing.x = table.tile.x + 0.5 - customer.pos.x;
  customer.facing.y = table.tile.y + 0.5 - customer.pos.y;
  const length = Math.hypot(customer.facing.x, customer.facing.y) || 1;
  customer.facing.x /= length;
  customer.facing.y /= length;
}

function tileOf(customer: Customer): Vec2 {
  return { x: Math.floor(customer.pos.x), y: Math.floor(customer.pos.y) };
}

export function tableOf(world: World, customer: Customer): Appliance | null {
  return customer.table === null ? null : (world.appliances.get(customer.table) ?? null);
}

/** The customer sitting at this table and waiting to be fed, if there is one. */
export function customerAt(world: World, table: Appliance): Customer | null {
  return (
    world.customers.find(
      (customer) => customer.table === table.id && customer.state === "ordering",
    ) ?? null
  );
}

/**
 * Take whatever is on the table as this customer's dinner, if it is what they
 * asked for. Returns the reward paid, or null when it is not their dish.
 *
 * Payment is split in two: the base reward is paid here, to whoever is
 * standing there; the tip is worked out here too but stays with the customer
 * until they leave, when it lands on the table for whoever busses it.
 *
 * Nothing is ever refused. A wrong dish simply is not this, so it sits on the
 * table with the order bubble still showing what was wanted, and picking it
 * back up undoes the mistake at the cost of the walk.
 */
export function acceptDelivery(world: World, table: Appliance, customer: Customer): number | null {
  const plate = table.item;
  if (!plate || !isPlate(plate) || isDirty(plate) || plate.contents.length !== 1) return null;

  const recipe = DISH_INDEX.get(specKey(plate.contents[0]!));
  if (!recipe || recipe.id !== customer.recipeId) return null;

  const speed = Math.max(0, customer.remaining / customer.patience);
  customer.tip = Math.round(recipe.reward * TIP_FRACTION * speed);
  customer.state = "eating";
  customer.timer = EAT_TIME;

  world.money += recipe.reward;
  world.served++;
  log(world, `${recipe.name} delivered  +$${recipe.reward}`);
  return recipe.reward;
}

/** Tables a customer can actually reach. Used by the build phase to warn. */
export function unreachableTables(world: World): Appliance[] {
  const reachable = reachableFrom(world, world.door);
  const stranded: Appliance[] = [];
  for (const appliance of world.appliances.values()) {
    if (appliance.kind !== "table") continue;
    if (!pickSeat(world, appliance.tile, reachable)) stranded.push(appliance);
  }
  return stranded;
}
