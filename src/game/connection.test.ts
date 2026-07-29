import { describe, expect, test } from "bun:test";
import { Connection, OPEN, reconnectDelay, type ConnectionHooks, type Socket } from "./connection";
import { PROTOCOL_VERSION, type ServerMessage } from "./protocol";

/**
 * Reconnect logic, against a fake socket.
 *
 * The real thing needs a server, a network, and a deploy going wrong, which is
 * why the two bugs below both reached production.
 */

type Listener = (event: { data?: unknown }) => void;

class FakeSocket implements Socket {
  readyState = 0;
  readonly sent: string[] = [];
  closed = 0;
  private readonly listeners = new Map<string, Listener[]>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed++;
  }

  addEventListener(type: string, listener: Listener, options?: { signal?: AbortSignal }): void {
    // Honouring the signal is the point: `Connection` relies on one abort
    // detaching every listener a socket ever had.
    if (options?.signal?.aborted) return;
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
    options?.signal?.addEventListener("abort", () => {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    });
  }

  fire(type: string, event: { data?: unknown } = {}): void {
    // Copied deliberately: a listener may detach itself while being called,
    // which is exactly what the abort signal does.
    const listeners = (this.listeners.get(type) ?? []).slice();
    for (const listener of listeners) listener(event);
  }

  open(): void {
    this.readyState = OPEN;
    this.fire("open");
  }

  parsed(): unknown[] {
    return this.sent.map((raw): unknown => JSON.parse(raw));
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const received: ServerMessage[] = [];
  const statuses: string[] = [];
  const hooks: ConnectionHooks = {
    message: (message) => received.push(message),
    status: (status) => statuses.push(status),
    hello: () => ({
      t: "hello",
      version: PROTOCOL_VERSION,
      room: "MAIN",
      name: "Ann",
      players: 1,
      token: "t",
    }),
    hadFrames: () => false,
  };
  // A fixed 10ms backoff: the *shape* of the retry logic is what is under test,
  // and `reconnectDelay` is tested directly below.
  const delays: number[] = [];
  const connection = new Connection("ws://test/ws", hooks, {
    open: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    delay: (attempt) => {
      delays.push(attempt);
      return 10;
    },
  });
  return { connection, sockets, received, statuses, delays, latest: () => sockets.at(-1)! };
}

describe("connecting", () => {
  test("sends the handshake once the socket opens, not before", () => {
    const { latest } = harness();
    expect(latest().sent).toEqual([]);
    latest().open();
    expect(latest().parsed()[0]).toMatchObject({ t: "hello", room: "MAIN" });
  });

  test("nothing is sent before the socket is open", () => {
    const { connection, latest } = harness();
    connection.send({ t: "reset" });
    expect(latest().sent).toEqual([]);
    latest().open();
    connection.send({ t: "reset" });
    expect(latest().parsed().at(-1)).toEqual({ t: "reset" });
  });

  test("only validated messages reach the caller", () => {
    const { latest, received } = harness();
    latest().open();
    latest().fire("message", { data: "not json" });
    latest().fire("message", { data: JSON.stringify({ t: "nonsense" }) });
    latest().fire("message", { data: JSON.stringify({ t: "pong", sent: 5 }) });
    expect(received).toEqual([{ t: "pong", sent: 5 }]);
  });
});

describe("dropping", () => {
  test("error and close for one socket schedule exactly one reconnect", async () => {
    // Browsers fire both for the same failed socket. Handling them
    // independently gave the client two live connections, two sets of chefs,
    // and two interleaved frame streams.
    const { sockets, latest } = harness();
    latest().open();
    latest().fire("error");
    latest().fire("close");

    await Bun.sleep(40);
    expect(sockets.length).toBe(2);
  });

  test("a stale socket cannot trigger a reconnect after being replaced", async () => {
    const { sockets, latest } = harness();
    const first = latest();
    first.open();
    first.fire("close");
    await Bun.sleep(40);
    expect(sockets.length).toBe(2);

    // The old socket coughs. It is detached and must be ignored.
    first.fire("close");
    first.fire("error");
    await Bun.sleep(40);
    expect(sockets.length).toBe(2);
  });

  test("giving up stops it retrying at all", async () => {
    // A version mismatch or a full server is not fixed by trying again.
    // Pretending otherwise is how one deploy becomes a self-inflicted denial of
    // service: every open tab hammering the box that just restarted.
    const { connection, sockets, latest, statuses } = harness();
    latest().open();
    connection.giveUp();
    expect(statuses.at(-1)).toBe("offline");

    latest().fire("close");
    await Bun.sleep(40);
    expect(sockets.length).toBe(1);
  });

  test("disposing stops it retrying, and closes the socket", async () => {
    const { connection, sockets, latest } = harness();
    latest().open();
    connection.dispose();
    expect(latest().closed).toBeGreaterThan(0);
    latest().fire("close");
    await Bun.sleep(40);
    expect(sockets.length).toBe(1);
  });
});

/** The low end of the jitter window, so a delay is a single number. */
const LOW = (): number => 0;

describe("backoff", () => {
  test("grows, and is capped", () => {
    expect(reconnectDelay(0, LOW)).toBe(500);
    expect(reconnectDelay(1, LOW)).toBe(1000);
    expect(reconnectDelay(2, LOW)).toBe(2000);
    // Without a ceiling this reaches days.
    expect(reconnectDelay(30, LOW)).toBe(10_000);
  });

  test("is jittered, so tabs that dropped together do not return together", () => {
    // Backing off in lockstep is a slower herd, not no herd.
    expect(reconnectDelay(3, () => 0)).not.toBe(reconnectDelay(3, () => 1));
    for (const random of [0, 0.5, 1]) {
      const delay = reconnectDelay(3, () => random);
      expect(delay).toBeGreaterThanOrEqual(4000);
      expect(delay).toBeLessThanOrEqual(8000);
    }
  });

  test("a settled session retries promptly again", async () => {
    const { connection, sockets, latest, delays } = harness();
    latest().open();
    latest().fire("close");
    await Bun.sleep(40);
    expect(sockets.length).toBe(2);

    // A `welcome` arrived, so the next drop starts from scratch rather than
    // inheriting the backoff of whatever went wrong before.
    connection.settled();
    latest().open();
    latest().fire("close");
    await Bun.sleep(40);
    expect(sockets.length).toBe(3);
    // Attempt counter restarted, rather than continuing to grow.
    expect(delays).toEqual([0, 0]);
  });
});
