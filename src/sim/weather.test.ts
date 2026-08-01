import { describe, expect, test } from "bun:test";
import { BEACH_SHACK, HIGHWAY_STOP, LEVEL, PARK_KITCHEN } from "../data/level";
import { generateLevel, seedFromCode } from "../data/generate";
import { FIRST_DELIVERY_DAY } from "../data/economy";
import { WEATHERS, weatherById } from "../data/weather";
import { encodeLayout } from "../game/protocol";
import { restore, snapshot } from "../save";
import { canPlace } from "./queries";
import { endDay } from "./day";
import { DT, step } from "./step";
import type { Appliance, Vec2, World } from "./types";
import { rollWeather, servesOutdoors, setWeather, weatherOf } from "./weather";
import { createWorld, emptyInput, outdoors, spawnAppliance } from "./world";

/**
 * The weather, and the terrace it opens and shuts.
 *
 * The rules being pinned here are the ones that are invisible from a
 * screenshot: that two clients roll the same sky, that a table outside is
 * furniture in the rain, and that the levels' own terraces are somewhere a
 * kitchen can actually build.
 */

/** A kitchen in service, with nobody due through the door. */
function serving(world: World): World {
  world.phase = "service";
  world.dayTime = world.dayLength;
  world.nextArrivalIn = Infinity;
  return world;
}

/** Where a level says the terrace is, as one tile of it. */
function terraceTile(level: typeof LEVEL): Vec2 {
  const area = level.terrace?.[0];
  if (!area) throw new Error(`${level.id} has no terrace`);
  return { x: area.x, y: area.y };
}

/** Stand a table out on the terrace, and give the world nothing else to sit at. */
function onlyTerraceTable(world: World, at: Vec2): Appliance {
  for (const [id, appliance] of world.appliances) {
    if (appliance.kind === "table") world.appliances.delete(id);
  }
  world.applianceAt.fill(0);
  for (const appliance of world.appliances.values()) {
    world.applianceAt[appliance.tile.y * world.width + appliance.tile.x] = appliance.id;
  }
  return spawnAppliance(world, "table", at);
}

function run(world: World, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) step(world, { 0: emptyInput() }, DT);
}

describe("what sort of day it is", () => {
  test("two rooms on one seed get the same sky, and it is not the same every day", () => {
    // The whole reason it is rolled from `(seed, day)` rather than from the
    // world's own stream: play consumes that stream, so by the first customer
    // two clients have diverged and would be drawing different weather.
    for (let day = 1; day < 40; day++) {
      expect(rollWeather(7, day).id).toBe(rollWeather(7, day).id);
    }
    const week = Array.from({ length: 40 }, (_, i) => rollWeather(7, i + 1).id);
    expect(new Set(week).size).toBeGreaterThan(1);
  });

  test("the first day is fair, like the first morning has no delivery", () => {
    for (let seed = 0; seed < 50; seed++) {
      for (let day = 1; day < FIRST_DELIVERY_DAY; day++) {
        expect(rollWeather(seed, day).outdoor).toBe(true);
        expect(rollWeather(seed, day).id).toBe("fair");
      }
    }
  });

  test("every kind of day turns up, and none of them is unreadable", () => {
    const seen = new Set<string>();
    for (let day = FIRST_DELIVERY_DAY; day < 400; day++) seen.add(rollWeather(3, day).id);
    expect([...seen].sort()).toEqual(WEATHERS.map((entry) => entry.id).sort());
    for (const entry of WEATHERS) {
      expect(entry.note).not.toBe("");
      expect(entry.trade).toBeGreaterThan(0);
    }
  });

  test("a wet day takes the contrast and leaves the colour", () => {
    // The rule the sky shifts are tuned against, and it is here because it was
    // got wrong first: rain drew the way a photograph of rain looks — drained,
    // cold, dark and closed in — and the result was a morning to sit out rather
    // than play. The mechanics already charge for a rainy day; the picture must
    // not pile on. See the note on `SkyShift`.
    for (const entry of WEATHERS) {
      // Colour survives every kind of day. Below about this the food stops
      // looking like food, which is most of what "depressing" actually is.
      expect(entry.sky.saturation).toBeGreaterThan(0.85);
      // Cooler than a fair day, never colder than neutral: the biomes run
      // 0.3–0.6 warm, so this has to leave most of it standing.
      expect(entry.sky.warmth).toBeGreaterThan(-0.3);
      // Some sun always gets through, which is what keeps contact shadows
      // under things. A scene with no directional light reads as broken long
      // before it reads as weather.
      expect(entry.sky.sun).toBeGreaterThan(0.25);
      // What the sun loses, the flat light gains. A shift that dimmed both
      // would simply be turning the lights off.
      if (entry.sky.sun < 1) expect(entry.sky.ambient).toBeGreaterThan(1);
    }
  });

  test("the kinds of day are ordered, so the sky is readable without the card", () => {
    const [fair, overcast, rain] = WEATHERS;
    // Greyer as it gets wetter, in every dial at once. Without this a tuning
    // pass can leave rain looking brighter than overcast, and the sky stops
    // being something a player can read the day off.
    for (const dial of ["sun", "saturation"] as const) {
      expect(fair!.sky[dial]).toBeGreaterThan(overcast!.sky[dial]);
      expect(overcast!.sky[dial]).toBeGreaterThan(rain!.sky[dial]);
    }
    expect(fair!.sky.warmth).toBeGreaterThan(overcast!.sky.warmth);
    expect(overcast!.sky.warmth).toBeGreaterThan(rain!.sky.warmth);
  });

  test("only the wet ones are wet, and only the wet ones shut the terrace", () => {
    // The two halves of a weather have to agree: a day drawn with rain falling
    // through it and the terrace still open would be the picture and the rule
    // saying different things, which is the one thing the terrace exists to
    // avoid.
    for (const entry of WEATHERS) {
      expect(entry.rain > 0).toBe(!entry.outdoor);
    }
  });

  test("a weather nobody has heard of is a fair day, not a broken kitchen", () => {
    // The wire tolerates unknown ids for the reason it tolerates an unknown
    // customer kind: a client on yesterday's deploy should get the wrong sky
    // rather than no game.
    expect(weatherById("hurricane").id).toBe("fair");
  });

  test("closing the day rolls tomorrow's, and the morning card can already read it", () => {
    const world = serving(createWorld(LEVEL, 1));
    world.day = 5;
    world.dayTime = 0;
    endDay(world);
    expect(world.day).toBe(6);
    expect(world.weather).toBe(rollWeather(world.seed, 6).id);
  });

  test("a kitchen comes back from disk into the same sky it went to bed under", () => {
    const world = createWorld(LEVEL, 1);
    world.day = 9;
    setWeather(world);
    const before = world.weather;

    const restored = createWorld(LEVEL, 1);
    expect(restore(restored, snapshot(world, LEVEL), LEVEL).ok).toBe(true);
    // Not in the file: it is a function of the seed and the day, and both came
    // back. Restarting the server must not be a way to reroll the weather.
    expect(restored.weather).toBe(before);
  });

  test("it rides the layout, because nothing has moved when it changes", () => {
    const world = createWorld(LEVEL, 1);
    world.day = 12;
    const version = world.layoutVersion;
    setWeather(world);
    // The easiest bump in the game to forget: no appliance moved, and a client
    // that is never re-sent the layout plays a whole day under yesterday's sky.
    expect(world.layoutVersion).toBeGreaterThan(version);
    expect(encodeLayout(world).weather).toBe(world.weather);
  });
});

