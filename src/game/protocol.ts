import { adoptPlayer, touchLayout } from "../sim/world";
import type {
  Appliance,
  Customer,
  Effect,
  Item,
  Phase,
  Player,
  PlayerInput,
  World,
} from "../sim/types";

/**
 * What goes over the wire, and nothing else.
 *
 * The server is authoritative and sends **state**, not inputs. The simulation is
 * pure but that is not the same as being *bit-identical across machines*, and
 * we have already been bitten once by floating point in `movement.ts`. Lockstep
 * would promote that class of bug from "annoying" to "two players see different
 * kitchens and neither is wrong". State sync makes divergence structurally
 * impossible; measured, it costs about 30 KB/s per player.
 *
 * Messages are JSON. At this size the debuggability is worth more than the
 * bytes — the whole dynamic frame is ~1.5 KB, and the static half is only sent
 * when it changes.
 */

export const PROTOCOL_VERSION = 1;

// --- static half: the layout, which only changes in the build phase ----------

export type LayoutAppliance = {
  id: number;
  kind: Appliance["kind"];
  x: number;
  y: number;
  source: Appliance["source"];
};

/**
 * Sent on join and whenever an appliance moves. Kept apart from the frame
 * because appliances are ~70% of the world's bytes and move a handful of times
 * a day — broadcasting them 20 times a second would be silly.
 */
export type Layout = {
  appliances: LayoutAppliance[];
};

// --- dynamic half: sent continuously -----------------------------------------

export type FramePlayer = {
  id: number;
  name: string;
  away: boolean;
  x: number;
  y: number;
  fx: number;
  fy: number;
  carried: Player["carried"];
  carriedAppliance: number | null;
  workingOn: number | null;
};

export type FrameAppliance = {
  id: number;
  item: Appliance["item"];
  progress: number;
  overcook: number;
  motion: Appliance["motion"];
  heldBy: number | null;
  justFinished: boolean;
  tip: number;
};

/**
 * Customers are pure server entities — nobody predicts them — so they travel
 * like remote chefs do: a position now, and enough state for the client to draw
 * the right pose and the right bubble.
 */
export type FrameCustomer = {
  id: number;
  state: Customer["state"];
  x: number;
  y: number;
  fx: number;
  fy: number;
  table: number | null;
  recipeId: string;
  remaining: number;
  patience: number;
  /** Seconds left in the current timed state — what empties a plate as it is eaten. */
  timer: number;
};

export type Frame = {
  tick: number;
  /**
   * The server's id counter. Carried so a client's world hands out ids from
   * where the server left off rather than from wherever `createWorld` stopped,
   * which is far behind anything the server is minting by the first customer.
   */
  nextId: number;
  phase: Phase;
  day: number;
  dayTime: number;
  dayLength: number;
  money: number;
  served: number;
  lost: number;
  customers: FrameCustomer[];
  events: World["events"];
  effects: Effect[];
  players: FramePlayer[];
  appliances: FrameAppliance[];
  /** Last input sequence the server applied, per player id. */
  acks: Record<number, number>;
};

// --- messages ----------------------------------------------------------------

export type ClientMessage =
  | { t: "hello"; version: number; room: string; name: string; players: number; token: string }
  | { t: "join"; name: string }
  | { t: "leave"; id: number }
  | { t: "input"; seq: number; inputs: Record<number, PlayerInput> }
  | { t: "menu"; action: "startDay" | "endDay" | "restartDay" }
  | { t: "reset" }
  | { t: "ping"; sent: number };

export type ServerMessage =
  /**
   * `level` is an *id*, never geometry. Both ends compile the same registry, so
   * naming a kitchen is enough for a client to build the right walls, door and
   * biome — and a server cannot get somebody's floor plan wrong. Before this,
   * the client silently assumed the one level it happened to be built with,
   * which made a second level a protocol change rather than a data addition.
   */
  | { t: "welcome"; room: string; level: string; you: number[]; layout: Layout; frame: Frame }
  | { t: "layout"; layout: Layout }
  | { t: "frame"; frame: Frame }
  | { t: "joined"; id: number }
  /**
   * `fatal` means "do not come back": a version mismatch or a full server is
   * not fixed by trying again in a second and a half. Without it the client
   * reconnected forever after a version-bumping deploy, so every tab that was
   * open when we shipped hammered the box that had just restarted.
   */
  | { t: "error"; message: string; fatal: boolean }
  | { t: "pong"; sent: number };

