import type { ClientMessage, Frame, Layout, ServerMessage } from "./protocol";
import { parseLevelDef } from "../data/level";
import { levelProblems } from "../data/validate";
import { MAX_PLATES } from "../sim/plates";
import type {
  ApplianceKind,
  CustomerState,
  Item,
  Ledger,
  Motion,
  Offer,
  PlayerInput,
} from "../sim/types";

/**
 * The edge of trust.
 *
 * Everything that arrives over a socket comes through here, and nothing else
 * about either side gets to assume a shape. `JSON.parse` returns `any`, and a
 * cast to `ClientMessage` is a promise the compiler has no way to keep — it was
 * kept for exactly as long as nobody sent anything strange.
 *
 * What went wrong when it was a cast:
 *
 *   { t: "input", seq: 1, inputs: { 0: { move: { x: NaN, y: NaN } } } }
 *
 * `movementSystem` compares NaN against its deadzone, every comparison is
 * false, and the chef's position becomes NaN. `clamp` cannot recover it because
 * `NaN < min` and `NaN > max` are both false, so the chef is `{x: null, y:
 * null}` on the wire from that tick on and stays that way until the room is
 * evicted ten minutes later. One message, one chef, permanently.
 *
 * So: **parse, don't cast.** These functions take `unknown` and return either a
 * value the rest of the program can rely on completely, or `null`. There is no
 * third option and no partial credit — a message with one bad field is a
 * message we do not understand, and the honest response is to drop it.
 *
 * Dropping is genuinely safe for input, which is the only high-frequency case:
 * `Host.nextInputs` already holds a player's last input when their queue
 * starves, so a rejected packet looks exactly like a dropped one, which is to
 * say like a moment of lag.
 *
 * This module is pure and shared. The server validates what clients send; the
 * client validates what the server sends, because "the server is trustworthy"
 * is an assumption about a *deployment*, not about a socket, and a stale server
 * mid-deploy is the ordinary way it turns out to be false.
 */

// --- primitives ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A real number. Rejects NaN and both infinities — the whole point of the file. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function int(value: unknown): number | null {
  const found = num(value);
  return found !== null && Number.isInteger(found) ? found : null;
}

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

/** Booleans are read for truthiness downstream, so anything else is a bug. */
function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * An integer that is allowed to be absent: `null` for a real absence,
 * `undefined` for "present, and not an integer".
 *
 * The distinction is the whole point, and it was missing. Four sites wrote
 *
 *     const table = value.table === null ? null : int(value.table);
 *     if (table === undefined) return null;
 *
 * where `int` returns `number | null` and never `undefined` — so the guard could
 * not fire and the parser it was guarding *coerced* instead of rejecting.
 * `heldBy: "3"` parsed as `heldBy: null`, and `null` means "on the grid", so a
 * malformed frame drew a held appliance back as a solid tile players walk into.
 *
 * The comparison is legal TypeScript, which is why nothing caught it: comparing
 * a `number | null` against `undefined` is a permitted, always-false test.
 */
function optionalInt(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return int(value) ?? undefined;
}

/** A string that is allowed to be absent. `undefined` means "present, and not a string". */
function optionalStr(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined) return null;
  return str(value, max) ?? undefined;
}

function arr(value: unknown, max: number): unknown[] | null {
  return Array.isArray(value) && value.length <= max ? value : null;
}

/**
 * Map an array through a parser, failing the whole array if any element fails.
 * Partial arrays are worse than no array: half a roster is a roster that says
 * players have left.
 */
