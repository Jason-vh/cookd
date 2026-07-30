import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BEACH_SHACK, LEVEL } from "../src/data/level";
import { PROTOCOL_VERSION } from "../src/game/protocol";
import { parseServerMessage } from "../src/game/wire";
import type { ServerMessage } from "../src/game/protocol";

/**
 * The transport, over a real socket.
 *
 * `host.test.ts` deliberately tests the rules "without a socket in sight",
 * which is right — but it left the whole handshake untested: seat reclaim,
 * duplicate hello, room caps, malformed input. That is exactly where the bugs
 * were, so this runs the actual server in a subprocess and talks to it.
 */

const PORT = 5399;
const URL = `ws://127.0.0.1:${PORT}/ws`;

let server: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  const saveDir = await mkdtemp(join(tmpdir(), "cookd-server-"));
  server = Bun.spawn(["bun", "run", "server/index.ts"], {
    env: { ...process.env, PORT: String(PORT), COOKD_SAVE_DIR: saveDir },
    stdout: "ignore",
    stderr: "ignore",
  });
  // Wait for it to answer rather than sleeping a guessed amount.
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(50);
  }
  throw new Error("server did not start");
});

afterAll(() => {
  server.kill();
});

/** A connection that collects validated messages. */
class Client {
  readonly seen: ServerMessage[] = [];
  private socket: WebSocket;

  constructor() {
    this.socket = new WebSocket(URL);
    this.socket.addEventListener("message", (event) => {
      const message = parseServerMessage(JSON.parse(String(event.data)));
      // Every message the server sends must survive our own parser. If it does
      // not, the two halves of the protocol have drifted.
      expect(message).not.toBeNull();
      if (message) this.seen.push(message);
    });
  }

  async open(): Promise<this> {
    if (this.socket.readyState === WebSocket.OPEN) return this;
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error("socket failed")), {
        once: true,
      });
    });
    return this;
  }

  send(message: unknown): void {
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  hello(room: string, name = "Ann", players = 1, token = "", level = ""): void {
    this.send({ t: "hello", version: PROTOCOL_VERSION, room, name, players, token, level });
  }

  /** Wait for the first message of a kind, or give up. */
  async waitFor<T extends ServerMessage["t"]>(
    kind: T,
    timeout = 3000,
  ): Promise<Extract<ServerMessage, { t: T }> | null> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      // A type predicate rather than a cast: the narrowing is the same, but
      // this one the compiler checks.
      const found = this.seen.find(
        (message): message is Extract<ServerMessage, { t: T }> => message.t === kind,
      );
      if (found) return found;
      await Bun.sleep(15);
    }
    return null;
  }

  /** Count frames received over a window, to prove the room is still ticking. */
  async frames(ms: number): Promise<number> {
    const before = this.seen.filter((m) => m.t === "frame").length;
    await Bun.sleep(ms);
    return this.seen.filter((m) => m.t === "frame").length - before;
  }

  close(): void {
    this.socket.close();
  }
}

async function connected(room: string, name = "Ann", players = 1, token = ""): Promise<Client> {
  const client = await new Client().open();
  client.hello(room, name, players, token);
  expect(await client.waitFor("welcome")).not.toBeNull();
  return client;
}