// --- encoding ----------------------------------------------------------------

export function encodeLayout(world: World): Layout {
  const appliances: LayoutAppliance[] = [];
  for (const appliance of world.appliances.values()) {
    appliances.push({
      id: appliance.id,
      kind: appliance.kind,
      x: appliance.tile.x,
      y: appliance.tile.y,
      source: appliance.source,
    });
  }
  return { appliances };
}

/**
 * Has the layout changed since we last looked?
 *
 * This used to build a string of every appliance and compare it, every tick,
 * for every room — 200 rooms of 30 appliances is ~360k string concatenations a
 * second to answer "no" almost every time. The layout is mutated in exactly two
 * places (`buildGrab` and `returnAppliance`), both of which bump a counter, so
 * the question is now a number comparison and the answer cannot drift from the
 * truth the way a recomputed signature can.
 */
export function layoutVersion(world: World): number {
  return world.layoutVersion;
}

export function encodeFrame(world: World, acks: Map<number, number>): Frame {
  return {
    tick: world.tick,
    nextId: world.nextId,
    phase: world.phase,
    day: world.day,
    dayTime: world.dayTime,
    dayLength: world.dayLength,
    money: world.money,
    served: world.served,
    lost: world.lost,
    customers: world.customers.map((customer) => ({
      id: customer.id,
      state: customer.state,
      x: customer.pos.x,
      y: customer.pos.y,
      fx: customer.facing.x,
      fy: customer.facing.y,
      table: customer.table,
      recipeId: customer.recipeId,
      remaining: customer.remaining,
      patience: customer.patience,
      timer: customer.timer,
    })),
    events: world.events,
    effects: world.effects,
    players: world.players.map((player) => ({
      id: player.id,
      name: player.name,
      away: player.away,
      x: player.pos.x,
      y: player.pos.y,
      fx: player.facing.x,
      fy: player.facing.y,
      carried: player.carried,
      carriedAppliance: player.carriedAppliance,
      workingOn: player.workingOn,
    })),
    // Only appliances doing something are sent. A kitchen is mostly idle
    // counters, and repeating "still empty, still zero" twenty times a second
    // for each of them was two thirds of the frame. Anything missing from this
    // list is idle by definition, which the client applies as a default.
    appliances: [...world.appliances.values()]
      .filter(
        (appliance) =>
          appliance.item !== null ||
          appliance.progress > 0 ||
          appliance.overcook > 0 ||
          appliance.motion !== null ||
          appliance.heldBy !== null ||
          appliance.justFinished ||
          appliance.tip > 0,
      )
      .map((appliance) => ({
        id: appliance.id,
        item: appliance.item,
        progress: appliance.progress,
        overcook: appliance.overcook,
        motion: appliance.motion,
        heldBy: appliance.heldBy,
        justFinished: appliance.justFinished,
        tip: appliance.tip,
      })),
    acks: Object.fromEntries(acks),
  };
}

// --- decoding ----------------------------------------------------------------

/**
 * Rebuild the kitchen exactly as the server describes it.
 *
 * Wholesale rather than diffed: appliances change only in the build phase, a
 * kitchen holds a few dozen, and "make it identical to this list" is the one
 * approach that cannot drift.
 */
export function applyLayout(world: World, layout: Layout): void {
  world.appliances.clear();
  world.applianceAt.fill(0);
  for (const saved of layout.appliances) {
    // Bounds-checked like a save is. `restore` has always done this and the
    // wire path never did, which is an odd place to be more trusting: a save is
    // a file on our own disk and a layout is whatever came out of a socket.
    if (saved.x < 0 || saved.y < 0 || saved.x >= world.width || saved.y >= world.height) continue;
    world.appliances.set(saved.id, {
      id: saved.id,
      kind: saved.kind,
      tile: { x: saved.x, y: saved.y },
      item: null,
      progress: 0,
      overcook: 0,
      justFinished: false,
      motion: null,
      heldBy: null,
      source: saved.source,
      tip: 0,
    });
    world.applianceAt[saved.y * world.width + saved.x] = saved.id;
  }
  touchLayout(world);
}