function all<T>(values: unknown[], parse: (value: unknown) => T | null): T[] | null {
  const out: T[] = [];
  for (const value of values) {
    const parsed = parse(value);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

// --- limits -------------------------------------------------------------------
//
// Sized so that legitimate traffic never comes close and a hostile client
// cannot make us allocate. The frame limits are the client's protection against
// a server that has gone wrong, so they are generous rather than tight.

const MAX_NAME = 16;
const MAX_ROOM = 32;
const MAX_TOKEN = 64;
const MAX_SEATS = 8;
const MAX_ENTITIES = 64;
const MAX_APPLIANCES = 512;
const MAX_EVENTS = 32;
const MAX_ITEM_DEPTH = 4;
const MAX_PROCESSES = 8;
/**
 * A plate holds one dish — or, since the sink, a whole pile of plates: the
 * kitchen's entire supply can be sitting on the stack as one item.
 *
 * Taken from the simulation's own ceiling rather than picked here. A pile
 * taller than this limit makes every frame containing it fail to parse, so the
 * client applies nothing at all and sits at "connecting" — the loudest possible
 * symptom of the quietest possible mismatch, which is exactly the failure the
 * note on `APPLIANCE_KINDS` below is about.
 */
const MAX_CONTENTS = MAX_PLATES;
/**
 * How many recipes a room can claim to have unlocked.
 *
 * Generous against the library rather than equal to it, because the client and
 * the server can be one deploy apart and a newer server legitimately knows more
 * dishes than we do. Unknown ids are dropped where the menu is *read* (see
 * `unlockedRecipes`), which is the right place for that: rejecting the whole
 * frame would freeze a kitchen over a recipe nobody had ordered yet.
 */
const MAX_UNLOCKED = 64;

// --- items --------------------------------------------------------------------

/**
 * Items nest (a plate holds a dish), so this is the one recursive shape on the
 * wire and the one that needs a depth limit. Without it a hand-written message
 * of ten thousand nested plates is a stack overflow in the parser itself.
 */
function parseItem(value: unknown, depth = 0): Item | null {
  if (depth > MAX_ITEM_DEPTH || !isRecord(value)) return null;

  const id = int(value.id);
  const base = str(value.base, MAX_NAME);
  if (id === null || base === null) return null;

  const rawProcesses = arr(value.processes, MAX_PROCESSES);
  if (!rawProcesses) return null;
  const processes = all(rawProcesses, (entry) => str(entry, MAX_NAME));
  if (!processes) return null;

  const rawContents = arr(value.contents, MAX_CONTENTS);
  if (!rawContents) return null;
  const contents = all(rawContents, (entry) => parseItem(entry, depth + 1));
  if (!contents) return null;

  return { id, base, processes, contents };
}

function parseNullableItem(value: unknown): Item | null | undefined {
  if (value === null) return null;
  return parseItem(value) ?? undefined;
}

// --- client -> server ----------------------------------------------------------

/**
 * One tick of input.
 *
 * `move` is clamped here as well as in `movementSystem`. That is deliberate
 * duplication: the sim's normalisation exists to make a controller and a
 * keyboard feel the same, and this exists so that no number reaching the sim is
 * ever outside its stated range. They are the same arithmetic for different
 * reasons, and the sim's copy should not be load-bearing for safety.
 */
export function parseInput(value: unknown): PlayerInput | null {
  if (!isRecord(value) || !isRecord(value.move)) return null;

  const x = num(value.move.x);
  const y = num(value.move.y);
  const grab = bool(value.grab);
  const use = bool(value.use);
  const start = bool(value.start);
  const menu = bool(value.menu);
  if (x === null || y === null) return null;
  if (grab === null || use === null || start === null || menu === null) return null;

  const magnitude = Math.hypot(x, y);
  const move = magnitude > 1 ? { x: x / magnitude, y: y / magnitude } : { x, y };
  return { move, grab, use, start, menu };
}

export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value)) return null;

  switch (value.t) {
    case "hello": {
      const version = int(value.version);
      const room = str(value.room, MAX_ROOM);
      const name = str(value.name, MAX_NAME);
      const players = int(value.players);
      const token = str(value.token, MAX_TOKEN);
      // Absent means "no opinion", which is what an older client has. Checked
      // for shape only: whether the id names a kitchen is the server's
      // question, and an unknown one falls back to the default rather than
      // refusing somebody entry over a typo.
      const level = value.level === undefined ? "" : str(value.level, MAX_NAME);
      if (version === null || room === null || name === null || level === null) return null;
      if (players === null || token === null) return null;
      if (players < 1 || players > MAX_SEATS) return null;
      return { t: "hello", version, room, name, players, token, level };
    }
    case "join": {
      const name = str(value.name, MAX_NAME);
      return name === null ? null : { t: "join", name };
    }
    case "leave": {
      const id = int(value.id);
      return id === null ? null : { t: "leave", id };
    }
    case "input": {
      const seq = int(value.seq);
      if (seq === null || !isRecord(value.inputs)) return null;
      const inputs: Record<number, PlayerInput> = {};
      const entries = Object.entries(value.inputs);
      if (entries.length > MAX_SEATS) return null;
      for (const [key, raw] of entries) {
        // Object keys are strings; a seat id that is not an integer means the
        // sender and we disagree about what a player id is.
        const id = int(Number(key));
        const input = parseInput(raw);
        if (id === null || input === null) return null;
        inputs[id] = input;
      }
      return { t: "input", seq, inputs };
    }
    case "menu": {
      const action = value.action;
      if (action !== "restartDay") return null;
      return { t: "menu", action };
    }
    case "reset":
      return { t: "reset" };
    case "ping": {
      const sent = num(value.sent);
      return sent === null ? null : { t: "ping", sent };
    }
    default:
      return null;
  }
}

