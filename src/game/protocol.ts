import { adoptPlayer, touchLayout } from "../sim/world";
import type { LevelDef } from "../data/level";
import type { MenuAction } from "./host";
import type {
  Appliance,
  Customer,
  Effect,
  Item,
  Ledger,
  Phase,
  Player,
  PlayerInput,
  RunRecord,
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
 * impossible.
 *
 * Messages are JSON, and at this size the debuggability is worth more than the
 * bytes: a frame is ~900 bytes for a kitchen with one chef in it and ~1.3 KB
 * with four, and the static half is only sent when it changes. The cost **per
 * player** rises with the number of players, because everybody is sent the
 * whole world and the other chefs are part of it.
 *
 * The figures live in `latency.test.ts`, which prints them, rather than in this
 * comment — the last two numbers here and in `docs/multiplayer.md` were each
 * measured once under conditions neither recorded, and spent months disagreeing
 * by a factor of two.
 */

/**
 * Bumped whenever a message shape changes in a way an older peer cannot read.
 *
 * v2 added the menu to the layout — which recipes a room has unlocked, and the
 * card on offer. A v1 server sends layouts without it, and a v2 client
 * rejects those wholesale (see `parseLayout`), so it would sit at "connecting"
 * with nothing logged. The version check turns that into the one sentence it
 * should be: refresh the page.
 *
 * v3 added `kind` to a customer. Note which direction that breaks: an unknown
 * kind *id* is tolerated on purpose, because content moves faster than
 * protocols — but a missing field is a v2 server, and `parseFrameCustomer`
 * rejects the frame it is missing from, which is every frame with anybody in
 * the dining room.
 *
 * v4 sends the kitchen itself in `welcome` rather than its id. See the note
 * there: the id stopped being enough the moment a level could be generated.
 *
 * v5 added two things that stop a kitchen from being drawable without them: a
 * counter's `topper`, which is where chopping boards live now, and the frame's
 * `pausedBy`, which is the whole room standing still. A v4 server sends neither,
 * so a v5 client would draw bare counters that chop fast and would never pause.
 *
 * v6 dressed the chefs: a player carries the outfit and hat they chose. It
 * breaks the way v3's customer `kind` does — unknown *ids* are tolerated,
 * because a wardrobe grows faster than a protocol, but a v5 server sends no
 * outfit at all and a room full of chefs in the same colour is precisely what
 * the field exists to prevent.
 *
 * v7 put the weather in the layout, and it breaks for a harder reason than a
 * colour. An unknown weather id is tolerated and reads as a fair day; a v6
 * server sending none at all means every client believes the terrace is open
 * while the server has shut it, so the tables outside are chairs one end of the
 * link can see people being seated at and the other cannot.
 *
 * v8 pointed the conveyors. A missing `dir` is survivable on its own — it reads
 * as a belt running north, which is wrong rather than unparseable — but the
 * `belt` *kind* is not: a v7 client rejects an appliance kind it has never
 * heard of, which throws away the whole layout and every frame after it, and
 * the room sits at "connecting" with nothing logged. See the note on
 * `APPLIANCE_KINDS` in `wire.ts`.
 *
 * v9 added the hopper, and breaks for exactly the reason v8 did: a new
 * appliance kind is the one content change a client cannot shrug off, because
 * an unknown kind fails the whole layout rather than one appliance in it. It
 * needed no new field — a hopper is a `dir` and nothing else, since what it
 * hands out belongs to the crate standing behind it.
 */
export const PROTOCOL_VERSION = 9;

/**
 * Ticks between broadcasts: a 60Hz simulation goes out at 20Hz.
 *
 * Here rather than in the server because it is a property of the *stream*, not
 * of the process producing it: the client's playout delay is sized against it,
 * and the measured cost of an action includes waiting for the next one. A test
 * that measures latency has to be measuring the rate we actually ship.
 */
export const SEND_EVERY = 3;

// --- static half: the layout, which only changes in the build phase ----------

export type LayoutAppliance = {
  id: number;
  kind: Appliance["kind"];
  x: number;
  y: number;
  source: Appliance["source"];
  /**
   * Which way a conveyor carries, or a hopper faces.
   *
   * In the layout rather than the frame because it is exactly what the layout
   * is for: it is decided when somebody sets the machine down and never changes
   * again during service. It is also load-bearing rather than decorative — a
   * client with it wrong draws a run of belts feeding the wrong way and then
   * watches items travel against them.
   */
  dir: Appliance["dir"];
  /**
   * What a stall slot is holding, and whether it has already been emptied.
   *
   * The shop rides the *layout* rather than the frame because it is the same
   * kind of fact: rare, structural, and about where things are. A slot changes
   * three times a morning and not at all during service, so paying for it
   * twenty times a second would be as silly as it would be for a counter.
   *
   * Sent rather than recomputed, even though every client could roll the same
   * stock from the seed and the day. What is *left* in the slots is not
   * derivable — it depends on what somebody bought — and a shop that is
   * half-derived and half-synced is a shop where "my friend sees a different
   * stall" is one missed field away.
   */
  offer: Appliance["offer"];
  taken: number | null;
  /**
   * The fitting on this appliance's worktop — a chopping board, in practice.
   *
   * Rides the layout rather than the frame because it is exactly the sort of
   * fact the layout is for: it changes a handful of times a morning, never
   * during service, and it is about where things are. It is also load-bearing
   * rather than decorative — a client that had it wrong would draw a bare
   * counter and show the wrong dial speed on it.
   */
  topper: Appliance["topper"];
  /**
   * The dish on a recipe card somebody is carrying.
   *
   * A card standing in the delivery travels as its square's `offer`, like the
   * oven beside it. This is the other half of its short life: once bought, it
   * is an appliance in somebody's hands until they set it down, and a client
   * that did not know which dish was on it would draw a blank card.
   */
  card: string | null;
};

/**
 * Sent on join and whenever an appliance moves. Kept apart from the frame
 * because appliances are ~70% of the world's bytes and move a handful of times
 * a day — broadcasting them 20 times a second would be silly.
 */
export type Layout = {
  appliances: LayoutAppliance[];
  /**
   * The recipes this room has unlocked, oldest first, and the day the newest
   * one arrived.
   *
   * Not appliances, and here anyway: the layout is the *structural* half of the
   * world — the things that change a handful of times a day and never during
   * service — and a menu is exactly that. Putting it in the frame would spend
   * twenty messages a second on a list that changes every third morning.
   *
   * It is what customers order from, so a client that had it wrong would draw
   * order bubbles for dishes this kitchen cannot make. `unlockRecipe` bumps the
   * layout version even when it delivers nothing, so it cannot be missed.
   */
  unlocked: string[];
  unlockedDay: number;
  /**
   * What sort of day it is, by id from `data/weather.ts`.
   *
   * In the layout for the same reason the menu is: it changes once, in the
   * morning, and never during service. Sent rather than derived even though
   * every client could roll it from the seed and the day — see `sim/weather.ts`
   * for why. It is load-bearing rather than decorative: it decides whether the
   * tables out on the terrace can be sat at, so a client that had it wrong
   * would watch customers walk past chairs it believes are free.
   */
  weather: string;
  /**
   * Which life of this kitchen this is, what it has taken, and the best one the
   * room has had.
   *
   * Structural by the layout's own test: the run number changes when somebody
   * resets, the record changes when they do it having beaten one, and the
   * takings change once a day at closing time. None of that is twenty times a
   * second.
   *
   * Sent rather than derived because no client can work it out: a record is the
   * one thing in the world that outlives the run being played, and it comes off
   * the server's disk. A client without it draws a closed-down card with
   * nothing on it to try again *for*.
   */
  run: number;
  takings: number;
  best: RunRecord | null;
};

// --- dynamic half: sent continuously -----------------------------------------

export type FramePlayer = {
  id: number;
  name: string;
  away: boolean;
  /**
   * What they are wearing, by id from `data/chefs.ts`.
   *
   * In the frame with the name rather than in the layout, because it belongs to
   * a *player*, and the roster is the one part of the frame that is not about
   * this instant. Sent rather than derived for the same reason the customer's
   * kind is: the outfit was settled where the players are, and no client can
   * work out on its own which colour was still free at the moment somebody
   * walked in.
   */
  outfit: string;
  hat: string;
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
  /**
   * Which sort of person this is, by id from `data/customers.ts`.
   *
   * Sent rather than derived: it is drawn from the room's live RNG stream at
   * the door, so no client can roll the same answer. One short string per
   * customer, and it decides a coat, a build and a walking speed — all three of
   * which have to match on every screen or two players are looking at different
   * people.
   */
  kind: string;
  remaining: number;
  patience: number;
  /** Seconds left in the current timed state — what empties a plate as it is eaten. */
  timer: number;
  /**
   * The plate they took off the table when their dinner arrived, if they are
   * eating.
   *
   * Sent because it is *drawn* — a diner's plate sits in front of their chair,
   * and a client that could not see it would show a party eating off bare wood
   * while the table stood empty. It also has to exist on both ends for the same
   * reason the appliances' items do: it is crockery the kitchen still owns.
   */
  plate: Item | null;
};

export type Frame = {
  tick: number;
  /**
   * Who has the room paused, and what they are called.
   *
   * In the frame rather than the layout because it is a thing that *happens*,
   * to everybody, several times a session — and because the moment it changes
   * is the moment every screen has to know. The name travels with it so that a
   * paused room can say whose menu it is waiting on without every client
   * keeping its own roster of who is called what.
   */
  pausedBy: number | null;
  pausedName: string;
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
  /** The run is over: the rent went unpaid twice. See `chargeRent`. */
  evicted: boolean;
  /** The day's own takings, for the end-of-day card. */
  today: Ledger;
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
  | {
      t: "hello";
      version: number;
      room: string;
      name: string;
      players: number;
      token: string;
      /**
       * How this browser's chefs would like to be dressed.
       *
       * A preference, like `level` below: the room may already have somebody in
       * blue, and the seats behind one `hello` all ask for the same thing.
       */
      outfit: string;
      hat: string;
      /**
       * Which kitchen to build if this room does not exist yet.
       *
       * A *preference*, not an instruction: a room that has been played keeps
       * the level in its save, and the first person through the door is the
       * only one whose choice can matter. Deliberately tolerated when missing
       * rather than versioned — an older client simply has no opinion, and gets
       * whatever the room already is.
       */
      level: string;
    }
  | { t: "join"; name: string; outfit: string; hat: string }
  | { t: "leave"; id: number }
  | { t: "input"; seq: number; inputs: Record<number, PlayerInput> }
  /**
   * Opening and closing used to be menu actions on the wire. They are the sign
   * by the door now, which arrives as an ordinary `input` — a grab, aimed at a
   * tile — so the protocol has one fewer way to say the same thing.
   */
  | { t: "menu"; action: MenuAction }
  | { t: "reset" }
  | { t: "ping"; sent: number };

export type ServerMessage =
  /**
   * `level` is the **kitchen itself**, not its id.
   *
   * It was an id, and the argument for that was a good one: both ends compile
   * the same registry, so naming a kitchen is enough to build the right walls,
   * and a server cannot get somebody's floor plan wrong. But that argument
   * rests on the client already holding an independently correct copy — the id
   * is a pointer into two identical registries, and any drift between them is a
   * reviewed source edit with `-3` on the end of it.
   *
   * A [generated kitchen](../data/generate.ts) inverts that. There is no copy to
   * point at, so the id stops pinning the geometry and the *bundle* pins it
   * instead: a client on yesterday's deploy and a server on today's would build
   * different walls from the same id, silently, with no message shape changed to
   * notice it. That is precisely the failure the id was chosen to prevent.
   *
   * So the room's geometry is one fact, held by whoever is running the room, and
   * sent once at the door. It costs a few KB on a connection that then carries
   * ~900 bytes twenty times a second — about two frames, paid once — and it buys
   * a generator that can be retuned without a migration story, because no
   * existing room ever asks the code what its building looked like.
   *
   * Parsed like everything else that arrives over a socket, and then run past
   * `levelProblems`: see `game/wire.ts`.
   */
  | { t: "welcome"; room: string; level: LevelDef; you: number[]; layout: Layout; frame: Frame }
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
      dir: appliance.dir,
      source: appliance.source,
      offer: appliance.offer,
      taken: appliance.taken,
      topper: appliance.topper,
      card: appliance.card,
    });
  }
  return {
    appliances,
    unlocked: [...world.unlocked],
    unlockedDay: world.unlockedDay,
    weather: world.weather,
    run: world.run,
    takings: world.takings,
    best: world.best,
  };
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
    pausedBy: world.pausedBy,
    pausedName: world.pausedName,
    nextId: world.nextId,
    phase: world.phase,
    day: world.day,
    dayTime: world.dayTime,
    dayLength: world.dayLength,
    money: world.money,
    served: world.served,
    lost: world.lost,
    evicted: world.evicted,
    today: world.today,
    customers: world.customers.map((customer) => ({
      id: customer.id,
      state: customer.state,
      x: customer.pos.x,
      y: customer.pos.y,
      fx: customer.facing.x,
      fy: customer.facing.y,
      table: customer.table,
      recipeId: customer.recipeId,
      kind: customer.kind,
      remaining: customer.remaining,
      patience: customer.patience,
      timer: customer.timer,
      plate: customer.plate,
    })),
    events: world.events,
    effects: world.effects,
    players: world.players.map((player) => ({
      id: player.id,
      name: player.name,
      away: player.away,
      outfit: player.outfit,
      hat: player.hat,
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
  world.unlocked = [...layout.unlocked];
  world.unlockedDay = layout.unlockedDay;
  world.weather = layout.weather;
  world.run = layout.run;
  world.takings = layout.takings;
  world.best = layout.best;
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
      dir: { x: saved.dir.x, y: saved.dir.y },
      source: saved.source,
      offer: saved.offer,
      taken: saved.taken,
      topper: saved.topper,
      card: saved.card,
      tip: 0,
    });
    world.applianceAt[saved.y * world.width + saved.x] = saved.id;
  }
  touchLayout(world);
}

