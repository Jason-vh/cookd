import { describe, expect, test } from "bun:test";
import { applianceDef } from "../data/appliances";
import { LEVEL } from "../data/level";
import { offerLabel } from "./shop";
import { encodeLayout, applyLayout } from "../game/protocol";
import { parseServerMessage } from "../game/wire";
import { parseSave, restore, snapshot } from "../save";
import { makeItem, specKey } from "./items";
import { DT, step } from "./step";
import type { Appliance, Item, Vec2, World } from "./types";
import { applianceAtTile, createWorld, emptyInput, spawnAppliance, tileIndex } from "./world";

/**
 * The machines: the appliances that do their job with nobody standing at them.
 *
 * A conveyor carries what it is given; a hopper produces. They are tested
 * together because they share the rule that matters — `outlet`, which decides
 * where a machine may put something — and most of what is worth pinning here is
 * that rule seen from both ends: hand over only into somewhere empty that
 * accepts items, never through a wall, never by performing a chef's special
 * verbs, and when blocked hold on rather than drop. Conservation is why the
 * last one matters — a plate that fell off the end of a belt would be a plate
 * the kitchen never gets back.
 */

const TRAVEL = applianceDef("belt").travel;

/** A kitchen in service, with nobody due through the door. */
function makeWorld(): World {
  const world = createWorld(LEVEL, 1);
  world.nextArrivalIn = Infinity;
  world.phase = "service";
  world.dayTime = world.dayLength;
  return world;
}

/** Take whatever is standing on this tile out of the kitchen. */
function clear(world: World, tile: Vec2): void {
  const standing = applianceAtTile(world, tile.x, tile.y);
  if (!standing) return;
  world.appliances.delete(standing.id);
  world.applianceAt[tileIndex(world, tile.x, tile.y)] = 0;
}

function put(world: World, kind: Appliance["kind"], tile: Vec2): Appliance {
  clear(world, tile);
  return spawnAppliance(world, kind, tile);
}

/** A run of belts from `at`, all pointing the same way. */
function layBelts(world: World, at: Vec2, dir: Vec2, count: number): Appliance[] {
  const belts: Appliance[] = [];
  for (let i = 0; i < count; i++) {
    const belt = put(world, "belt", { x: at.x + dir.x * i, y: at.y + dir.y * i });
    belt.dir = { ...dir };
    belts.push(belt);
  }
  return belts;
}

function run(world: World, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) step(world, { 0: emptyInput() }, DT);
}

function tomato(world: World): Item {
  return makeItem(world, { base: "tomato", processes: [] });
}

/** A hopper on `tile`, pointing `dir`, full of `base`. */
function hopper(world: World, tile: Vec2, dir: Vec2, base = "tomato"): Appliance {
  const machine = put(world, "hopper", tile);
  machine.dir = { ...dir };
  machine.source = { base, processes: [] };
  return machine;
}

const EAST = { x: 1, y: 0 };
/** A clear row of kitchen floor, east of the divider. */
const ROW = { x: 12, y: 6 };