describe("the handshake", () => {
  test("a welcome carries the level, the layout and your seats", async () => {
    const client = await connected("HELLO", "Ann", 2);
    const welcome = await client.waitFor("welcome");
    expect(welcome?.t === "welcome" && welcome.you.length).toBe(2);
    expect(welcome?.t === "welcome" && welcome.level).toBe(LEVEL.id);
    expect(welcome?.t === "welcome" && welcome.layout.appliances.length).toBeGreaterThan(20);
    client.close();
  });

  test("the first person through the door chooses where the kitchen is", async () => {
    // A room is made by whoever arrives first, and their pick is what it is
    // built from. Everyone after them is a guest in it — see the note on
    // `roomFor`, and the client-side reload that follows from this.
    const host = await new Client().open();
    host.hello("BEACH", "Ann", 1, "", BEACH_SHACK.id);
    expect((await host.waitFor("welcome"))?.t === "welcome").toBe(true);

    const guest = await new Client().open();
    guest.hello("BEACH", "Bea", 1, "", LEVEL.id);
    const welcome = await guest.waitFor("welcome");
    expect(welcome?.t === "welcome" && welcome.level).toBe(BEACH_SHACK.id);

    host.close();
    guest.close();
  });

  test("a version mismatch is fatal, so the client stops retrying", async () => {
    const client = await new Client().open();
    client.send({ t: "hello", version: 999, room: "OLD", name: "Ann", players: 1, token: "" });
    const error = await client.waitFor("error");
    expect(error?.t === "error" && error.fatal).toBe(true);
    client.close();
  });

  test("an over-long room code is refused rather than truncated", async () => {
    // Truncation silently merged strangers: MY-KITCHEN-A and MYKITCHENB both
    // became MYKITCHE.
    const client = await new Client().open();
    client.hello("MY-KITCHEN-A");
    const error = await client.waitFor("error");
    expect(error?.t === "error" && error.fatal).toBe(true);
    client.close();
  });

  test("a second hello on one socket is ignored", async () => {
    // It used to either create a whole second Client — leaving the first in
    // room.clients with chefs that close() would never see — or, with a token,
    // "take over" from itself and close the live connection it arrived on.
    const client = await connected("DUP", "Ann", 1, "tok");
    client.hello("DUP", "Impostor", 4, "tok");
    client.hello("OTHER", "Impostor", 4, "");
    await Bun.sleep(200);

    expect(client.seen.filter((m) => m.t === "welcome").length).toBe(1);
    const frame = lastFrame(client);
    expect(frame?.frame.players.length).toBe(1);
    expect(await client.frames(200)).toBeGreaterThan(0);
    client.close();
  });
});

describe("untrusted input", () => {
  test("a NaN move does not touch anyone in the room", async () => {
    // The original blocker: NaN slipped past the deadzone, became a position,
    // survived clamping, and was then pushed into every chef standing nearby.
    const attacker = await connected("NAN", "Mal", 1, "mal");
    const bystander = await connected("NAN", "Bea", 1, "bea");
    const welcome = await attacker.waitFor("welcome");
    const seat = (welcome?.t === "welcome" ? welcome.you[0] : undefined) ?? 0;

    const move = { x: NaN, y: NaN };
    attacker.send({
      t: "input",
      seq: 1,
      inputs: { [seat]: { move, grab: false, use: false, start: false, menu: false } },
    });
    await Bun.sleep(300);

    const frame = lastFrame(bystander);
    const players = frame?.frame.players ?? [];
    expect(players.length).toBe(2);
    for (const player of players) {
      expect(Number.isFinite(player.x)).toBe(true);
      expect(Number.isFinite(player.y)).toBe(true);
    }
    // ...and the room is still running for everyone.
    expect(await bystander.frames(200)).toBeGreaterThan(0);
    attacker.close();
    bystander.close();
  });

  test("garbage and malformed messages are dropped, not fatal", async () => {
    const client = await connected("JUNK");
    for (const junk of [
      "not json",
      "[]",
      '"hello"',
      JSON.stringify({ t: "input", seq: 1, inputs: { 0: { move: null } } }),
      JSON.stringify({ t: "input", seq: 1, inputs: { 0: { move: { x: "e", y: 0 } } } }),
      JSON.stringify({ t: "menu", action: "deleteEverything" }),
      JSON.stringify({ t: "sudo" }),
    ]) {
      client.send(junk);
    }
    await Bun.sleep(250);
    expect(client.seen.some((m) => m.t === "error")).toBe(false);
    expect(await client.frames(200)).toBeGreaterThan(0);
    client.close();
  });

  test("a connection cannot drive somebody else's chef", async () => {
    const ann = await connected("OWN", "Ann", 1, "ann");
    const bea = await connected("OWN", "Bea", 1, "bea");
    const beaWelcome = await bea.waitFor("welcome");
    const beaSeat = (beaWelcome?.t === "welcome" ? beaWelcome.you[0] : undefined) ?? -1;

    expect(await bea.waitFor("frame")).not.toBeNull();
    const before = positionOf(bea, beaSeat);
    expect(before).not.toBeNull();
    ann.send({
      t: "input",
      seq: 1,
      inputs: {
        [beaSeat]: { move: { x: 1, y: 0 }, grab: false, use: false, start: false, menu: false },
      },
    });
    await Bun.sleep(400);
    expect(positionOf(bea, beaSeat)).toEqual(before);
    ann.close();
    bea.close();
  });
});