/**
 * Copy an item out of a frame, contents and all.
 *
 * One frame is applied to **two** worlds — the one being drawn and the one
 * predicting local chefs — and the prediction world then replays up to 240
 * ticks of `interactionSystem` over it. Handing both worlds the same `Item`
 * meant a predicted grab reached into the drawn world and moved things that
 * were still, as far as the server was concerned, where they had been.
 *
 * It was survivable while items were only ever rewritten in place. It stopped
 * being survivable when a pile of plates became an item that *moves its
 * contents into another item*: one predicted grab at the plate stack took a
 * plate out of the pile everyone was looking at. This is the same rule the
 * customer and effect arrays already follow, for the same reason.
 */
function cloneItem(item: Item | null): Item | null {
  if (item === null) return null;
  return {
    id: item.id,
    base: item.base,
    processes: [...item.processes],
    contents: item.contents.map((child) => cloneItem(child)).filter((child) => child !== null),
  };
}

/**
 * Apply everything in a frame *except* player positions, which the caller
 * interpolates or predicts instead.
 */
export function applyFrame(world: World, frame: Frame): void {
  world.tick = frame.tick;
  world.nextId = frame.nextId;
  world.phase = frame.phase;
  world.day = frame.day;
  world.dayTime = frame.dayTime;
  world.dayLength = frame.dayLength;
  world.money = frame.money;
  world.served = frame.served;
  world.lost = frame.lost;
  // Copied, never aliased. One frame is applied to two worlds — the one being
  // drawn and the one predicting local chefs — and the prediction world's
  // `step()` spawns customers, logs events and queues effects. Sharing the
  // arrays let it write straight into what was being drawn: orders flashed
  // into view and vanished a frame later, worse the higher the latency,
  // because more unacknowledged input means more ticks replayed.
  world.customers = frame.customers.map((customer) => ({
    id: customer.id,
    state: customer.state,
    pos: { x: customer.x, y: customer.y },
    prevPos: { x: customer.x, y: customer.y },
    facing: { x: customer.fx, y: customer.fy },
    table: customer.table,
    seat: null,
    recipeId: customer.recipeId,
    path: [],
    timer: customer.timer,
    remaining: customer.remaining,
    patience: customer.patience,
    tip: 0,
  }));
  world.events = frame.events.map((event) => ({ ...event }));
  world.effects = frame.effects.map((effect) => ({ ...effect }));

  // Absent from the frame means idle, so everything is cleared first and the
  // busy ones are painted back on top.
  for (const appliance of world.appliances.values()) {
    appliance.item = null;
    appliance.progress = 0;
    appliance.overcook = 0;
    appliance.motion = null;
    appliance.heldBy = null;
    appliance.justFinished = false;
    appliance.tip = 0;
    world.applianceAt[appliance.tile.y * world.width + appliance.tile.x] = appliance.id;
  }
  for (const snapshot of frame.appliances) {
    const appliance = world.appliances.get(snapshot.id);
    if (!appliance) continue;
    appliance.item = cloneItem(snapshot.item);
    appliance.progress = snapshot.progress;
    appliance.overcook = snapshot.overcook;
    appliance.motion = snapshot.motion;
    appliance.heldBy = snapshot.heldBy;
    appliance.justFinished = snapshot.justFinished;
    appliance.tip = snapshot.tip;
    // A held appliance is off the grid, or it would leave a solid phantom tile.
    if (snapshot.heldBy !== null) {
      world.applianceAt[appliance.tile.y * world.width + appliance.tile.x] = 0;
    }
  }

  // Players come and go; mirror the server's roster exactly.
  const live = new Set(frame.players.map((p) => p.id));
  for (let i = world.players.length - 1; i >= 0; i--) {
    if (!live.has(world.players[i]!.id)) world.players.splice(i, 1);
  }
  for (const snapshot of frame.players) {
    let player = world.players.find((p) => p.id === snapshot.id);
    if (!player) {
      player = adoptPlayer(world, snapshot.id, snapshot.name, { x: snapshot.x, y: snapshot.y });
    }
    player.name = snapshot.name;
    player.away = snapshot.away;
    player.carried = cloneItem(snapshot.carried);
    player.carriedAppliance = snapshot.carriedAppliance;
    player.workingOn = snapshot.workingOn;
  }
}