/**
 * Copy an item out of a frame, contents and all.
 *
 * A frame **outlives being applied**: it stays in the playout timeline for a
 * couple of seconds so remote chefs have something to interpolate between, and
 * the world it was applied to then replays up to 240 ticks of
 * `interactionSystem` over itself. Handing both the same `Item` means a
 * predicted grab reaching backwards into the record of what the server said.
 *
 * It was survivable while items were only ever rewritten in place. It stopped
 * being survivable when a pile of plates became an item that *moves its
 * contents into another item*: one predicted grab at the plate stack took a
 * plate out of the pile everyone was looking at. This is the same rule the
 * customer and effect arrays already follow, for the same reason — and it is
 * the reason `applyFrame` may be handed the same frame twice with no harm.
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
  world.pausedBy = frame.pausedBy;
  world.pausedName = frame.pausedName;
  world.nextId = frame.nextId;
  world.phase = frame.phase;
  world.day = frame.day;
  world.dayTime = frame.dayTime;
  world.dayLength = frame.dayLength;
  world.money = frame.money;
  world.served = frame.served;
  world.lost = frame.lost;
  world.evicted = frame.evicted;
  // Copied like the arrays below, and for the same reason: a frame is kept
  // after it is applied, and the world it was applied to is replayed over.
  world.today = { ...frame.today, lost: { ...frame.today.lost } };
  // Copied, never aliased — see `cloneItem`. The world this is applied to
  // predicts on top of it and the frame stays in the playout timeline, so a
  // shared array is a prediction writing into the record of what the server
  // said. Orders flashed into view and vanished a frame later, worse the higher
  // the latency, because more unacknowledged input means more ticks replayed.
  world.customers = frame.customers.map((customer) => ({
    id: customer.id,
    state: customer.state,
    pos: { x: customer.x, y: customer.y },
    prevPos: { x: customer.x, y: customer.y },
    facing: { x: customer.fx, y: customer.fy },
    table: customer.table,
    seat: null,
    // Nobody predicts customers, so the two fields only the dining room's own
    // rules read never travel: which group they walked in with, and which chair
    // they took. A client draws them where the server says they are.
    party: 0,
    plate: customer.plate === null ? null : cloneItem(customer.plate),
    recipeId: customer.recipeId,
    kind: customer.kind,
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
      player = adoptPlayer(
        world,
        snapshot.id,
        snapshot.name,
        { x: snapshot.x, y: snapshot.y },
        { outfit: snapshot.outfit, hat: snapshot.hat },
      );
    }
    player.name = snapshot.name;
    player.outfit = snapshot.outfit;
    player.hat = snapshot.hat;
    player.away = snapshot.away;
    player.carried = cloneItem(snapshot.carried);
    player.carriedAppliance = snapshot.carriedAppliance;
    player.workingOn = snapshot.workingOn;
  }
}
