import type { ServerWebSocket } from "bun";
import { DT } from "../src/sim/step";
import { Host } from "../src/game/host";
import { DEFAULT_LEVEL_ID, levelById } from "../src/data/level";
import {
  PROTOCOL_VERSION,
  SEND_EVERY,
  encodeFrame,
  encodeLayout,
  layoutVersion,
  type ServerMessage,
} from "../src/game/protocol";
import { decode, parseClientMessage } from "../src/game/wire";
import { saveSignature, snapshot } from "../src/save";
import type { World } from "../src/sim/types";
import { loadSave, saveKitchen } from "./store";

/**
 * The kitchen server.
 *
 * One process, one `Bun.serve`: static files and the game socket together, so
 * deploying is copying a directory and running one command. Each room owns a
 * `Host` — the same class the browser runs offline, so there is exactly one
 * implementation of the rules.
 *
 * The simulation runs at a fixed 60Hz and broadcasts at 20Hz. Clients hold a
 * short playout buffer and interpolate, so they never see the gap.
 *
 * **Scale, stated so it is a decision rather than a surprise:** rooms live in a
 * module-level `Map` and saves are local files, so this is one process on one
 * box, capped at `MAX_ROOMS`. A second instance would need room-to-node routing
 * and shared storage, and neither is worth building before the first box is
 * busy. `/health` reports the numbers that would tell us it is.
 */

const PORT = Number(process.env.PORT ?? 5273);
const TICK_MS = DT * 1000;

/**
 * How soon after the last frame an *early* one may go out.
 *
 * A frame is normally due every `SEND_EVERY` ticks, but a player pressing
 * something is worth telling the room about now rather than up to 50ms from
 * now — so a press brings the next frame forward instead of adding one, and
 * the clock restarts from there. This is the floor that stops somebody mashing
 * a button from turning into 60 broadcasts a second: at two ticks, the worst
 * case is half again the ordinary rate, and a press still waits at most one
 * tick to be seen.
 *
 * Frames therefore arrive unevenly, which is only safe because the client
 * plays them back on the *server's* clock — every frame says which tick it is.
 * Sizing its buffer from arrival times, as it once did, would have read every
 * press in the kitchen as a jittery link and grown the buffer for everyone.
 */
const EARLY_AFTER = 2;

const EMPTY_ROOM_TTL = 10 * 60 * 1000;
const MAX_PLAYERS_PER_ROOM = 8;
const MAX_PER_CONNECTION = 4;
const MAX_ROOMS = 200;

/** Longest message we will even try to parse. A tick of input is ~300 bytes. */
const MAX_MESSAGE_BYTES = 8 * 1024;

/**
 * How long a disconnected player's chef is held before it is cleared away.
 *
 * Long enough to survive a wifi blip or a tunnel — losing a half-built pizza to
 * two seconds of bad signal is exactly the kind of thing that makes people stop
 * playing — and short enough that a genuinely departed player is not left
 * standing in the kitchen blocking a doorway.
 */
const RECLAIM_GRACE = 25_000;

/**
 * Per-connection message budget: a steady rate plus a burst.
 *
 * A client sends at most one input per tick (60/s) plus a ping every two
 * seconds, so 90/s of headroom is generous for anything honest. What it stops
 * is the expensive verbs: `reset` rebuilds a world, broadcasts a layout and
 * writes to disk, and one connection sending it in a loop could saturate the
 * shared 60Hz interval for *every other room in the process*.
 */
const RATE_PER_SECOND = 90;
const RATE_BURST = 180;

/**
 * How much unsent data a client may accumulate before we stop sending frames.
 *
 * A state-sync frame is worthless once stale, so a client that cannot keep up
 * should be skipped rather than queued at — queuing is how one bad connection
 * turns into unbounded memory in the server. `layout` and `welcome` are never
 * skipped: those are structural, and missing one desynchronises the client
 * permanently rather than briefly.
 */
const MAX_BUFFERED_BYTES = 512 * 1024;
const DROP_CLIENT_BYTES = 4 * 1024 * 1024;

type SocketData = { client: Client | null; tokens: number; lastRefill: number };
type Socket = ServerWebSocket<SocketData>;