describe("seats", () => {
  test("a dropped connection keeps its chef, and reclaims it on return", async () => {
    const first = await connected("BACK", "Ann", 2, "same-browser");
    const before = await first.waitFor("welcome");
    const seats = before?.t === "welcome" ? before.you : [];
    expect(seats.length).toBe(2);
    first.close();
    await Bun.sleep(200);

    const again = await connected("BACK", "Ann", 2, "same-browser");
    const after = await again.waitFor("welcome");
    expect(after?.t === "welcome" && after.you).toEqual(seats);
    again.close();
  });

  test("a different browser gets its own chefs", async () => {
    const ann = await connected("TWO", "Ann", 1, "ann-token");
    const bea = await connected("TWO", "Bea", 1, "bea-token");
    const a = await ann.waitFor("welcome");
    const b = await bea.waitFor("welcome");
    expect(a?.t === "welcome" && b?.t === "welcome" && a.you[0]).not.toBe(
      b?.t === "welcome" ? b.you[0] : -1,
    );
    ann.close();
    bea.close();
  });
});

describe("health", () => {
  test("reports load without listing room codes", async () => {
    // A room code *is* the access control, so listing every live one to an
    // unauthenticated GET turned "guess a code" into "read the codes".
    const body: unknown = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    const text = JSON.stringify(body);
    expect(text).not.toContain("HELLO");
    expect(text).not.toContain("NAN");
    expect(body).toMatchObject({ ok: true });
    expect(text).toContain("rooms");
    expect(text).toContain("behind");
  });
});

/**
 * The newest frame this client has seen.
 *
 * A reverse loop rather than `findLast`, which would want an ES2023 lib we do
 * not otherwise need.
 */
function lastFrame(client: Client): Extract<ServerMessage, { t: "frame" }> | null {
  for (let i = client.seen.length - 1; i >= 0; i--) {
    const message = client.seen[i];
    if (message?.t === "frame") return message;
  }
  return null;
}

function positionOf(client: Client, seat: number): { x: number; y: number } | null {
  const frame = lastFrame(client);
  if (!frame) return null;
  const player = frame.frame.players.find((p) => p.id === seat);
  return player ? { x: player.x, y: player.y } : null;
}

describe("shutting down", () => {
  test("a redeploy does not cost a room its day", async () => {
    // Rooms are only persisted on a layout change, a phase change, an eviction
    // or the last player leaving — so a room mid-service holds its takings and
    // its day counter in memory alone. A deploy is the most likely reason this
    // process ever stops, which made the one case with no save also the common
    // one. Verified by reverting the handler: this file never appears.
    //
    // Its own server on its own port, because the point is to kill it.
    const port = 5397;
    const dir = await mkdtemp(join(tmpdir(), "cookd-shutdown-"));
    const proc = Bun.spawn(["bun", "run", "server/index.ts"], {
      env: { ...process.env, PORT: String(port), COOKD_SAVE_DIR: dir },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      for (let i = 0; i < 200; i++) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
        } catch {
          /* not up yet */
        }
        await Bun.sleep(25);
      }

      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
      socket.send(
        JSON.stringify({
          t: "hello",
          version: PROTOCOL_VERSION,
          room: "SHUTDOWN",
          name: "Ann",
          players: 1,
          token: "t",
        }),
      );
      await Bun.sleep(300);

      // Opening the next day bumps `world.day`, which `saveSignature` covers —
      // so the room is dirty. Killed one millisecond later, before any write
      // could plausibly have finished on its own.
      socket.send(JSON.stringify({ t: "menu", action: "endDay" }));
      await Bun.sleep(60);
      socket.send(JSON.stringify({ t: "menu", action: "startDay" }));
      await Bun.sleep(1);

      proc.kill("SIGTERM");
      await proc.exited;
      expect(proc.exitCode).toBe(0);

      const saved: unknown = JSON.parse(await readFile(join(dir, "SHUTDOWN.json"), "utf8"));
      expect(saved).toMatchObject({ day: 2 });
    } finally {
      proc.kill();
    }
  }, 20_000);
});
