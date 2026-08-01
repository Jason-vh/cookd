import { CUSTOMER_KINDS, type CustomerKind, customerKind } from "../../data/customers";
import { LAUNCH_SHARE } from "../../data/progression";
import { DISH_INDEX, RECIPE_BY_ID } from "../../data/recipes";
import { isDirty, isPlate, specKey } from "../items";
import { MAX_PLATES, plateCount, scrape, stackPlates, stockPlates } from "../plates";
import { CAR_SPEED, LANE_QUEUE, hatchOf, laneCars, laneEnds, laneSpot } from "../lane";
import { pathTo, reachableFrom, seatsAround } from "../pathing";
import { unlockedRecipes } from "../cards";
import { servesOutdoors, weatherOf } from "../weather";
import type { Appliance, Customer, Item, Recipe, Vec2, World } from "../types";
import { CUSTOMER_SPEED, effect, log, outdoors, random, tileIndex } from "../world";

/**
 * Customers: the order queue made physical.
 *
 * A customer *is* an order — there is no ticket behind them — so everything the
 * old order system did happens here, but attached to a person you can see:
 * demand arrives by walking up the path, patience drains over a table, and a
 * lost order is somebody standing up and leaving.
 *
 * They arrive alone or as a **party**: several people at one table, a dish
 * each, all wanted at once. A party is deliberately not a new kind of entity —
 * it is a group id and a chair count, because everything else a party does is
 * something a customer already did.
 *
 * The state machine is deliberately small (see `CustomerState`). Moods,
 * reservations and menus-at-the-table all stay out until the loop has proved
 * itself.
 */

/** A beat of calm between sitting down and asking for something. */
const DECIDE_TIME = 3;
/**
 * How long a table stays occupied after the food lands, for somebody of
 * ordinary appetite. Throughput lives here.
 *
 * Read through `eatTime` rather than directly: what a *given* customer does
 * with this number is their kind's business.
 */
export const EAT_TIME = 12;

/** How long someone of ordinary patience will stand at a full door. */
export const DOOR_WAIT = 14;
/**
 * How many people will stand in the line outside.
 *
 * The queue is an overflow valve, not a waiting list: past this nobody new
 * walks up the path at all. A line long enough that its tail can never be
 * seated is a stream of people arriving to leave again, which reads as demand
 * the room is failing rather than as demand the room refused.
 */
export const DOOR_QUEUE = 3;
/** Spacing between people in the line, in tiles. */
const QUEUE_GAP = 0.85;
/** How far apart a group starts down the path, so it walks in single file. */
const GROUP_GAP = 1.1;
/** How much likelier a rush gets with each day survived. */
const RUSH_PER_DAY = 0.09;
/** The ceiling on that: even a busy day is mostly ones and twos. */
const MAX_RUSH_CHANCE = 0.45;
/** Arrivals stop this long before closing time, so the day can finish cleanly. */
export const LAST_ORDERS = 30;
/** How much of the reward is left on the table rather than paid on delivery. */
export const TIP_FRACTION = 0.4;
/** How far outside the door customers walk on and off screen. */
const OFF_GRID = 3;

/**
 * How long this particular customer sits over their dinner.
 *
 * A function of the person rather than a constant, because appetite is a dial
 * on the kind (`data/customers.ts`). Anything wanting the *fraction* eaten
 * should ask `mealLeft` instead — see the note there.
 */
export function eatTime(customer: Customer): number {
  return EAT_TIME * customerKind(customer.kind).appetite;
}

/**
 * How fast this customer walks, in tiles per second.
 *
 * Pace is the one dial on a kind that is legible before they sit down, which is
 * why the renderer asks for it too: the walk cycle is driven by distance
 * covered against top speed, so a hurried diner animated against the average
 * would glide.
 */
export function customerSpeed(customer: Customer): number {
  return CUSTOMER_SPEED * customerKind(customer.kind).pace;
}

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
  // The weather's second dial, and the smaller one. Its *first* is the terrace,
  // and that already arrives here on its own: a shut terrace is fewer free
  // tables, which is the count this line is built on. What is left for `trade`
  // is the part that has nothing to do with seats — fewer people out walking at
  // all — which is also the only thing weather can say to a drive-through.
  return (Math.max(floor, pull) + random(world) * 4) * weatherOf(world).trade;
}

