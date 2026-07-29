import { LAUNCH_SHARE } from "../../data/progression";
import { DISH_INDEX, RECIPE_BY_ID } from "../../data/recipes";
import { isDirty, isPlate, specKey } from "../items";
import { scrape } from "../plates";
import { pathTo, reachableFrom, seatsAround } from "../pathing";
import { unlockedRecipes } from "../cards";
import type { Appliance, Customer, Recipe, Vec2, World } from "../types";
import { CUSTOMER_SPEED, effect, log, random, tileIndex } from "../world";

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

/**
 * How long a room with nothing free waits between customers.
 *
 * The ceiling, not the norm: every free table pulls the next arrival nearer by
 * `SEAT_PULL`, down to the day's floor.
 */
const QUIET_INTERVAL = 20;
/** How much sooner the next customer comes for each free table. */
const SEAT_PULL = 3.5;

/**
 * How fast customers arrive: the day curve as a **floor**, free seats as the
 * dial.
 *
 * This used to follow the day and nothing else, which made a table free money.
 * You bought one, capacity went up, difficulty did not, and the only reason not
 * to fill the dining room with tables was that you ran out of floor. Coupling
 * demand to seats is what makes every purchase a piece of self-chosen
 * escalation: a table brings its own customers, so revenue and chaos arrive
 * together and the shop becomes the difficulty dial.
 *
 * Counted in *tables*, not in ratios. An empty room of two tables and an empty
 * room of six should not feel the same, and a fraction would say they do — it
 * would also make buying a table when the room is already empty change nothing
 * at all, which is precisely the purchase this exists to give weight to.
 *
 * Consumes no randomness beyond the jitter it always did: the count is a
 * question about the world, and burning the stream on questions makes answers
 * depend on how many tables happen to exist.
 */
function arrivalInterval(world: World, reachable: Set<number>): number {
  const floor = Math.max(6, 14 - world.day * 1.5);
  const pull = QUIET_INTERVAL - SEAT_PULL * freeTables(world, reachable);
  return Math.max(floor, pull) + random(world) * 4;
}

/**
 * Tables somebody could sit at right now: unclaimed, clear, and reachable.
 *
 * The same three conditions `claimTable` uses, because "how busy is the room"
 * and "is there anywhere to put this person" have to be the same question. A
 * table with a dirty plate on it is not free — which means falling behind on
 * bussing quietly slows the door down, and catching up opens it again.
 */
export function freeTables(world: World, reachable: Set<number>): number {
  const taken = new Set(world.customers.map((c) => c.table).filter((id) => id !== null));
  let free = 0;
  for (const appliance of world.appliances.values()) {
    if (appliance.kind !== "table" || taken.has(appliance.id)) continue;
    if (appliance.item !== null || appliance.tip > 0) continue;
    if (reachableSeats(world, appliance.tile, reachable).length === 0) continue;
    free++;
  }
  return free;
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
  world.nextArrivalIn = arrivalInterval(world, reachable);
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
        sitDown(world, customer, table, reachable);
        return false;
      }
      if (customer.timer > 0) return false;
      effect(world, { kind: "walkout", tile: tileOf(customer) });
      log(world, "Someone left — no free table");
      lose(world, customer);
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
      lose(world, customer);
      leave(world, customer);
      return false;
    }

    case "eating": {
      customer.timer -= dt;
      if (customer.timer > 0) return false;
      // Standing up leaves two things behind: the plate to bus, and the reason
      // to want to.
      //
      // **Scraped, not overwritten.** This used to rewrite whatever was on the
      // table into a single dirty plate, which was fine when a plate was a
      // plate. It is not fine now: nothing stops a chef clearing the table
      // mid-meal and leaving something else there, and the rewrite would turn a
      // pile of four into one plate (three destroyed) or a tomato into a plate
      // (one conjured). Plates are conserved, so the one rule about what a used
      // plate becomes lives in `sim/plates.ts` and is called from here.
      const table = tableOf(world, customer);
      const used = table?.item ?? null;
      if (table && isPlate(used)) {
        scrape(used);
        table.tip = customer.tip;
      }
      leave(world, customer);
      return false;
    }

    case "leaving":
      return walk(customer, dt);

    default: {
      // Adding a `CustomerState` without handling it here is a type error, not
      // a customer who quietly stops existing.
      const unreachable: never = customer.state;
      throw new Error(`unhandled customer state: ${String(unreachable)}`);
    }
  }
}

// --- arrival -----------------------------------------------------------------

function arrive(world: World, reachable: Set<number>): void {
  const table = claimTable(world, reachable);
  // Nobody comes when there is nowhere at all to sit; a queue that can never
  // clear is just a stream of people walking in to walk out again.
  if (!table && world.customers.some((c) => c.state === "waiting")) return;

  const recipe = orderFrom(world);
  if (!recipe) return; // a room with nothing on the menu takes no orders

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
    sitDown(world, customer, table, reachable);
    return;
  }
  // No table: wait on the paving outside and hope one frees up.
  customer.state = "waiting";
  customer.timer = DOOR_WAIT;
  const wait = approachTile(world);
  customer.path = [{ x: wait.x + 0.5, y: wait.y + 0.5 }];
}

