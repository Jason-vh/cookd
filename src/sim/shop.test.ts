import { describe, expect, test } from "bun:test";
import { APPLIANCE_KINDS, applianceDef } from "../data/appliances";
import { FIRST_DELIVERY_DAY, SELLBACK, STALL_SLOTS } from "../data/economy";
import { LEVEL, LEVELS } from "../data/level";
import { RECIPES } from "../data/recipes";
import { Host } from "../game/host";
import { restore, snapshot } from "../save";
import { plateCount, platesInWorld, STACK_PLATES } from "./plates";
import { reachableFrom, seatsAround } from "./pathing";
import { canPlace } from "./queries";
import { offerPrice, restockStall, stallSlots } from "./shop";
import { beginDay, endDay } from "./day";
import { step } from "./step";
import type { Appliance, ApplianceKind, PlayerInput, Vec2, World } from "./types";
import {
  applianceAtTile,
  createWorld,
  emptyInput,
  tileIndex,
  nearestFreeTile,
  removePlayer,
  spawnAppliance,
} from "./world";

/**
 * The stall, the ledger and the morning.
 *
 * Everything here is driven the way a player drives it — stand in front of a
 * slot, press `Grab` — because the whole design claim of the shop is that it
 * introduces **no new verbs**. A test that reached in and called a `buy()`
 * function would be testing a different feature from the one that shipped.
 */

/**
 * A kitchen in its morning, with nobody due through the door.
 *
 * The *second* morning, because the first is delivered nothing at all and a
 * shop with nothing in it is not what any of this is about — see
 * `FIRST_DELIVERY_DAY`, and the day-one test below.
 */
