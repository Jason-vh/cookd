import { DT } from "../src/sim/step";
import { Host } from "../src/game/host";
import {
  PROTOCOL_VERSION,
  encodeFrame,
  encodeLayout,
  layoutSignature,
  type ClientMessage,
  type ServerMessage,
} from "../src/game/protocol";
import { saveSignature, snapshot, type Save } from "../src/save";
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
 */

const PORT = Number(process.env.PORT ?? 5273);
const TICK_MS = DT * 1000;
const SEND_EVERY = 3; // 60Hz sim -> 20Hz on the wire
const EMPTY_ROOM_TTL = 10 * 60 * 1000;
const MAX_PLAYERS_PER_ROOM = 8;
const MAX_PER_CONNECTION = 4;
const MAX_ROOMS = 200;

/**
 * How long a disconnected player's chef is held before it is cleared away.
 *
 * Long enough to survive a wifi blip or a tunnel — losing a half-built pizza to
 * two seconds of bad signal is exactly the kind of thing that makes people stop
 * playing — and short enough that a genuinely departed player is not left
 * standing in the kitchen blocking a doorway.
 */
const RECLAIM_GRACE = 25_000;

type Client = {
  id: string;
  room: string;
  players: number[];
  name: string;
  token: string;
  socket: { send: (data: string) => void; close: () => void };
};

type Room = {
  code: string;
  host: Host;
  clients: Set<Client>;
  frames: number;
  layout: string;
  /** Last phase seen, so a day boundary can trigger a checkpoint. */
  phase: World["phase"];
  emptySince: number | null;
  /**
   * Signature of the state we consider already persisted — either what was
   * loaded from disk, or the pristine default, which needs no file. Anything
   * else means there is something worth writing.
   */
  saved: string;
  /** Seats being held for players who dropped, by browser token. */
  vacant: Map<string, { ids: number[]; expires: number }>;
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
function roomFor(code: string, save: Save | null): Room | null {
  const existing = rooms.get(code);
  if (existing) return existing;
  if (rooms.size >= MAX_ROOMS) return null;
  const host = new Host(save);
  const room: Room = {
    code,
    host,
    clients: new Set(),
    frames: 0,
    layout: layoutSignature(host.world),
    phase: host.world.phase,
    emptySince: Date.now(),
    saved: saveSignature(host.world),
    vacant: new Map(),
  };
  rooms.set(code, room);
  return room;
}

/** Write the room if, and only if, it differs from what is on disk. */
function persist(room: Room): void {
  const signature = saveSignature(room.host.world);
  if (signature === room.saved) return;
  room.saved = signature;
  void saveKitchen(room.code, snapshot(room.host.world));
}

function normaliseRoom(raw: string): string {
  const code = (raw || "main").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return code || "MAIN";
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

function broadcast(room: Room, message: ServerMessage): void {
  const payload = JSON.stringify(message);
  for (const client of room.clients) client.socket.send(payload);
}

function send(client: Client, message: ServerMessage): void {
  client.socket.send(JSON.stringify(message));
}

// --- the loop ----------------------------------------------------------------

let previous = Date.now();
setInterval(() => {
  const now = Date.now();
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

  {
    if (room.clients.size === 0) {
      // Keep an empty room warm for a while: someone refreshing their browser
      // should not come back to a wiped kitchen.
      if (room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL) {
        persist(room);
        rooms.delete(room.code);
      }
      return;
    }

    room.host.advance(elapsed, { maxTicks: 8 });
    room.frames++;

    // The layout is ~70% of the world's bytes and changes a handful of times a
    // day, so it rides its own message.
    const layout = layoutSignature(room.host.world);
    if (layout !== room.layout) {
      room.layout = layout;
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

    if (room.frames % SEND_EVERY === 0) {
      broadcast(room, { t: "frame", frame: encodeFrame(room.host.world, room.host.acks) });
    }
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
  if (await index.exists()) return new Response(index, { headers: { "content-type": "text/html" } });
  return new Response("cookd: run `bun run build` first", { status: 404 });
}

Bun.serve<{ client: Client | null }, Record<string, never>>({
  port: PORT,
  idleTimeout: 60,

  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(request, { data: { client: null } })) return undefined as unknown as Response;
      return new Response("expected a websocket", { status: 400 });
    }
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        rooms: [...rooms.values()].map((room) => ({
          code: room.code,
          players: room.host.playerCount,
          clients: room.clients.size,
          day: room.host.world.day,
        })),
      });
    }
    return serveStatic(url.pathname);
  },

  websocket: {
    async message(socket, raw) {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      const state = socket.data;

      if (message.t === "hello") {
        if (message.version !== PROTOCOL_VERSION) {
          socket.send(JSON.stringify({ t: "error", message: "Version mismatch — refresh the page" }));
          socket.close();
          return;
        }
        const code = normaliseRoom(message.room);
        const room = roomFor(code, await loadSave(code));
        if (!room) {
          socket.send(JSON.stringify({ t: "error", message: "Server is full — try again shortly" }));
          socket.close();
          return;
        }
        const name = sanitiseName(message.name) || "Chef";
        const token = String(message.token ?? "").slice(0, 64);
        const client: Client = { id: crypto.randomUUID(), room: code, players: [], name, token, socket };

        // Same browser already connected? This is a reconnect that beat the old
        // socket's close, so take the seats over rather than doubling up.
        if (token) {
          for (const other of room.clients) {
            if (other.token !== token) continue;
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
          socket.send(JSON.stringify({ t: "error", message: "Kitchen is full" }));
          socket.close();
          return;
        }
        room.clients.add(client);
        room.emptySince = null;
        state.client = client;

        send(client, {
          t: "welcome",
          room: code,
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
            send(client, { t: "error", message: "Kitchen is full" });
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
          room.layout = layoutSignature(room.host.world);
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
      const room = rooms.get(client.room);
      if (!room) return;
      // Hold their seats rather than deleting the chefs outright: a blink of
      // bad signal should not cost you what you were carrying.
      if (client.token && client.players.length > 0) {
        for (const id of client.players) room.host.setAway(id, true);
        room.vacant.set(client.token, {
          ids: [...client.players],
          expires: Date.now() + RECLAIM_GRACE,
        });
      } else {
        for (const id of client.players) room.host.leave(id);
      }
      room.clients.delete(client);
      if (room.clients.size === 0) {
        room.emptySince = Date.now();
        persist(room);
      }
    },
  },
});

console.log(`cookd server on http://localhost:${PORT}`);