/**
 * What this customer walks in wanting.
 *
 * Drawn from the recipes **this room has unlocked** — there is no day-slice any
 * more, and no global menu: two kitchens on day ten are two different
 * restaurants because they picked different cards.
 *
 * On the day a recipe is unlocked it takes about `LAUNCH_SHARE` of the orders,
 * and the rest of the day belongs to the menu it joined. First contact under
 * deliberate repetition: a dish learned by seeing it three times in an hour is a
 * dish nobody learns, and the weighting is over by the next morning.
 *
 * The launch share is the newest dish's **whole** share, not a head start on top
 * of an even split. Spreading the remainder over the whole pool looks like the
 * same thing and is not: on a two-dish menu it handed the new dish three orders
 * in four, and a day is only about ten customers long — so unlocking bread on
 * day two could mean never seeing a salad again that day.
 *
 * Exactly **one** draw from the stream either way, whatever the pool looks
 * like. Randomness spent conditionally is randomness that makes two rooms with
 * the same seed diverge on their menus, which is the one thing an order pool
 * must not do.
 */
function orderFrom(world: World): Recipe | null {
  const pool = unlockedRecipes(world);
  if (pool.length === 0) return null;
  const roll = random(world);
  const newest = pool.at(-1)!;
  const launching = world.unlockedDay === world.day && pool.length > 1;
  if (!launching) return pool[Math.min(pool.length - 1, Math.floor(roll * pool.length))] ?? newest;
  if (roll < LAUNCH_SHARE) return newest;
  // The rest of the roll, rescaled over the dishes the room already had. The
  // new one is on the menu like anything else once its day is over.
  const rest = pool.slice(0, -1);
  const spread = (roll - LAUNCH_SHARE) / (1 - LAUNCH_SHARE);
  return rest[Math.min(rest.length - 1, Math.floor(spread * rest.length))] ?? newest;
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
    const chair = pickSeat(world, appliance.tile, reachable);
    if (!chair) continue;
    // Nearest table first, so a half-empty dining room fills from the door and
    // customers do not cross the room past a free seat.
    const distance = (chair.x - world.door.x) ** 2 + (chair.y - world.door.y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = appliance;
    }
  }
  return best;
}

/** Every chair at this table the door can actually reach. */
function reachableSeats(world: World, tile: Vec2, reachable: Set<number>): Vec2[] {
  return seatsAround(world, tile).filter((chair) =>
    reachable.has(tileIndex(world, chair.x, chair.y)),
  );
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

function sitDown(world: World, customer: Customer, table: Appliance, reachable: Set<number>): void {
  // Which chair is a coin toss, drawn once, here — the only place a seat is
  // actually taken. A fixed side made a full dining room look choreographed,
  // every customer at the same o'clock of their own table.
  const options = reachableSeats(world, table.tile, reachable);
  const chair = options[Math.floor(random(world) * options.length)];
  if (!chair) return;
  customer.table = table.id;
  customer.seat = chair;
  customer.state = "arriving";
  customer.path = route(world, customer, chair);
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

/**
 * Where a customer steps onto the paving: the arrival point, pulled onto the
 * grid.
 *
 * Customers spawn `OFF_GRID` tiles outside the door, beyond the world, so there
 * is a stretch of walk that no tile can describe. Clamping the spawn point into
 * bounds names the first tile that *can* — the outer edge of the patio ring, on
 * the door's row — and the flood fill takes it from there.
 */
function approachTile(world: World): Vec2 {
  return {
    x: Math.min(world.width - 1, Math.max(0, world.door.x - OFF_GRID)),
    y: Math.min(world.height - 1, Math.max(0, world.door.y)),
  };
}

/**
 * Tile centres from wherever the customer is now to `to`.
 *
 * Somebody arriving is off the grid entirely, so their route starts from the
 * approach tile instead. It used to start from the **door**, which meant the
 * walk up to it was a straight line drawn over whatever happened to be there —
 * fine when "there" was painted scenery, and wrong now that the patio is real
 * walkable tiles with a market stall standing on some of them. One map, walked
 * by everybody, rather than two that agree by coincidence.
 */
function route(world: World, customer: Customer, to: Vec2): Vec2[] {
  const from = tileOf(customer);
  const outside = from.x < 0 || from.y < 0 || from.x >= world.width || from.y >= world.height;
  const entry = outside ? approachTile(world) : from;
  const tiles = pathTo(world, entry, to) ?? [];
  const path = tiles.map((tile) => ({ x: tile.x + 0.5, y: tile.y + 0.5 }));
  if (outside) path.unshift({ x: entry.x + 0.5, y: entry.y + 0.5 });
  return path;
}

function leave(world: World, customer: Customer): void {
  customer.state = "leaving";
  customer.table = null;
  customer.seat = null;
  // Out through the door and across the paving, on the tiles they came in on.
  customer.path = route(world, customer, approachTile(world));
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
  world.today.earned += recipe.reward;
  world.today.served++;
  log(world, `${recipe.name} delivered  +$${recipe.reward}`);
  return recipe.reward;
}

/**
 * One order lost, counted twice: once for the run, and once for the day.
 *
 * The day's tally is **by recipe** because that is the sentence the end-of-day
 * card needs to be able to say. "Four walked out" is a number; "four pizzas
 * walked out" is a diagnosis, and the difference between them is whether the
 * morning knows what to buy.
 */
function lose(world: World, customer: Customer): void {
  world.lost++;
  world.today.lost[customer.recipeId] = (world.today.lost[customer.recipeId] ?? 0) + 1;
}