describe("the terrace", () => {
  test("is paving a kitchen may build on, and the apron beside it still is not", () => {
    const world = createWorld(PARK_KITCHEN, 1);
    const outside = terraceTile(PARK_KITCHEN);
    expect(canPlace(world, outside.x, outside.y, "table")).toBe(true);
    expect(outdoors(world, outside)).toBe(true);
    // The north apron is ordinary paving: walkable, and not somewhere to build.
    expect(canPlace(world, 0, 0, "table")).toBe(false);
  });

  test("every level that has one puts it somewhere a customer can reach", () => {
    for (const level of [PARK_KITCHEN, BEACH_SHACK, generateLevel(seedFromCode("TERRACE"))]) {
      const world = createWorld(level, 0);
      const at = terraceTile(level);
      const table = onlyTerraceTable(world, at);
      serving(world);
      world.nextArrivalIn = 0;
      run(world, 30);
      // Somebody walked out of the park, round the building and sat down. If
      // this fails the terrace is decoration.
      expect(world.customers.some((customer) => customer.table === table.id)).toBe(true);
    }
  });

  test("shuts in the rain, and the room goes quiet with it", () => {
    const world = serving(createWorld(PARK_KITCHEN, 1));
    const table = onlyTerraceTable(world, terraceTile(PARK_KITCHEN));
    world.weather = "rain";
    expect(servesOutdoors(world)).toBe(false);

    world.nextArrivalIn = 0;
    run(world, 40);
    // Nobody is seated outside. They may still walk up and queue at the door —
    // that is the room being *full*, which is exactly what a shut terrace is.
    expect(world.customers.some((customer) => customer.table === table.id)).toBe(false);

    // And the same kitchen on a fair day fills it.
    const fair = serving(createWorld(PARK_KITCHEN, 1));
    const open = onlyTerraceTable(fair, terraceTile(PARK_KITCHEN));
    fair.weather = "fair";
    fair.nextArrivalIn = 0;
    run(fair, 40);
    expect(fair.customers.some((customer) => customer.table === open.id)).toBe(true);
  });

  test("a table inside is never anybody's business but the kitchen's", () => {
    const world = serving(createWorld(PARK_KITCHEN, 1));
    world.weather = "rain";
    world.nextArrivalIn = 0;
    run(world, 40);
    // The level's own tables are indoors, so the worst weather in the game
    // leaves the dining room working.
    const seated = world.customers.filter((customer) => customer.table !== null);
    expect(seated.length).toBeGreaterThan(0);
    for (const customer of seated) {
      const table = world.appliances.get(customer.table!)!;
      expect(outdoors(world, table.tile)).toBe(false);
    }
  });
});

describe("what the weather says to a kitchen with no chairs", () => {
  test("the drive-through feels it through the road rather than the furniture", () => {
    // A lane has nothing to close, so `trade` is the whole of what weather can
    // do to it — and it has to actually reach the arrival clock.
    const quiet = serving(createWorld(HIGHWAY_STOP, 1));
    quiet.weather = "rain";
    quiet.rngState = 42;
    quiet.nextArrivalIn = 0;
    run(quiet, 60);

    const busy = serving(createWorld(HIGHWAY_STOP, 1));
    busy.weather = "fair";
    busy.rngState = 42;
    busy.nextArrivalIn = 0;
    run(busy, 60);

    expect(weatherOf(quiet).trade).toBeGreaterThan(weatherOf(busy).trade);
    expect(quiet.nextArrivalIn).toBeGreaterThan(busy.nextArrivalIn);
  });

  test("the highway stop has no terrace, because nobody gets out of the car", () => {
    expect(HIGHWAY_STOP.terrace).toBeUndefined();
  });
});