describe("a conveyor carries what is put on it", () => {
  test("across its own tile, and then on to whatever is standing at the end", () => {
    const world = makeWorld();
    const [belt] = layBelts(world, ROW, EAST, 1);
    const counter = put(world, "counter", { x: ROW.x + 1, y: ROW.y });
    const item = tomato(world);
    belt!.item = item;

    // Half way along, it is still on the belt and has visibly moved: the
    // progress is what the renderer slides the food with, so a belt that
    // teleported its load at the end would be a belt with nothing to draw.
    run(world, TRAVEL * 0.5);
    expect(belt!.item).toBe(item);
    expect(belt!.progress).toBeGreaterThan(0.3);
    expect(belt!.progress).toBeLessThan(0.7);

    run(world, TRAVEL);
    expect(belt!.item).toBeNull();
    expect(belt!.progress).toBe(0);
    expect(counter.item).toBe(item);
  });

  test("and a run of them moves it several tiles, one belt at a time", () => {
    const world = makeWorld();
    const belts = layBelts(world, ROW, EAST, 4);
    const item = tomato(world);
    belts[0]!.item = item;

    // Long enough for three handovers and not four: the point is that a belt
    // hands on at the *end* of its own travel, so a run is a queue rather than
    // a chute everything falls down in one tick.
    run(world, TRAVEL * 3.5);
    expect(belts[3]!.item).toBe(item);
    expect(belts.slice(0, 3).every((belt) => belt.item === null)).toBe(true);
  });

  test("into an oven, which then cooks unattended", () => {
    const world = makeWorld();
    const [belt] = layBelts(world, ROW, EAST, 1);
    const oven = put(world, "oven", { x: ROW.x + 1, y: ROW.y });
    belt!.item = makeItem(world, { base: "dough", processes: ["kneaded"] });

    // The whole reason the appliance exists: work that used to need a chef to
    // walk the dough over now needs one to have laid a belt yesterday.
    run(world, TRAVEL + 6.5);
    expect(specKey(oven.item!)).toBe("bread|baked");
  });
});

describe("where a conveyor may not hand over", () => {
  test("onto a tile with nothing on it: the item waits at the end of the band", () => {
    const world = makeWorld();
    const [belt] = layBelts(world, ROW, EAST, 1);
    clear(world, { x: ROW.x + 1, y: ROW.y });
    const item = tomato(world);
    belt!.item = item;

    run(world, TRAVEL * 3);
    // Parked, not dropped. There is no such thing as an item on the floor, and
    // a belt that ran off the end of its run would be inventing one.
    expect(belt!.item).toBe(item);
    expect(belt!.progress).toBe(1);
  });

  test("into something already holding an item, which is what backs a run up", () => {
    const world = makeWorld();
    const belts = layBelts(world, ROW, EAST, 2);
    const first = tomato(world);
    const second = tomato(world);
    belts[1]!.item = second;
    belts[0]!.item = first;

    run(world, TRAVEL * 4);
    expect(belts[0]!.item).toBe(first);
    expect(belts[1]!.item).toBe(second);

    // And it comes unstuck the moment the queue does, without anybody having to
    // put the first item back on.
    belts[1]!.item = null;
    run(world, TRAVEL * 2);
    expect(belts[0]!.item).toBeNull();
    // Read off the grid rather than through the local, which the assignment
    // above has narrowed to `null` for the rest of the test.
    expect(applianceAtTile(world, ROW.x + 1, ROW.y)?.item).toBe(first);
  });

  test("through a wall", () => {
    const world = makeWorld();
    // The dividing wall sits on the seam at x = 8, so a belt in the kitchen
    // pointing west at row 2 is pointing at the dining room through it.
    const belt = put(world, "belt", { x: 8, y: 2 });
    belt.dir = { x: -1, y: 0 };
    const counter = put(world, "counter", { x: 7, y: 2 });
    const item = tomato(world);
    belt.item = item;

    run(world, TRAVEL * 3);
    expect(counter.item).toBeNull();
    expect(belt.item).toBe(item);
  });

  test("into something that does not take items at all", () => {
    const world = makeWorld();
    const [belt] = layBelts(world, ROW, EAST, 1);
    const crate = put(world, "crate", { x: ROW.x + 1, y: ROW.y });
    const item = tomato(world);
    belt!.item = item;

    run(world, TRAVEL * 3);
    expect(crate.item).toBeNull();
    expect(belt!.item).toBe(item);
  });

  test("into a belt somebody is carrying", () => {
    const world = makeWorld();
    const belts = layBelts(world, ROW, EAST, 2);
    const item = tomato(world);
    belts[0]!.item = item;
    // Lifting an appliance leaves its id on the tile for one build-phase frame;
    // handing an item to something in a chef's hands would put food inside a
    // ghost.
    belts[1]!.heldBy = 0;

    run(world, TRAVEL * 3);
    expect(belts[1]!.item).toBeNull();
    expect(belts[0]!.item).toBe(item);
  });
});