type Client = {
  id: string;
  room: string;
  players: number[];
  name: string;
  token: string;
  socket: Socket;
  /** Frames skipped because the socket was backed up, for /health. */
  dropped: number;
};

type Room = {
  code: string;
  host: Host;
  clients: Set<Client>;
  /** Ticks since the last frame went out. */
  sinceFrame: number;
  layout: number;
  /** Last phase seen, so a day boundary can trigger a checkpoint. */
  phase: World["phase"];
  emptySince: number | null;
  /**
   * Signature of the state we consider already persisted — either what was
   * loaded from disk, or the pristine default, which needs no file. Anything
   * else means there is something worth writing.
   */
  saved: string;
  /**
   * Whether we are allowed to write this room at all.
   *
   * False when the file on disk was something we could not read: it has been
   * quarantined, but a room that starts from a rejected save must not then
   * overwrite the real one if the quarantine rename also failed.
   */
  writable: boolean;
  /** Seats being held for players who dropped, by browser token. */
  vacant: Map<string, { ids: number[]; expires: number }>;
  /** Ticks the room could not keep up with, for /health. */
  behind: number;
};

const rooms = new Map<string, Room>();

/**
 * Rooms are created on demand: the first person to use a code makes it.
 *
 * Returns null when the server is already holding as many kitchens as it will.
 * Any of 36^8 codes mints a room, so without a cap a bored visitor could fill
 * memory (and, if untouched rooms were saved, the disk) by connecting in a
 * loop.
 */
function roomFor(
  code: string,
  loaded: Awaited<ReturnType<typeof loadSave>>,
  wanted = "",
): Room | null {
  const existing = rooms.get(code);
  if (existing) return existing;
  if (rooms.size >= MAX_ROOMS && !evictColdestRoom()) return null;

  // A room that has been played already **is** a kitchen, and its save says
  // which one. Only a room being made for the first time can honour what the
  // person at the door asked for — otherwise joining a friend with the wrong
  // thing selected would rebuild their restaurant as a different level, which
  // `restore` would then refuse as stale and quietly reset.
  const id = loaded.save?.level || wanted;
  const level = (id ? levelById(id) : null) ?? levelById(DEFAULT_LEVEL_ID);
  if (!level) throw new Error(`missing default level ${DEFAULT_LEVEL_ID}`);
  const host = new Host(loaded.save, level);

  // A save we could not *understand* is not a save we may overwrite. `loadSave`
  // has already moved the file aside; if that failed too, leaving it alone is
  // the only way the player's kitchen survives long enough to be looked at.
  //
  // "Stale" is a different answer from "unreadable", and it used to get the
  // same one. A save whose level no longer exists — which is what a level id
  // bump makes every save in the world — describes coordinates that have
  // stopped meaning anything, and there is nothing to preserve. Treating it as
  // a quarantine would have left every existing room permanently unable to save
  // again, silently, for as long as it was played.
  const reason = host.restored?.ok === false ? host.restored.reason : null;
  const unreadable = reason === "schema";
  if (reason) console.warn("[cookd] room", code, "ignored its save:", reason);

  const room: Room = {
    code,
    host,
    clients: new Set(),
    sinceFrame: 0,
    layout: layoutVersion(host.world),
    phase: host.world.phase,
    emptySince: monotonic(),
    saved: saveSignature(host.world),
    writable: !loaded.corrupt && !unreadable,
    vacant: new Map(),
    behind: 0,
  };
  rooms.set(code, room);
  return room;
}

/**
 * Make room for a new kitchen by dropping the one that has been empty longest.
 *
 * At the cap the server used to refuse new players outright, even when most of
 * its rooms were empty-but-warm. Degrading is better than failing: an empty
 * room's only value is that someone might come back to it, and the person
 * asking right now definitely wants one.
 */
function evictColdestRoom(): boolean {
  let coldest: Room | null = null;
  for (const room of rooms.values()) {
    if (room.clients.size > 0 || room.emptySince === null) continue;
    if (!coldest || room.emptySince < (coldest.emptySince ?? Infinity)) coldest = room;
  }
  if (!coldest) return false;
  persist(coldest);
  rooms.delete(coldest.code);
  return true;
}