// --- server -> client ----------------------------------------------------------

function parseLayout(value: unknown): Layout | null {
  if (!isRecord(value)) return null;
  const raw = arr(value.appliances, MAX_APPLIANCES);
  if (!raw) return null;

  // The menu. Bounded by the library's size rather than by a round number: a
  // list longer than every recipe there is cannot be a menu, whatever it is.
  const rawUnlocked = arr(value.unlocked, MAX_UNLOCKED);
  if (!rawUnlocked) return null;
  const unlocked = all(rawUnlocked, (entry) => str(entry, MAX_NAME));
  const unlockedDay = int(value.unlockedDay);
  if (!unlocked || unlockedDay === null || unlockedDay < 0) return null;

  const appliances = all(raw, (entry) => {
    if (!isRecord(entry)) return null;
    const id = int(entry.id);
    const kind = str(entry.kind, MAX_NAME);
    const x = int(entry.x);
    const y = int(entry.y);
    if (id === null || kind === null || x === null || y === null) return null;
    // Coordinates are bounds-checked against the actual grid in `applyLayout`;
    // here we only insist they are integers a grid could contain at all.
    if (x < 0 || y < 0) return null;
    if (!isApplianceKind(kind)) return null;
    const source =
      entry.source === null || entry.source === undefined ? null : parseSpec(entry.source);
    if (source === undefined) return null;
    const offer = parseOffer(entry.offer);
    if (offer === undefined) return null;
    const taken = optionalInt(entry.taken);
    if (taken === undefined) return null;
    const card = optionalStr(entry.card, MAX_NAME);
    if (card === undefined) return null;
    return { id, kind, x, y, source, offer, taken, card };
  });
  return appliances === null ? null : { appliances, unlocked, unlockedDay };
}

/**
 * Every appliance kind, as a `Record` rather than a `Set`.
 *
 * This is the difference between a list that has to be *remembered* and one the
 * compiler insists on. `new Set<ApplianceKind>([...])` accepts an array that
 * omits members — a literal missing an element is still assignable — so adding
 * a `sink` to `data/appliances.ts` widened the union and compiled cleanly here,
 * while every `layout` message containing a sink was silently rejected. The
 * client never applies the layout, `layoutIds` stays empty, every frame is
 * dropped, and the kitchen freezes at "connecting" with nothing logged.
 *
 * `Record<ApplianceKind, true>` is missing-property-checked, so the same change
 * is now a build error naming the key.
 */