describe("what a conveyor is not", () => {
  test("a place food burns: nothing cooks on it and nothing spoils on it", () => {
    const world = makeWorld();
    const [belt] = layBelts(world, ROW, EAST, 1);
    clear(world, { x: ROW.x + 1, y: ROW.y });
    // Fries burn six seconds after they are done. A belt has no station, so it
    // has no burn time either — which makes a run of them the one safe place to
    // leave a finished dish, and that is a design decision rather than an
    // omission.
    belt!.item = makeItem(world, { base: "fries", processes: ["fried"] });

    run(world, 30);
    expect(specKey(belt!.item)).toBe("fries|fried");
    expect(belt!.overcook).toBe(0);
  });

  test("a pair of hands: it will not combine what it carries with what it meets", () => {
    const world = makeWorld();
    const [belt] = layBelts(world, ROW, EAST, 1);
    const counter = put(world, "counter", { x: ROW.x + 1, y: ROW.y });
    // Chopped lettuce onto chopped tomato is a salad when a chef does it. A
    // belt only ever puts something down where there is nothing, so the two sit
    // one tile apart until somebody walks over.
    counter.item = makeItem(world, { base: "tomato", processes: ["chopped"] });
    const lettuce = makeItem(world, { base: "lettuce", processes: ["chopped"] });
    belt!.item = lettuce;

    run(world, TRAVEL * 3);
    expect(specKey(counter.item)).toBe("tomato|chopped");
    expect(belt!.item).toBe(lettuce);
  });
});

describe("a hopper loads a belt", () => {
  test("one item at a time, on its own, with nobody in the kitchen", () => {
    const world = makeWorld();
    hopper(world, ROW, EAST);
    const belt = put(world, "belt", { x: ROW.x + 1, y: ROW.y });
    belt.dir = { ...EAST };
    clear(world, { x: ROW.x + 2, y: ROW.y });

    expect(belt.item).toBeNull();
    run(world, applianceDef("hopper").feeds + DT);
    expect(specKey(belt.item!)).toBe("tomato");
  });

  test("and the line runs itself: hopper, belt, oven, baked potato", () => {
    const world = makeWorld();
    hopper(world, ROW, EAST, "potato");
    const belt = put(world, "belt", { x: ROW.x + 1, y: ROW.y });
    belt.dir = { ...EAST };
    const oven = put(world, "oven", { x: ROW.x + 2, y: ROW.y });

    // Nobody presses anything: the potato is minted, carried and baked while
    // the one chef in the room stands still. This is the whole feature.
    run(world, applianceDef("hopper").feeds + applianceDef("belt").travel + 7.5);
    expect(specKey(oven.item!)).toBe("potato|baked");
  });

  test("onto anything that takes items, not only a belt", () => {
    const world = makeWorld();
    hopper(world, ROW, EAST);
    const counter = put(world, "counter", { x: ROW.x + 1, y: ROW.y });

    run(world, applianceDef("hopper").feeds + DT);
    expect(specKey(counter.item!)).toBe("tomato");
  });

  test("and stops dead when there is nowhere to put anything", () => {
    const world = makeWorld();
    const machine = hopper(world, ROW, EAST);
    const counter = put(world, "counter", { x: ROW.x + 1, y: ROW.y });
    counter.item = tomato(world);
    const before = world.nextId;

    run(world, applianceDef("hopper").feeds * 4);
    // Held at the top of its cycle, and — the part worth a test — **minting
    // nothing**. A hopper that made a tomato and threw it away because the belt
    // was full would burn an id sixty times a second, and ids are what two
    // clients agree about things by.
    expect(machine.progress).toBe(1);
    expect(world.nextId).toBe(before);
  });

  test("and is switched off while the restaurant is shut", () => {
    const world = makeWorld();
    world.phase = "build";
    hopper(world, ROW, EAST);
    const belt = put(world, "belt", { x: ROW.x + 1, y: ROW.y });

    // Otherwise a morning spent rearranging the kitchen opens the day with a
    // tomato on every surface a hopper happens to face.
    run(world, applianceDef("hopper").feeds * 3);
    expect(belt.item).toBeNull();
  });

  test("and cannot feed through a wall, exactly as a belt cannot", () => {
    const world = makeWorld();
    hopper(world, { x: 8, y: 2 }, { x: -1, y: 0 });
    const counter = put(world, "counter", { x: 7, y: 2 });

    run(world, applianceDef("hopper").feeds * 3);
    expect(counter.item).toBeNull();
  });

  test("a plain crate does none of this", () => {
    const world = makeWorld();
    const crate = put(world, "crate", ROW);
    crate.dir = { ...EAST };
    crate.source = { base: "tomato", processes: [] };
    const belt = put(world, "belt", { x: ROW.x + 1, y: ROW.y });

    run(world, applianceDef("hopper").feeds * 3);
    expect(belt.item).toBeNull();
  });
});