/**
 * Write the room if, and only if, it differs from what is on disk.
 *
 * `room.saved` only advances once the write has actually landed. It used to be
 * set first, which meant a failed write left the server certain the kitchen was
 * safe — no retry, no complaint, and the layout gone at the next eviction.
 */
function persist(room: Room): void {
  void persisted(room);
}

/** The same write, awaitable — for shutdown, which has to know when it landed. */
function persisted(room: Room): Promise<void> {
  if (!room.writable) return Promise.resolve();
  const signature = saveSignature(room.host.world);
  if (signature === room.saved) return Promise.resolve();
  return writeThrough(room, signature);
}

/**
 * `room.saved` advances only once the bytes are down. Doing it the other way
 * round — mark clean, then write — meant a failed write left the server certain
 * the kitchen was safe: no retry, no complaint, and the layout gone at the next
 * eviction. Now a failure simply leaves the room dirty, and the next tick that
 * notices a change tries again.
 */
async function writeThrough(room: Room, signature: string): Promise<void> {
  const ok = await saveKitchen(room.code, snapshot(room.host.world, room.host.level.id));
  if (ok) room.saved = signature;
}

/**
 * A room code, or null if it is not one.
 *
 * This used to strip and *truncate*, which quietly merged strangers: both
 * `MY-KITCHEN-A` and `MYKITCHENB` became `MYKITCHE`, so two groups who thought
 * they had picked different codes ended up cooking in the same kitchen.
 * Refusing an over-long code is friendlier than silently reinterpreting it, and
 * the join screen already limits what a player can type.
 */
const ROOM_CODE = /^[A-Z0-9]{1,8}$/;

function normaliseRoom(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) return "MAIN";
  return ROOM_CODE.test(code) ? code : null;
}

function sanitiseName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, 16);
}

/**
 * Name the nth chef on one connection: the first is just you, the rest are
 * numbered. Two cooks called "Jorick" standing next to each other helps nobody.
 */
function seatName(base: string, index: number): string {
  return index === 0 ? base : `${base} ${index + 1}`;
}

/**
 * Send, unless the socket is so far behind that this would only make it worse.
 *
 * `skippable` is true for frames: the next one supersedes it completely, so
 * dropping it costs a client on a bad link one twentieth of a second of
 * smoothness and costs the server nothing.
 */
function deliver(client: Client, payload: string, skippable: boolean): void {
  const buffered = client.socket.getBufferedAmount();
  if (buffered > DROP_CLIENT_BYTES) {
    // Past this the connection is not slow, it is gone, and it is holding
    // megabytes of the server's memory to prove it.
    client.socket.close();
    return;
  }
  if (skippable && buffered > MAX_BUFFERED_BYTES) {
    client.dropped++;
    return;
  }
  client.socket.send(payload);
}

function broadcast(room: Room, message: ServerMessage, skippable = false): void {
  const payload = JSON.stringify(message);
  for (const client of room.clients) deliver(client, payload, skippable);
}

function send(client: Client, message: ServerMessage): void {
  deliver(client, JSON.stringify(message), false);
}

function refuse(socket: Socket, message: string): void {
  const error: ServerMessage = { t: "error", message, fatal: true };
  socket.send(JSON.stringify(error));
  socket.close();
}

/**
 * A clock that only goes forwards.
 *
 * The loop used to derive `elapsed` from `Date.now()`, so an NTP step backwards
 * produced a negative elapsed, drove the accumulator negative and froze every
 * room for the size of the correction. Wall time is for timestamps; this is for
 * durations.
 */
function monotonic(): number {
  return Bun.nanoseconds() / 1_000_000;
}

// --- the loop ----------------------------------------------------------------

let previous = monotonic();
const loop = setInterval(() => {
  const now = monotonic();
  const elapsed = (now - previous) / 1000;
  previous = now;

  for (const room of rooms.values()) {
    try {
      tickRoom(room, elapsed, now);
    } catch (error) {
      // One bad room must not take the others down with it. An uncaught throw
      // in a timer callback aborts the whole sweep — every room after this one
      // in insertion order would silently freeze, and in Bun it can end the
      // process. Evict the room instead; its players reconnect into a fresh one
      // rebuilt from disk.
      console.error("[cookd] room", room.code, "failed and was evicted:", error);
      for (const client of room.clients) {
        try {
          client.socket.close();
        } catch {
          /* already gone */
        }
      }
      rooms.delete(room.code);
    }
  }
}, TICK_MS);