/**
 * Is this table open for business?
 *
 * A table standing outside the walls is furniture in a puddle when the terrace
 * is shut. Asked in one place and used by all three questions the dining room
 * puts to the furniture — how busy the room is, where to seat somebody, and how
 * big a party may walk up the path — because those have to agree, and a terrace
 * that closed for seating but not for the arrival rate would be a room that
 * kept sending people to a chair it had already withdrawn.
 */
function serving(world: World, table: Appliance): boolean {
  return !outdoors(world, table.tile) || servesOutdoors(world);
}

/**
 * Tables somebody could sit at right now: unclaimed, clear, reachable and open.
 *
 * The same four conditions `claimTable` uses, because "how busy is the room"
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
    if (!serving(world, appliance)) continue;
    if (reachableSeats(world, appliance.tile, reachable).length === 0) continue;
    free++;
  }
  return free;
}

export function customerSystem(world: World, dt: number): void {
  if (world.phase !== "service") return;
  if (world.lane) return laneSystem(world, dt);

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
  arrive(world, reachable);
  // Timed from the room the arrivals leave behind, not the one they found. A
  // group that takes the last three tables must not also set the next interval
  // as though those tables were still free — that is how a rush turns into a
  // permanent queue instead of a spike the room recovers from.
  world.nextArrivalIn = arrivalInterval(world, reachable);
}

// --- the drive-through -------------------------------------------------------

/**
 * A kitchen that serves cars, and the whole of what makes it a different game.
 *
 * A dining room is **parallel**: four tables are four independent orders, and a
 * slow one costs you that table. A lane is **serial** — the car at the hatch
 * stands between every car behind it and the road — so one dish nobody has
 * started holds up the entire queue. That is the pressure tables cannot
 * express, and it is why this is a level type rather than a hatch bolted onto
 * a dining room.
 *
 * Structurally it is the [line at the door](../../docs/dining-room.md) with the
 * seating taken out: rank comes from list order, position is arithmetic, cars
 * are ghosts. What it does *not* have is a `deciding` beat or an `eating` one —
 * a car is `arriving`, then `ordering` in the lane, then `leaving`, which is
 * the existing state machine with two states never entered.
 */
function laneSystem(world: World, dt: number): void {
  for (let i = world.customers.length - 1; i >= 0; i--) {
    const car = world.customers[i]!;
    car.prevPos.x = car.pos.x;
    car.prevPos.y = car.pos.y;
    if (drive(world, car, dt)) world.customers.splice(i, 1);
  }

  if (world.dayTime <= LAST_ORDERS) return;
  world.nextArrivalIn -= dt;
  if (world.nextArrivalIn > 0) return;
  driveUp(world);
  world.nextArrivalIn = laneInterval(world);
}

/**
 * How fast the road sends cars: the day curve as a floor, **lane space** as the
 * dial.
 *
 * The same shape as `arrivalInterval`, counting the same way in a different
 * noun. A dining room pulls the next customer nearer for every free table; a
 * drive-through does it for every car-length of empty lane, so a queue you are
 * clearing fills up again and a queue you are not is left alone. Past the end
 * of the lane nobody sets off at all, for the reason the door queue has a
 * length: a car that can only ever leave again reads as a room failing rather
 * than as a road that was busy.
 */
function laneInterval(world: World): number {
  const floor = Math.max(6, 14 - world.day * 1.5);
  const pull = QUIET_INTERVAL - SEAT_PULL * (LANE_QUEUE - laneCars(world).length);
  // The only thing the weather can do to a room with no chairs in it, and the
  // reason `trade` is a column at all. A dining room has furniture to take
  // away; a lane has nothing but the road, so the road is what gets quieter.
  return (Math.max(floor, pull) + random(world) * 4) * weatherOf(world).trade;
}