function morning(): World {
  const world = createWorld(LEVEL, 1);
  world.nextArrivalIn = Infinity;
  world.day = FIRST_DELIVERY_DAY;
  restockStall(world);
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

/** Put whatever is being carried down on `tile`, which must be free floor. */
function place(world: World, tile: Vec2): void {
  faceGoods(world, tile);
  press(world, "grab");
}

/** Face slot `index` and press grab. */
function useSlot(world: World, index: number): Appliance {
  const slot = stallSlots(world)[index]!;
  faceGoods(world, slot.tile);
  press(world, "grab");
  return slot;
}

/** Force a slot to hold a particular thing, for tests about a specific price. */
function stock(world: World, index: number, kind: ApplianceKind): Appliance {
  const slot = stallSlots(world)[index]!;
  slot.offer = { kind, source: null };
  slot.taken = null;
  return slot;
}

function counts(world: World, kind: ApplianceKind): number {
  return [...world.appliances.values()].filter((a) => a.kind === kind).length;
}

/** Where the delivery landed, as one comparable string. */
function spots(world: World): string {
  return stallSlots(world)
    .map((slot) => `${slot.tile.x},${slot.tile.y}`)
    .join("|");
}

/** What the stall is showing, as one comparable string. */
function shown(world: World): string {
  return stallSlots(world)
    .map((slot) =>
      slot.offer === null
        ? "-"
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
  test("three squares land outside, and nothing may be built there", () => {
    const world = morning();
    const slots = stallSlots(world);
    expect(slots).toHaveLength(STALL_SLOTS);

    for (const slot of slots) {
      // A square is not a placement target: the delivery stands on paving, and
      // paving is not anywhere a kitchen may put an oven.
      expect(canPlace(world, slot.tile.x, slot.tile.y, "counter")).toBe(false);
      expect(world.tiles[slot.tile.y * world.width + slot.tile.x]?.placeable).toBe(false);
    }
  });

  test("every slot is stocked in the morning", () => {
    const world = morning();
    for (const slot of stallSlots(world)) expect(slot.offer).not.toBeNull();
  });

  test("everything for sale is out on the paving, and nothing is built there", () => {
    // The whole shop rests on one rule the game already enforced and never used
    // to say anything with: nothing may be *placed* on the paving, so anything
    // standing on it is not yours yet. That is what lets the goods be drawn as
    // themselves, with no stall around them to explain what they are.
    const world = morning();
    for (const slot of stallSlots(world)) {
      const tile = world.tiles[slot.tile.y * world.width + slot.tile.x];
      expect(tile?.walkable).toBe(true);
      expect(tile?.placeable).toBe(false);
      // And reachable: a delivery nobody can walk up to is money nobody can
      // spend, which is the one way this arrangement can be got wrong.
      expect(seatsAround(world, slot.tile).length).toBeGreaterThan(0);
    }
  });

  test("day one is delivered nothing, and stands nothing outside", () => {
    // A kitchen opens with $0, so four things it cannot buy would be four
    // refusals — and the one morning everything worth knowing is inside the
    // walls is not the morning to put a shop outside them.
    const world = createWorld(LEVEL, 1);
    expect(world.day).toBe(1);
    expect(world.money).toBe(0);
    for (const slot of stallSlots(world)) expect(slot.offer).toBeNull();
  });

  test("nothing stands outside but the delivery", () => {
    // The recipe posters used to hang on the shell out here, and they were the
    // last thing outside that existed only to hold an offer. A card is a good
    // on a pallet now, so the paving has four squares on it and nothing else.
    const world = morning();
    const { x, y, width, height } = world.room;
    for (const appliance of world.appliances.values()) {
      const tile = appliance.tile;
      const outside = tile.x < x || tile.x >= x + width || tile.y < y || tile.y >= y + height;
      if (outside) expect(appliance.kind).toBe("stall");
    }
    expect(counts(world, "cards")).toBe(0);
  });

  test("a new morning's stock is a layout change", () => {
    // Offers ride the layout message, and the server only sends one when the
    // version moves. Without this a client spent the whole of day two looking
    // at day one's slots — reading "Plate" off one and being handed the bin the
    // host had actually rolled into it.
    const world = morning();
    const before = world.layoutVersion;
    world.day++;
    restockStall(world);
    expect(world.layoutVersion).toBeGreaterThan(before);
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

  test("a day costs nothing to have had: the till is the same at open", () => {
    // Nothing is deducted anywhere in the loop, so the only way money leaves a
    // kitchen is somebody buying something. A day that served nobody is a day
    // that changed no number.
    const world = morning();
    world.money = 5;
    beginDay(world);
    world.dayTime = 0.05;
    for (let i = 0; i < 20; i++) step(world, idle());

    expect(world.phase).toBe("build");
    expect(world.money).toBe(5);
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

    // Lift the kitchen's own bin and carry it out to the stall.
    const bin = [...world.appliances.values()].find((a) => a.kind === "bin")!;
    const player = world.players[0]!;
    player.pos = { x: bin.tile.x + 0.5, y: bin.tile.y + 1.5 };
    player.prevPos = { ...player.pos };
    player.facing = { x: 0, y: -1 };
    press(world, "grab");
    expect(player.carriedAppliance).toBe(bin.id);

    useSlot(world, 0);
    expect(world.money).toBe(Math.floor(applianceDef("bin").price * SELLBACK));
    expect(counts(world, "bin")).toBe(0);
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
    beginDay(world);
    expect(world.phase).toBe("service");

    useSlot(world, 0);
    expect(world.money).toBe(100);
    expect(world.players[0]!.carriedAppliance).toBeNull();
  });
});

describe("plates are the one thing the game will make", () => {
  test("a bought stack arrives stocked, and its plates survive a whole day loop", () => {
    // Single plates used to be for sale, and they were the one purchase that
    // put a loose *item* in a chef's hands during a phase that only understands
    // appliances — so the grab meant to set the plate on a counter lifted the
    // counter instead. A stack is a thing the morning already knows how to
    // hold, and it comes with the crockery that makes it worth buying.
    const world = morning();
    world.money = applianceDef("plates").price;
    stock(world, 0, "plates");

    expect(platesInWorld(world)).toBe(LEVEL.plates);
    useSlot(world, 0);
    expect(world.money).toBe(0);
    expect(platesInWorld(world)).toBe(LEVEL.plates + STACK_PLATES);
    // Held, like every other appliance bought at the stall, and ready to place.
    const bought = world.appliances.get(world.players[0]!.carriedAppliance!)!;
    expect(bought.kind).toBe("plates");
    expect(plateCount(bought.item)).toBe(STACK_PLATES);

    // Put it down, then through service, closing time and into the next
    // morning. Closing counts plates out and counts them back in, so a miscount
    // shows up here.
    place(world, { x: 15, y: 6 });
    beginDay(world);
    for (let i = 0; i < 120; i++) step(world, idle());
    endDay(world);
    expect(platesInWorld(world)).toBe(LEVEL.plates + STACK_PLATES);

    beginDay(world);
    endDay(world);
    expect(platesInWorld(world)).toBe(LEVEL.plates + STACK_PLATES);
  });

  test("putting the stack straight back is an undo, plates and all", () => {
    const world = morning();
    world.money = applianceDef("plates").price;
    const slot = stock(world, 0, "plates");
    useSlot(world, 0);
    expect(platesInWorld(world)).toBe(LEVEL.plates + STACK_PLATES);

    // Back on the slot it came from: full price, and the crockery it was
    // carrying goes with it. Anything else would be a way to mint four plates
    // for nothing.
    faceGoods(world, slot.tile);
    press(world, "grab");
    expect(world.money).toBe(applianceDef("plates").price);
    expect(platesInWorld(world)).toBe(LEVEL.plates);
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
      // Where it landed is rolled from the same seed and the same day, and
      // nobody sends it over the wire either. A friend walking out of the door
      // to a different set of squares is the same class of bug as a friend
      // seeing a different price.
      expect(spots(a.world)).toBe(spots(b.world));

      // Only one of them plays: the roll must not depend on the live RNG
      // stream, which arrivals and seating consume at their own pace.
      beginDay(a.world);
      for (let i = 0; i < 600; i++) step(a.world, {});
      endDay(a.world);
      beginDay(b.world);
      endDay(b.world);
      expect(a.world.day).toBe(b.world.day);
    }
  });

  test("nothing for sale ever lands where nobody can walk up to it", () => {
    // The rule the whole arrangement rests on: goods nobody can reach are money
    // nobody can spend, in silence. It is not hypothetical — the delivery is
    // solid, so every square is an obstacle on the paving everybody walks, and
    // at seven squares a naive roll stranded something on 6% of mornings.
    //
    // It took three goes, and the first two were rules about *distance*: no two
    // squares orthogonally adjacent, then none touching even at the corners, on
    // the reasoning that the ring is two tiles deep and a diagonal pair seals
    // it. Both true, neither sufficient — where a building runs within a tile of
    // the grid's edge the band beside it is one deep and a dead end, and there
    // two squares strand what is between them at any spacing at all. So the
    // question is asked as reachability, which is the thing actually wanted.
    //
    // Across every level, because the shapes that break it are level shapes:
    // the beach shack's south band is the one that found this.
    for (const level of Object.values(LEVELS)) {
      for (let seed = 1; seed <= 12; seed++) {
        const world = createWorld(level, 0, seed);
        for (let day = 2; day <= 12; day++) {
          world.day = day;
          restockStall(world);
          const reachable = reachableFrom(world, world.door);
          for (const slot of stallSlots(world)) {
            if (!slot.offer) continue; // a bare square strands nothing
            const canBeReached = seatsAround(world, slot.tile).some((tile) =>
              reachable.has(tileIndex(world, tile.x, tile.y)),
            );
            expect(canBeReached).toBe(true);
          }
        }
      }
    }
  });

  test("and the whole delivery arrives, on the kitchens whose paving is two tiles deep", () => {
    // The test above lets a bare square pass, on the grounds that a square with
    // nothing on it strands nothing. True, and it is still a delivery the
    // kitchen did not get — so this is the other half: every square lands
    // holding something.
    //
    // It is the *sealing* rule that this holds to account. Asking only whether
    // the squares placed so far were reachable let an early one wall off an arm
    // of paving nobody had landed on yet, which cost the squares still to come
    // everywhere to stand: on the beach shack, whose delivery band is two tiles
    // wide with the door at the middle of it, one morning in five arrived short
    // and some arrived three short.
    for (const level of Object.values(LEVELS)) {
      for (let seed = 1; seed <= 12; seed++) {
        const world = createWorld(level, 0, seed);
        for (let day = 2; day <= 12; day++) {
          world.day = day;
          restockStall(world);
          for (const slot of stallSlots(world)) {
            expect(slot.offer).not.toBeNull();
          }
        }
      }
    }
  });

  test("a new morning lands the delivery somewhere else, and never on the way in", () => {
    // A delivery that appeared on the same squares every day would be squares
    // the game had reserved, which is the shop-as-furniture problem coming back
    // in through the floor.
    const world = morning();
    const seen = new Set<string>();
    for (let day = 1; day <= 6; day++) {
      world.day = day;
      restockStall(world);
      seen.add(spots(world));
      for (const slot of stallSlots(world)) {
        // Never the row somebody walks up to the door along: a crate there can
        // seal a restaurant shut, and it is the one square that must stay free.
        expect(slot.tile.y).not.toBe(world.door.y);
        // On the paving, and on the grid it says it is on.
        expect(world.tiles[slot.tile.y * world.width + slot.tile.x]?.walkable).toBe(true);
        expect(applianceAtTile(world, slot.tile.x, slot.tile.y)).toBe(slot);
      }
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  test("a morning always holds something the kitchen is short of", () => {
    // Three duds is a shop players stop walking to. The lean starting kitchen
    // owns one of almost everything, so the guarantee has plenty to choose from.
    const world = morning();
    const kinds = stallSlots(world)
      .map((slot) => slot.offer?.kind ?? null)
      .filter((kind) => kind !== null);
    const scarce = kinds.some((kind) => counts(world, kind) < 2);
    expect(scarce || kinds.length < STALL_SLOTS).toBe(true);
  });

  test("an upgrade is a luxury rather than a gap, so it is never the promised slot", () => {
    // A kitchen holding two of every plain kind is short of nothing — except
    // upgrades, which it owns none of and will own none of for a week. Counted
    // as scarce they would qualify forever, and the one slot reserved for what
    // a room actually needs would spend every morning on a $320 oven.
    const world = morning();
    world.unlocked = RECIPES.map((recipe) => recipe.id);
    for (const kind of APPLIANCE_KINDS) {
      const def = applianceDef(kind);
      if (!def.movable || def.upgrades !== null) continue;
      while (counts(world, kind) < 2) {
        const tile = nearestFreeTile(world, { x: 15, y: 6 });
        if (!tile) throw new Error("the kitchen ran out of floor");
        spawnAppliance(
          world,
          kind,
          tile,
          kind === "crate" ? { base: "tomato", processes: [] } : null,
        );
      }
    }

    let mornings = 0;
    let bare = 0;
    for (let day = 1; day <= 40; day++) {
      world.day = day;
      restockStall(world);
      const upgrades = stallSlots(world).filter(
        (slot) => slot.offer !== null && applianceDef(slot.offer.kind).upgrades !== null,
      ).length;
      if (upgrades > 0) mornings++;
      else bare++;
    }

    // For sale, and not on offer every morning: the two halves of "rare".
    expect(mornings).toBeGreaterThan(0);
    expect(bare).toBeGreaterThan(0);
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

/**
 * A slot emptied yesterday is stocked again this morning.
 *
 * Obvious, and worth pinning down, because it is the failure a player actually
 * reported: buy something on the morning of day one and the square was still
 * bare on the morning of day two. Every path is covered rather than one — a
 * purchase, an undo, and a sale — because the slot records those three
 * differently, and the whole class of bug is one of them forgetting to be
 * cleared. The save is in the loop for the same reason: what a room already
 * bought is the one thing about the shop that is written down.
 */
/** Every slot holding something nobody has taken yet. */
function stocked(world: World): void {
  for (const slot of stallSlots(world)) {
    expect(slot.offer).not.toBeNull();
    expect(slot.taken).toBeNull();
  }
}

describe("a morning always restocks", () => {
  for (const kind of ["counter", "plates", "crate"] as const) {
    test(`after buying a ${kind}, and through a save`, () => {
      const world = morning();
      world.money = 1000;
      stock(world, 0, kind);
      useSlot(world, 0);
      place(world, { x: 15, y: 6 });
      expect(stallSlots(world)[0]!.offer === null || stallSlots(world)[0]!.taken !== null).toBe(
        true,
      );

      beginDay(world);
      endDay(world);
      stocked(world);

      // ...and the same morning rebuilt from disk. The stock is rolled from the
      // seed and the day rather than stored, so a save that got this wrong
      // would hand a returning room an empty shop it could never refill.
      const reloaded = createWorld(LEVEL, 1);
      expect(restore(reloaded, snapshot(world, LEVEL), LEVEL).ok).toBe(true);
      stocked(reloaded);
    });
  }

  test("after putting a purchase straight back", () => {
    const world = morning();
    world.money = 1000;
    const slot = stock(world, 0, "counter");
    useSlot(world, 0);
    faceGoods(world, slot.tile);
    press(world, "grab");
    beginDay(world);
    endDay(world);
    stocked(world);
  });
});