const APPLIANCE_KINDS: Record<ApplianceKind, true> = {
  stall: true,
  cards: true,
  sign: true,
  counter: true,
  board: true,
  steel_board: true,
  fryer: true,
  oven: true,
  bell_oven: true,
  crate: true,
  plates: true,
  sink: true,
  bin: true,
  table: true,
  hatch: true,
};

function isApplianceKind(value: string): value is ApplianceKind {
  return Object.hasOwn(APPLIANCE_KINDS, value);
}

type Spec = NonNullable<Layout["appliances"][number]["source"]>;

/**
 * What a stall slot is selling. `undefined` for "present but malformed".
 *
 * The `good` tag is checked rather than trusted, because it is what decides
 * whether a purchase hands over an appliance or mints a plate — the one wire
 * field that can add crockery to a kitchen.
 */
function parseOffer(value: unknown): Offer | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return undefined;
  if (value.good === "plate") return { good: "plate" };
  if (value.good !== "appliance") return undefined;
  const kind = str(value.kind, MAX_NAME);
  if (kind === null || !isApplianceKind(kind)) return undefined;
  if (value.source === null || value.source === undefined) {
    return { good: "appliance", kind, source: null };
  }
  const source = parseSpec(value.source);
  return source === undefined ? undefined : { good: "appliance", kind, source };
}

/** Returns `undefined` for "present but malformed", distinct from a real absence. */
function parseSpec(value: unknown): Spec | undefined {
  if (!isRecord(value)) return undefined;
  const base = str(value.base, MAX_NAME);
  const raw = arr(value.processes, MAX_PROCESSES);
  if (base === null || !raw) return undefined;
  const processes = all(raw, (entry) => str(entry, MAX_NAME));
  return processes === null ? undefined : { base, processes };
}

/** Exhaustive by type — see the note on `APPLIANCE_KINDS`. */
const CUSTOMER_STATES: Record<CustomerState, true> = {
  arriving: true,
  waiting: true,
  deciding: true,
  ordering: true,
  eating: true,
  leaving: true,
};

function isCustomerState(value: string): value is CustomerState {
  return Object.hasOwn(CUSTOMER_STATES, value);
}

function parseFrame(value: unknown): Frame | null {
  if (!isRecord(value)) return null;

  const tick = int(value.tick);
  const nextId = int(value.nextId);
  const day = int(value.day);
  const dayTime = num(value.dayTime);
  const dayLength = num(value.dayLength);
  const money = num(value.money);
  const served = int(value.served);
  const lost = int(value.lost);
  if (tick === null || nextId === null || day === null || dayTime === null) return null;
  if (dayLength === null) return null;
  if (money === null || served === null || lost === null) return null;
  if (value.phase !== "service" && value.phase !== "build") return null;

  const today = parseLedger(value.today);
  if (!today) return null;

  const rawCustomers = arr(value.customers, MAX_ENTITIES);
  const rawPlayers = arr(value.players, MAX_ENTITIES);
  const rawAppliances = arr(value.appliances, MAX_APPLIANCES);
  const rawEvents = arr(value.events, MAX_EVENTS);
  const rawEffects = arr(value.effects, MAX_EVENTS);
  if (!rawCustomers || !rawPlayers || !rawAppliances || !rawEvents || !rawEffects) return null;

  const customers = all(rawCustomers, parseFrameCustomer);
  const players = all(rawPlayers, parseFramePlayer);
  const appliances = all(rawAppliances, parseFrameAppliance);
  const events = all(rawEvents, parseEvent);
  const effects = all(rawEffects, parseEffect);
  if (!customers || !players || !appliances || !events || !effects) return null;

  if (!isRecord(value.acks)) return null;
  const acks: Record<number, number> = {};
  for (const [key, raw] of Object.entries(value.acks)) {
    const id = int(Number(key));
    const seq = int(raw);
    if (id === null || seq === null) return null;
    acks[id] = seq;
  }

  return {
    tick,
    nextId,
    phase: value.phase,
    day,
    dayTime,
    dayLength,
    money,
    served,
    lost,
    today,
    customers,
    events,
    effects,
    players,
    appliances,
    acks,
  };
}