function tickRoom(room: Room, elapsed: number, now: number): void {
  // Held seats expire whether or not anyone is still connected, so a room that
  // empties out does not keep ghosts around until someone happens to return.
  for (const [token, seat] of room.vacant) {
    if (now < seat.expires) continue;
    for (const id of seat.ids) room.host.leave(id);
    room.vacant.delete(token);
  }

  if (room.clients.size === 0) {
    // Keep an empty room warm for a while: someone refreshing their browser
    // should not come back to a wiped kitchen.
    if (room.emptySince !== null && now - room.emptySince > EMPTY_ROOM_TTL) {
      persist(room);
      rooms.delete(room.code);
    }
    return;
  }

  const ticks = room.host.advance(elapsed, { maxTicks: 8 });
  // Hitting the cap means the room asked for more simulation than it got, and
  // the difference is time the players simply lost. Counted rather than logged:
  // one slow tick is noise, a rising number is the signal to look.
  if (ticks >= 8) room.behind++;
  room.sinceFrame += Math.max(1, ticks);

  // The layout is ~70% of the world's bytes and changes a handful of times a
  // day, so it rides its own message.
  const version = layoutVersion(room.host.world);
  if (version !== room.layout) {
    room.layout = version;
    broadcast(room, { t: "layout", layout: encodeLayout(room.host.world) });
    persist(room);
  }

  // Day boundaries are when money and the day counter change, and they are
  // the natural checkpoint: losing the day in progress to a crash is fine,
  // losing five days of takings is not.
  if (room.host.world.phase !== room.phase) {
    room.phase = room.host.world.phase;
    persist(room);
  }

  const early = room.host.acted && room.sinceFrame >= EARLY_AFTER;
  if (room.sinceFrame >= SEND_EVERY || early) {
    room.sinceFrame = 0;
    broadcast(room, { t: "frame", frame: encodeFrame(room.host.world, room.host.acks) }, true);
  }
}

// --- transport ---------------------------------------------------------------

const staticRoot = new URL("../dist/", import.meta.url).pathname;

async function serveStatic(pathname: string): Promise<Response> {
  const clean = pathname === "/" ? "/index.html" : pathname;
  const file = Bun.file(staticRoot + clean.replace(/^\/+/, ""));
  if (await file.exists()) return new Response(file);
  // Unknown paths fall back to the app so /ROOMCODE style links work.
  const index = Bun.file(staticRoot + "index.html");
  if (await index.exists()) {
    return new Response(index, { headers: { "content-type": "text/html" } });
  }
  return new Response("cookd: run `bun run build` first", { status: 404 });
}

/**
 * Spend one message from a connection's budget.
 *
 * A token bucket rather than a fixed window, so a client that sends its input
 * in a small burst after a stall is not punished for the stall.
 */
function affordMessage(data: SocketData, now: number): boolean {
  const elapsed = (now - data.lastRefill) / 1000;
  data.lastRefill = now;
  data.tokens = Math.min(RATE_BURST, data.tokens + elapsed * RATE_PER_SECOND);
  if (data.tokens < 1) return false;
  data.tokens -= 1;
  return true;
}