describe("buying a hopper", () => {
  test("it arrives holding an ingredient, and says which", () => {
    // The shop used to ask `kind !== "crate"` to decide what came full. A
    // hopper that arrived empty would be a $75 machine handing out nothing,
    // with nowhere in the game to put an ingredient into it.
    const source = { base: "tomato", processes: [] };
    expect(offerLabel({ kind: "hopper", source })).toBe("Tomato hopper");
    expect(offerLabel({ kind: "crate", source })).toBe("Tomato crate");
  });
});

describe("which way a belt runs", () => {
  test("is decided by the chef who puts it down", () => {
    const world = makeWorld();
    world.phase = "build";
    const player = world.players[0]!;
    const belt = spawnAppliance(world, "belt", ROW, null, player.id);
    player.carriedAppliance = belt.id;

    // Standing south of the tile looking north, which is how a run is laid:
    // walk the route, dropping one each step.
    const target = { x: ROW.x, y: ROW.y + 1 };
    clear(world, target);
    player.pos = { x: target.x + 0.5, y: target.y + 1.5 };
    player.facing = { x: 0, y: -1 };
    step(world, { [player.id]: { ...emptyInput(), grab: true } }, DT);

    expect(belt.heldBy).toBeNull();
    expect(belt.dir).toEqual({ x: 0, y: -1 });
  });

  test("survives a save, and a save that claims a silly one is refused", () => {
    const world = makeWorld();
    const [belt] = layBelts(world, ROW, EAST, 1);
    belt!.dir = { x: 0, y: -1 };

    const saved = snapshot(world, LEVEL);
    const restored = makeWorld();
    expect(restore(restored, saved, LEVEL).ok).toBe(true);
    const back = applianceAtTile(restored, ROW.x, ROW.y);
    expect(back?.kind).toBe("belt");
    expect(back?.dir).toEqual({ x: 0, y: -1 });

    // A hand-edited file must not be able to make a belt reach across the
    // kitchen: the direction is what picks the tile it hands its load to.
    const silly = { ...saved, appliances: [{ kind: "belt", x: 1, y: 1, dir: { x: 4, y: 0 } }] };
    expect(parseSave(silly)).toBeNull();
  });

  test("survives the wire, direction and all", () => {
    const world = makeWorld();
    const [belt] = layBelts(world, ROW, EAST, 2);
    belt!.dir = { x: 0, y: 1 };

    // Through the parser rather than straight into `applyLayout`: the point is
    // that a belt is describable by a message a client would actually accept.
    const message = parseServerMessage(
      JSON.parse(JSON.stringify({ t: "layout", layout: encodeLayout(world) })),
    );
    if (message?.t !== "layout") throw new Error("a kitchen with a belt in it did not parse");
    const mirror = makeWorld();
    applyLayout(mirror, message.layout);
    expect(applianceAtTile(mirror, ROW.x, ROW.y)?.dir).toEqual({ x: 0, y: 1 });
    expect(applianceAtTile(mirror, ROW.x + 1, ROW.y)?.dir).toEqual(EAST);
  });
});