/**
 * One car off the road, if there is room in the lane for it.
 *
 * One order per car, deliberately: a party in a car is three bubbles over one
 * roof and a single vehicle blocking the lane until every one of them is
 * cooked, which is a much harder thing to read than it is to build. The lane is
 * already the pressure this room is for.
 *
 * Two draws from the stream — the dish and the kind — exactly as a diner costs,
 * and unconditionally, because randomness spent on questions about the room is
 * randomness that makes two rooms on one seed diverge.
 */
function driveUp(world: World): void {
  if (laneCars(world).length >= LANE_QUEUE) return;
  const recipe = orderFrom(world);
  if (!recipe) return; // a room with nothing on the menu takes no orders
  const kind = pickKind(world);
  const start = laneEnds(world).in;

  world.customers.push({
    id: world.nextId++,
    state: "arriving",
    pos: { ...start },
    prevPos: { ...start },
    facing: { x: 0, y: 1 },
    table: null,
    party: 0,
    plate: null,
    seat: null,
    recipeId: recipe.id,
    kind: kind.id,
    path: [],
    timer: 0,
    remaining: recipe.patience * kind.patience,
    patience: recipe.patience * kind.patience,
    tip: 0,
  });
}

/** Advance one car. Returns true when it should be removed. */
function drive(world: World, car: Customer, dt: number): boolean {
  const speed = CAR_SPEED * customerKind(car.kind).pace;

  if (car.state === "leaving") return walk(car, dt, speed);

  // Where this car stands is a function of how many are still in front of it,
  // recomputed every tick, so the lane closes up as it is served — and a car
  // that has not reached its spot yet simply has further to drive.
  const rank = laneCars(world).indexOf(car);
  standAt(car, laneSpot(world, Math.max(0, rank)));
  const parked = walk(car, dt, speed);

  if (car.state === "arriving") {
    if (!parked) return false;
    // The order appears when the car stops, not when it sets off: the drive in
    // is the beat of calm the walk up the path is, and the bubble arriving at
    // the back of the lane is how far ahead the kitchen gets to work.
    car.state = "ordering";
    car.remaining = car.patience;
    return false;
  }

  car.remaining -= dt;
  // Only the front of the queue may be handed anything, and a dish left waiting
  // on the sill is taken by whoever pulls up to it. That is what lets one chef
  // run the lane: plate ahead, and the hatch does the serving.
  if (rank === 0) {
    const hatch = hatchOf(world);
    if (hatch?.item && serveHatch(world, hatch, hatch.item) !== null) return false;
  }
  if (car.remaining > 0) return false;

  const recipe = RECIPE_BY_ID.get(car.recipeId);
  effect(world, { kind: "walkout", tile: tileOf(car) });
  log(world, `${recipe?.name ?? car.recipeId} drove off`);
  lose(world, car);
  driveOff(world, car);
  return false;
}

/**
 * Out of the lane and back onto the road.
 *
 * Forwards, past the hatch, whether they were served or gave up: a car that
 * reversed the length of the queue would be the one place in this game where
 * somebody's position matters to somebody else, and customers are ghosts here
 * exactly as they are in the dining room.
 */
function driveOff(world: World, car: Customer): void {
  car.state = "leaving";
  car.path = [laneEnds(world).out];
}

/**
 * A plate, handed through the hatch to the car at the front. Returns the
 * reward, or null when that is not what they asked for.
 *
 * **The car takes the food; the plate stays.** It is the one rule takeaway
 * needed and it is load-bearing twice over: plates are conserved, so a car
 * driving off with one would be a hole in the count that a save would then
 * write down — and a drive-through with no washing-up would be a kitchen with
 * no loop, which is exactly what serving through a hatch used to be. Every
 * cover comes back as a dirty plate in the hands that served it, immediately.
 *
 * The plate is scraped where it lies: in a chef's hands if they handed it over,
 * on the sill if they left it there. Whoever owned it still owns it.
 */