const listener = Bun.serve<SocketData, "/ws">({
  port: PORT,
  idleTimeout: 60,
  // Nothing we accept is remotely this big; the default is 16 MB, which is 16 MB
  // a connection can make us parse.
  maxRequestBodySize: MAX_MESSAGE_BYTES,

  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const data: SocketData = { client: null, tokens: RATE_BURST, lastRefill: monotonic() };
      if (server.upgrade(request, { data })) return undefined;
      return new Response("expected a websocket", { status: 400 });
    }
    if (url.pathname === "/health") {
      // Deliberately no room codes. A room code *is* the invite and the only
      // access control there is, so listing every live one to any unauthenticated
      // GET turned "guess a code" into "read the codes, then join and reset".
      // The numbers below are what an operator actually needs.
      let clients = 0;
      let behind = 0;
      let dropped = 0;
      let queued = 0;
      for (const room of rooms.values()) {
        clients += room.clients.size;
        behind += room.behind;
        for (const client of room.clients) {
          dropped += client.dropped;
          for (const id of client.players) {
            queued = Math.max(queued, room.host.queueDepth(id));
          }
        }
      }
      return Response.json({
        ok: true,
        rooms: rooms.size,
        maxRooms: MAX_ROOMS,
        clients,
        /** Ticks where a room could not keep up. Rising means the box is full. */
        behind,
        /** Frames skipped for backed-up sockets. Rising means bad links. */
        dropped,
        /**
         * Deepest input queue in the process, in ticks.
         *
         * Each one is 16ms between a player pressing something and this server
         * acting on it, which is 16ms of staleness in what everyone else in
         * that kitchen sees them do. It is kept near `TARGET_QUEUE`; a number
         * sitting well above it means a client whose frames keep slipping.
         */
        queued,
      });
    }
    return serveStatic(url.pathname);
  },

  websocket: {
    maxPayloadLength: MAX_MESSAGE_BYTES,

    async message(socket, raw) {
      const state = socket.data;
      if (!affordMessage(state, monotonic())) return;

      const message = decode(raw, parseClientMessage);
      // Not a message we understand: a truncated frame, a stale client, or
      // somebody poking at us. Dropping is safe even for input — `nextInputs`
      // holds a player's last input when their queue starves, so a rejected
      // packet is indistinguishable from a lost one.
      if (!message) return;

      if (message.t === "hello") {
        // One handshake per socket. Without this, a second `hello` either
        // created a whole new `Client` — leaving the first in `room.clients`
        // with players that `close()` would never see, permanently — or, with a
        // token, "took over" from itself and closed the live connection the
        // message had just arrived on.
        if (state.client) return;

        if (message.version !== PROTOCOL_VERSION) {
          refuse(socket, "This page is out of date — refresh to keep playing");
          return;
        }
        const code = normaliseRoom(message.room);
        if (!code) {
          refuse(socket, "Kitchen codes are up to 8 letters or numbers");
          return;
        }
        const room = roomFor(code, await loadSave(code), message.level);
        if (!room) {
          refuse(socket, "Server is full — try again shortly");
          return;
        }
        // `await` above: another message on this socket may have arrived and
        // been handled while we were reading the save.
        if (state.client) return;

        const name = sanitiseName(message.name) || "Chef";
        const token = message.token.slice(0, 64);
        const client: Client = {
          id: crypto.randomUUID(),
          room: code,
          players: [],
          name,
          token,
          socket,
          dropped: 0,
        };

        // Same browser already connected? This is a reconnect that beat the old
        // socket's close, so take the seats over rather than doubling up.
        if (token) {
          for (const other of room.clients) {
            if (other.token !== token || other.socket === socket) continue;
            client.players = other.players;
            other.players = [];
            room.clients.delete(other);
            try {
              other.socket.close();
            } catch {
              /* already gone */
            }
          }
        }

        // Otherwise, reclaim a seat we were holding for them.
        const held = token ? room.vacant.get(token) : undefined;
        if (held && client.players.length === 0) {
          client.players = held.ids.filter((id) => room.host.has(id));
          room.vacant.delete(token);
        }
        for (const id of client.players) room.host.setAway(id, false);

        const wanted = Math.min(MAX_PER_CONNECTION, Math.max(1, message.players));
        for (let i = client.players.length; i < wanted; i++) {
          if (room.host.playerCount >= MAX_PLAYERS_PER_ROOM) break;
          client.players.push(room.host.join(seatName(name, i)));
        }
        // Being let in with no chef is worse than being turned away: the client
        // would sit there showing "online" with nobody to control and never
        // retry. This is the reconnect case — a stale connection can still be
        // holding slots until the server notices it has gone.
        if (client.players.length === 0) {
          refuse(socket, "Kitchen is full");
          return;
        }
        room.clients.add(client);
        room.emptySince = null;
        state.client = client;

        send(client, {
          t: "welcome",
          room: code,
          level: room.host.level.id,
          you: client.players,
          layout: encodeLayout(room.host.world),
          frame: encodeFrame(room.host.world, room.host.acks),
        });
        return;
      }

      const client = state.client;
      if (!client) return;
      const room = rooms.get(client.room);
      if (!room) return;

      switch (message.t) {
        case "input":
          // A connection may only move its own chefs. Cheap, and it means a
          // buggy client cannot drive someone else's cook around the kitchen.
          for (const [id, input] of Object.entries(message.inputs)) {
            const playerId = Number(id);
            if (client.players.includes(playerId)) {
              room.host.enqueue(playerId, message.seq, input);
            }
          }
          break;
        case "join": {
          if (room.host.playerCount >= MAX_PLAYERS_PER_ROOM) {
            send(client, { t: "error", message: "Kitchen is full", fatal: false });
            break;
          }
          if (client.players.length >= MAX_PER_CONNECTION) break;
          const base = sanitiseName(message.name) || client.name;
          const id = room.host.join(seatName(base, client.players.length));
          client.players.push(id);
          send(client, { t: "joined", id });
          break;
        }
        case "leave":
          if (client.players.includes(message.id)) {
            client.players = client.players.filter((id) => id !== message.id);
            room.host.leave(message.id);
          }
          break;
        case "menu":
          room.host.menu(message.action);
          break;
        case "reset":
          room.host.reset(client.name);
          room.layout = layoutVersion(room.host.world);
          broadcast(room, { t: "layout", layout: encodeLayout(room.host.world) });
          persist(room);
          break;
        case "ping":
          send(client, { t: "pong", sent: message.sent });
          break;
      }
    },

    close(socket) {
      const client = socket.data.client;
      if (!client) return;
      socket.data.client = null;
      const room = rooms.get(client.room);
      if (!room) return;
      // A connection that was already superseded by a reconnect has had its
      // players moved to the new client; it must not take them back down.
      if (!room.clients.has(client)) return;

      // Hold their seats rather than deleting the chefs outright: a blink of
      // bad signal should not cost you what you were carrying.
      if (client.token && client.players.length > 0) {
        for (const id of client.players) room.host.setAway(id, true);
        room.vacant.set(client.token, {
          ids: [...client.players],
          expires: monotonic() + RECLAIM_GRACE,
        });
      } else {
        for (const id of client.players) room.host.leave(id);
      }
      room.clients.delete(client);
      if (room.clients.size === 0) {
        room.emptySince = monotonic();
        persist(room);
      }
    },
  },
});