/** One day's takings. The `lost` map is keyed by recipe id, so it is bounded. */
function parseLedger(value: unknown): Ledger | null {
  if (!isRecord(value)) return null;
  const day = int(value.day);
  const earned = num(value.earned);
  const tips = num(value.tips);
  const served = int(value.served);
  if (day === null || earned === null || tips === null || served === null) return null;
  if (!isRecord(value.lost)) return null;

  const entries = Object.entries(value.lost);
  if (entries.length > MAX_EVENTS) return null;
  const lost: Record<string, number> = {};
  for (const [key, raw] of entries) {
    const count = int(raw);
    if (key.length > MAX_NAME || count === null) return null;
    lost[key] = count;
  }
  return { day, earned, tips, served, lost };
}

function parseFrameCustomer(value: unknown): Frame["customers"][number] | null {
  if (!isRecord(value)) return null;
  const id = int(value.id);
  const x = num(value.x);
  const y = num(value.y);
  const fx = num(value.fx);
  const fy = num(value.fy);
  const recipeId = str(value.recipeId, MAX_NAME);
  // Checked for shape, not for membership. A newer server may know a kind this
  // client does not, and `customerKind` resolves an unknown id to the default
  // where it is read — rejecting the frame would freeze the whole kitchen over
  // somebody's coat colour.
  const kind = str(value.kind, MAX_NAME);
  const remaining = num(value.remaining);
  const patience = num(value.patience);
  const timer = num(value.timer);
  const state = str(value.state, MAX_NAME);
  if (id === null || x === null || y === null || fx === null || fy === null) return null;
  if (recipeId === null || remaining === null || patience === null || timer === null) return null;
  if (kind === null || state === null || !isCustomerState(state)) return null;
  const table = optionalInt(value.table);
  if (table === undefined) return null;
  // Their dinner, off the table and in front of them. Parsed like any other
  // item, because it is one: it is a plate the kitchen is still responsible for.
  const plate = parseNullableItem(value.plate);
  if (plate === undefined) return null;
  return { id, state, x, y, fx, fy, table, plate, recipeId, kind, remaining, patience, timer };
}

function parseFramePlayer(value: unknown): Frame["players"][number] | null {
  if (!isRecord(value)) return null;
  const id = int(value.id);
  const name = str(value.name, MAX_NAME);
  const away = bool(value.away);
  const x = num(value.x);
  const y = num(value.y);
  const fx = num(value.fx);
  const fy = num(value.fy);
  if (id === null || name === null || away === null) return null;
  if (x === null || y === null || fx === null || fy === null) return null;

  const carried = parseNullableItem(value.carried);
  if (carried === undefined) return null;
  const carriedAppliance = optionalInt(value.carriedAppliance);
  const workingOn = optionalInt(value.workingOn);
  if (carriedAppliance === undefined || workingOn === undefined) return null;

  return { id, name, away, x, y, fx, fy, carried, carriedAppliance, workingOn };
}

function parseFrameAppliance(value: unknown): Frame["appliances"][number] | null {
  if (!isRecord(value)) return null;
  const id = int(value.id);
  const progress = num(value.progress);
  const overcook = num(value.overcook);
  const justFinished = bool(value.justFinished);
  const tip = num(value.tip);
  if (id === null || progress === null || overcook === null) return null;
  if (justFinished === null || tip === null) return null;

  const item = parseNullableItem(value.item);
  if (item === undefined) return null;
  const heldBy = optionalInt(value.heldBy);
  const armedBy = optionalInt(value.armedBy);
  if (heldBy === undefined || armedBy === undefined) return null;

  const motion = value.motion === null ? null : parseMotion(value.motion);
  if (motion === undefined) return null;

  return { id, item, progress, overcook, motion, heldBy, justFinished, tip, armedBy };
}