export function serveHatch(world: World, hatch: Appliance, plate: Item): number | null {
  const car = laneCars(world)[0];
  if (!car || car.state !== "ordering") return null;
  const recipe = ordered(car, plate);
  if (!recipe) return null;

  const reward = charge(world, car, recipe);
  // No table to leave it on, so the tip is handed over with the change. It is
  // the same number the dining room works out and pays a moment later.
  world.money += car.tip;
  world.today.tips += car.tip;
  scrape(plate);
  effect(world, { kind: "paid", tile: hatch.tile, amount: reward + car.tip });
  driveOff(world, car);
  return reward;
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
      // The line shuffles forward as it is served, so where you stand is a
      // function of how many are still in front of you rather than of where
      // you happened to stop.
      const rank = queueRank(world, customer);
      standAt(customer, queueSpot(world, rank));
      if (walk(customer, dt)) faceDoor(world, customer);
      customer.timer -= dt;
      // Keep trying: a table freeing up while you wait is the whole point of
      // tolerating a queue at all. Only the front of the line may take it,
      // though — a queue that hands the table to whoever happens to ask is not
      // a queue, and the tick loop runs backwards, so "whoever asks" would mean
      // the person who arrived last.
      //
      // A party asks for a table big enough for whoever is **still here**: one
      // of them giving up and walking off makes the rest easier to seat, which
      // is the right way round for a room that is struggling.
      const group = partyWith(world, customer);
      const table = rank === 0 ? claimTable(world, reachable, group.length) : null;
      if (table) {
        for (const member of group) sitDown(world, member, table, reachable);
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
      if (early?.item) {
        const reward = acceptDelivery(world, customer, early.item);
        if (reward !== null) {
          early.item = null;
          effect(world, { kind: "paid", tile: early.tile, amount: reward });
        }
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
      const used = customer.plate;
      customer.plate = null;
      if (table && isPlate(used)) {
        scrape(used);
        returnPlate(world, table, used);
        // Added rather than assigned: a party leaves one pile of plates and one
        // pile of coins, and the second one is what makes clearing a party's
        // table worth the trip it costs.
        table.tip += customer.tip;
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

/**
 * One arrival event: a person, or a **party**.
 *
 * How many were coming is decided **before** the room is consulted, in exactly
 * one draw, for the same reason `orderFrom` and `pickKind` each spend exactly
 * one: randomness spent conditionally makes two rooms on the same seed diverge
 * over how their days happened to go. What the room can absorb then clamps it
 * — nobody walks up a path they can only walk back down.
 *
 * They sit **together or not at all**. A party that finds no table with enough
 * chairs queues as a party and is seated as one, rather than splitting up: a
 * group that walks in together and ends up at three different tables is not a
 * party, it is a coincidence, and the whole point of the feature is a table
 * that wants three things at once.
 */
function arrive(world: World, reachable: Set<number>): void {
  // Never roll a party no table in this kitchen could ever seat. A group that
  // can only ever stand at the door is a walkout with extra steps — and how
  // many chairs a table has is a fact about the room, so asking costs no
  // randomness.
  const wanted = Math.min(groupSize(world), biggestTable(world, reachable));
  const queued = world.customers.reduce((n, c) => n + (c.state === "waiting" ? 1 : 0), 0);
  // Room for the whole party at one table, or room in the line for as many of
  // them as it will hold.
  const seatable = claimTable(world, reachable, wanted) ? wanted : 0;
  const size = Math.max(seatable, Math.min(wanted, Math.max(0, DOOR_QUEUE - queued)));
  if (size <= 0) return;

  // An id of their own, so the queue and the seating can find each other again.
  // Somebody on their own is party 0: not a group of one.
  const party = size > 1 ? world.nextId++ : 0;
  const group: Customer[] = [];
  for (let i = 0; i < size; i++) {
    const customer = walkUp(world, i, party);
    if (!customer) return; // a room with nothing on the menu takes no orders
    group.push(customer);
  }

  const table = claimTable(world, reachable, group.length);
  if (table) for (const customer of group) sitDown(world, customer, table, reachable);
  else for (const customer of group) joinQueue(world, customer);
  if (group.length > 1) log(world, `A party of ${group.length} came in`);
}

/** The most chairs any table in this room offers. Nobody may arrive as more. */
function biggestTable(world: World, reachable: Set<number>): number {
  let most = 1;
  for (const appliance of world.appliances.values()) {
    if (appliance.kind !== "table" || !serving(world, appliance)) continue;
    most = Math.max(most, reachableSeats(world, appliance.tile, reachable).length);
  }
  return most;
}

/** Everyone still here who walked in with this customer, themselves included. */
function partyWith(world: World, customer: Customer): Customer[] {
  if (customer.party === 0) return [customer];
  return world.customers.filter((other) => other.party === customer.party);
}

/**
 * How many walk up the path together.
 *
 * A rush is **people**, not a faster spawn rate: four coats on the path is
 * something you can see coming and prep for, and a shortened interval is
 * something you can only notice afterwards. The chance grows with the day, so
 * the difficulty curve has a shape the dining room can show rather than only a
 * number — and it is a chance rather than a schedule, because a rush you can
 * time is a rush you have already survived.
 *
 * A group is a **party**: one table, one dish each, all wanted at once. Which
 * makes the size roll the difficulty curve's real dial — two dishes to the same
 * table inside one patience ring is a different job from two customers who
 * happen to have arrived together.
 */
function groupSize(world: World): number {
  const chance = Math.min(MAX_RUSH_CHANCE, RUSH_PER_DAY * (world.day - 1));
  const roll = random(world);
  if (roll >= chance) return 1;
  // The rarer third of a rush is the bigger one. Reading the same roll twice
  // rather than drawing again keeps the draw count at one.
  return roll < chance / 3 ? 3 : 2;
}

/** One customer up the path, not yet seated. Null when the menu is empty. */
function walkUp(world: World, index: number, party: number): Customer | null {
  const recipe = orderFrom(world);
  if (!recipe) return null;
  const kind = pickKind(world);

  // Single file: everybody behind the first starts a little further down the
  // path, so a group arrives as a line walking up it rather than as one person
  // wearing three coats.
  const start = { x: world.door.x - OFF_GRID + 0.5 - index * GROUP_GAP, y: world.door.y + 0.5 };

  const customer: Customer = {
    id: world.nextId++,
    state: "arriving",
    pos: { ...start },
    prevPos: { ...start },
    facing: { x: 1, y: 0 },
    table: null,
    party,
    plate: null,
    seat: null,
    recipeId: recipe.id,
    kind: kind.id,
    path: [],
    timer: 0,
    // The dish says how long it is reasonable to wait for; the person says how
    // reasonable they are feeling. Stored resolved rather than looked up on
    // demand because the patience ring reads `remaining / patience`, and both
    // halves have to be on the same scale.
    remaining: recipe.patience * kind.patience,
    patience: recipe.patience * kind.patience,
    tip: 0,
  };
  world.customers.push(customer);
  return customer;
}

// --- the door queue ----------------------------------------------------------

/**
 * Take a place at the back of the line outside.
 *
 * How long they will stand there is the kind's `patience` again, multiplying a
 * number the dining room already had: somebody on their lunch break gives up on
 * a queue for the same reason they give up on a kitchen, and the line thins
 * from the impatient end first.
 */
function joinQueue(world: World, customer: Customer): void {
  customer.state = "waiting";
  customer.timer = DOOR_WAIT * customerKind(customer.kind).patience;
  standAt(customer, queueSpot(world, queueRank(world, customer)));
}

/**
 * How many are ahead of this customer in the line.
 *
 * Arrival order is list order — customers are only ever appended — so the queue
 * needs no state of its own beyond that. Counting rather than building a list
 * because this is asked of every waiter on every tick.
 */
function queueRank(world: World, customer: Customer): number {
  let rank = 0;
  for (const other of world.customers) {
    if (other === customer) break;
    if (other.state === "waiting") rank++;
  }
  return rank;
}

/**
 * Where the nth person in the line stands: back down the path they walked in
 * on, in front of the door rather than in it.
 *
 * On the arrival row on purpose. The paving outside is also where the market
 * stall stands, so a queue you are failing to serve forms beside the thing that
 * would fix it — and the line points off down the path, which is the direction
 * the next one is coming from.
 */
function queueSpot(world: World, rank: number): Vec2 {
  const head = approachTile(world);
  return { x: head.x + 0.5 - rank * QUEUE_GAP, y: head.y + 0.5 };
}

/** Walk to a spot, without restarting the walk every tick it has not moved. */
function standAt(customer: Customer, spot: Vec2): void {
  const target = customer.path[0];
  if (customer.path.length === 1 && target && target.x === spot.x && target.y === spot.y) return;
  customer.path = [spot];
}

/** Stand facing the way you are hoping to be let in. */
function faceDoor(world: World, customer: Customer): void {
  const dx = world.door.x + 0.5 - customer.pos.x;
  const dy = world.door.y + 0.5 - customer.pos.y;
  const length = Math.hypot(dx, dy) || 1;
  customer.facing.x = dx / length;
  customer.facing.y = dy / length;
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
 * Which sort of person this is.
 *
 * Weighted, and **exactly one draw** whatever the table looks like — the same
 * rule `orderFrom` follows. Randomness spent conditionally is randomness that
 * makes two rooms on the same seed diverge over who happened to walk in.
 */
function pickKind(world: World): CustomerKind {
  const total = CUSTOMER_KINDS.reduce((sum, kind) => sum + kind.weight, 0);
  let roll = random(world) * total;
  for (const kind of CUSTOMER_KINDS) {
    roll -= kind.weight;
    if (roll < 0) return kind;
  }
  return CUSTOMER_KINDS.at(-1)!;
}

/**
 * A free, reachable table with room for `seats` of them, or null.
 *
 * "Free" means no customer has claimed it *and* nothing is left on it — a table
 * with a dirty plate still on it cannot be sat at, which is what gives bussing
 * its urgency during a rush.
 *
 * `seats` is where the build phase meets the dining room. A table in the open
 * has four chairs and can take a party of four; the same table shoved against a
 * wall has two, and a party of three will stand at the door waiting for one
 * that is not. Where the tables go is a decision about **who you can serve**,
 * not only about how many.
 */
function claimTable(world: World, reachable: Set<number>, seats = 1): Appliance | null {
  const taken = new Set(world.customers.map((c) => c.table).filter((id) => id !== null));
  let best: Appliance | null = null;
  let bestDistance = Infinity;
  for (const appliance of world.appliances.values()) {
    if (appliance.kind !== "table" || taken.has(appliance.id)) continue;
    if (appliance.item !== null || appliance.tip > 0) continue;
    if (!serving(world, appliance)) continue;
    const chairs = reachableSeats(world, appliance.tile, reachable);
    if (chairs.length < seats) continue;
    const chair = chairs[0];
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

function sitDown(world: World, customer: Customer, table: Appliance, reachable: Set<number>): void {
  // Which chair is a coin toss, drawn once, here — the only place a seat is
  // actually taken. A fixed side made a full dining room look choreographed,
  // every customer at the same o'clock of their own table. A party takes
  // whatever their friends left, which is why the taken chairs come out first.
  const used = new Set(
    world.customers
      .filter((other) => other !== customer && other.table === table.id && other.seat)
      .map((other) => `${other.seat?.x},${other.seat?.y}`),
  );
  const options = reachableSeats(world, table.tile, reachable).filter(
    (chair) => !used.has(`${chair.x},${chair.y}`),
  );
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
function walk(customer: Customer, dt: number, speed = customerSpeed(customer)): boolean {
  if (customer.path.length === 0) return true;

  let step = speed * dt;
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
 *
 * The render layer lays the biome's path slabs from here too, so the paving
 * under the walk on and the walk itself cannot drift apart.
 */
export function approachTile(world: World): Vec2 {
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
 * Give `plate` to this customer, if it is what they asked for. Returns the
 * reward paid, or null when it is not their dish.
 *
 * The plate is taken *from the caller*, not off the table, because a dish is
 * delivered from two places: a plate left standing there for somebody still
 * making their mind up, and a plate handed straight over from a chef's hands.
 * Whoever owns the plate is responsible for letting go of it — this function
 * only says whether the customer took it.
 *
 * Payment is split in two: the base reward is paid here, to whoever is
 * standing there; the tip is worked out here too but stays with the customer
 * until they leave, when it lands on the table for whoever busses it.
 *
 * Nothing is ever refused. A wrong dish simply is not this, so it sits on the
 * table with the order bubble still showing what was wanted, and picking it
 * back up undoes the mistake at the cost of the walk.
 */
function acceptDelivery(world: World, customer: Customer, plate: Item): number | null {
  const recipe = ordered(customer, plate);
  if (!recipe) return null;

  customer.state = "eating";
  customer.timer = eatTime(customer);
  // They take their dinner in front of them, which is what frees the table for
  // the rest of their party. Plates are conserved and this is a place one can
  // be — `platesInWorld` counts it, and they put it back dirty when they go.
  customer.plate = plate;
  return charge(world, customer, recipe);
}

/**
 * Is this the dish this customer asked for? The recipe if so, null if not.
 *
 * Split out from the delivery itself because a hatch answers the same question
 * and then does something else with the plate — a car takes the food out of it
 * and leaves the crockery behind. What counts as "their dish" must not be able
 * to differ between the two.
 */
function ordered(customer: Customer, plate: Item): Recipe | null {
  if (!isPlate(plate) || isDirty(plate) || plate.contents.length !== 1) return null;
  const recipe = DISH_INDEX.get(specKey(plate.contents[0]!));
  return recipe && recipe.id === customer.recipeId ? recipe : null;
}

/**
 * Book the sale: the reward into the till, the tip onto the customer, the day's
 * tally. Returns what was paid on the spot.
 *
 * Where the tip then *goes* is the dining room's business or the hatch's: a
 * diner leaves it on the table for whoever busses the plate, and a car has no
 * table so it is handed over with the change. Working it out in one place is
 * what keeps a fast cover worth the same wherever it is served.
 */
function charge(world: World, customer: Customer, recipe: Recipe): number {
  const speed = Math.max(0, customer.remaining / customer.patience);
  const kind = customerKind(customer.kind);
  customer.tip = Math.round(recipe.reward * TIP_FRACTION * speed * kind.generosity);

  world.money += recipe.reward;
  world.served++;
  world.today.earned += recipe.reward;
  world.today.served++;
  log(world, `${recipe.name} delivered  +$${recipe.reward}`);
  return recipe.reward;
}

/**
 * A plate, given to whoever at this table ordered it. Returns the reward, or
 * null when nobody here is waiting for it.
 *
 * A table can be several orders now, so "the customer sitting here" is no
 * longer a question with one answer. The **most impatient** match is fed
 * first: with two people at a table waiting for the same dish, the one whose
 * ring is nearly empty is the one about to walk out, and feeding the other
 * would lose an order the kitchen had already cooked for.
 */
export function serveTable(world: World, table: Appliance, plate: Item): number | null {
  const waiting = world.customers
    .filter((customer) => customer.table === table.id && customer.state === "ordering")
    .sort((a, b) => a.remaining - b.remaining);
  for (const customer of waiting) {
    const reward = acceptDelivery(world, customer, plate);
    if (reward !== null) return reward;
  }
  return null;
}

/**
 * A used plate, back onto the table it was eaten at.
 *
 * Stacked onto whatever is already there when it can be — a party of four
 * leaves one pile and one bussing run, which is the same trip the sink already
 * rewards. When it cannot (a chef has left something else on the table), the
 * plates go home to the stack clean rather than being dropped: a function whose
 * job is "a plate does not cease to exist" must not have a branch where one
 * does.
 */
function returnPlate(world: World, table: Appliance, plate: Item): void {
  if (table.item === null) {
    table.item = plate;
    return;
  }
  if (stackPlates(plate, table.item, MAX_PLATES)) return;
  stockPlates(world, plateCount(plate));
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