console.log(`cookd server on http://localhost:${PORT}`);

// --- shutting down -----------------------------------------------------------

/**
 * Write every kitchen before the process goes away.
 *
 * There was nothing here, and the gap was not small. Rooms are only persisted
 * on a layout change, a phase change, an eviction, or the last player leaving —
 * so a room mid-service has its day's takings and its day counter only in
 * memory. `saveSignature` covers `money` and `day` deliberately, which means a
 * redeploy during a busy evening silently rolled every live room back to its
 * last checkpoint. Deploys are the single most likely reason this process ever
 * stops, so the one case with no save was also the common one.
 *
 * Docker sends SIGTERM and waits ten seconds before SIGKILL. A save is under
 * 2 KB and there are at most `MAX_ROOMS` of them, so this finishes in
 * milliseconds; the timeout below exists only so that a wedged disk cannot turn
 * a clean stop into a kill.
 */
const SHUTDOWN_TIMEOUT = 5000;

let stopping = false;

async function shutdown(signal: string): Promise<void> {
  // SIGTERM then SIGINT, or an impatient operator pressing Ctrl-C twice, must
  // not start a second sweep while the first is still writing.
  if (stopping) return;
  stopping = true;
  console.log(`[cookd] ${signal} — saving ${rooms.size} room(s)`);

  // Stop taking input first: a tick landing mid-write would make the signature
  // we just wrote stale the moment it hit the disk.
  clearInterval(loop);
  // Not awaited: `stop()` resolves when the last connection closes, and a client
  // that has stopped reading would hold the saves hostage behind it.
  void listener.stop();

  const writes = [...rooms.values()].map((room) => persisted(room));
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT));
  await Promise.race([Promise.all(writes), timeout]);

  console.log("[cookd] saved, exiting");
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal));
}