/** Exhaustive by type — see the note on `APPLIANCE_KINDS`. */
const MOTIONS: Record<Motion, true> = {
  chop: true,
  knead: true,
  mix: true,
  scrub: true,
  fry: true,
  bake: true,
};

function isMotion(value: string): value is Motion {
  return Object.hasOwn(MOTIONS, value);
}

function parseMotion(value: unknown): Motion | undefined {
  return typeof value === "string" && isMotion(value) ? value : undefined;
}

function parseEvent(value: unknown): Frame["events"][number] | null {
  if (!isRecord(value)) return null;
  const text = str(value.text, 200);
  const ttl = num(value.ttl);
  return text === null || ttl === null ? null : { text, ttl };
}

function parseEffect(value: unknown): Frame["effects"][number] | null {
  if (!isRecord(value)) return null;
  const id = int(value.id);
  const ttl = num(value.ttl);
  if (id === null || ttl === null) return null;

  switch (value.kind) {
    case "served":
    case "tipped": {
      const playerId = int(value.playerId);
      const amount = num(value.amount);
      if (playerId === null || amount === null) return null;
      return { kind: value.kind, playerId, amount, id, ttl };
    }
    case "paid": {
      const tile = parseTile(value.tile);
      const amount = num(value.amount);
      if (!tile || amount === null) return null;
      return { kind: "paid", tile, amount, id, ttl };
    }
    case "binned":
    case "walkout":
    case "refused": {
      const tile = parseTile(value.tile);
      return tile ? { kind: value.kind, tile, id, ttl } : null;
    }
    case "spent": {
      const tile = parseTile(value.tile);
      const amount = num(value.amount);
      if (!tile || amount === null) return null;
      return { kind: "spent", tile, amount, id, ttl };
    }
    default:
      return null;
  }
}

function parseTile(value: unknown): { x: number; y: number } | null {
  if (!isRecord(value)) return null;
  const x = num(value.x);
  const y = num(value.y);
  return x === null || y === null ? null : { x, y };
}

export function parseServerMessage(value: unknown): ServerMessage | null {
  if (!isRecord(value)) return null;

  switch (value.t) {
    case "welcome": {
      const room = str(value.room, MAX_ROOM);
      // Structure first, then whether it is a kitchen anybody could cook in.
      // A server sending a building with no door is a server we cannot play
      // against, and finding that out here beats finding it out as a customer
      // who can never arrive.
      const level = parseLevelDef(value.level);
      const rawYou = arr(value.you, MAX_SEATS);
      if (room === null || level === null || !rawYou) return null;
      if (levelProblems(level).length > 0) return null;
      const you = all(rawYou, int);
      const layout = parseLayout(value.layout);
      const frame = parseFrame(value.frame);
      if (!you || !layout || !frame) return null;
      return { t: "welcome", room, level, you, layout, frame };
    }
    case "layout": {
      const layout = parseLayout(value.layout);
      return layout ? { t: "layout", layout } : null;
    }
    case "frame": {
      const frame = parseFrame(value.frame);
      return frame ? { t: "frame", frame } : null;
    }
    case "joined": {
      const id = int(value.id);
      return id === null ? null : { t: "joined", id };
    }
    case "error": {
      const message = str(value.message, 200);
      const fatal = value.fatal === undefined ? false : bool(value.fatal);
      if (message === null || fatal === null) return null;
      return { t: "error", message, fatal };
    }
    case "pong": {
      const sent = num(value.sent);
      return sent === null ? null : { t: "pong", sent };
    }
    default:
      return null;
  }
}

/**
 * Decode a socket payload. Anything that is not a JSON object we recognise —
 * a truncated frame, a binary message, a stale protocol — is `null`.
 */
export function decode<T>(raw: unknown, parse: (value: unknown) => T | null): T | null {
  if (typeof raw !== "string") return null;
  try {
    return parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
