import type { ClientMessage, ServerMessage } from "./protocol";
import { decode, parseServerMessage } from "./wire";

/**
 * The socket, and the business of keeping one.
 *
 * Reconnecting sounds like three lines and is not. This has produced two real
 * bugs on its own:
 *
 *  - Browsers fire `error` **and then** `close` for the same failed socket, so
 *    a naive handler schedules two reconnects and the client ends up with two
 *    live connections, two sets of chefs, and two interleaved frame streams.
 *  - A flat retry interval with no ceiling and no terminal state meant a
 *    protocol bump had every open tab hammering the box that had just
 *    restarted, for ever, while the server's "refresh the page" went to a
 *    `console.warn` nobody was reading.
 *
 * Pulled out of `net.ts` so both are testable against a fake socket, which is
 * the only way to exercise them: the real thing needs a server, a network, and
 * a deploy going wrong.
 */

/**
 * Reconnect backoff.
 *
 * Jitter matters as much as the ceiling: without it, tabs that dropped together
 * back off in lockstep and reconnect together, which is a slower herd rather
 * than no herd.
 */
const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 20_000;

export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const capped = Math.min(RECONNECT_MAX, RECONNECT_BASE * 2 ** attempt);
  return capped * (0.5 + random() * 0.5);
}

/** How often to measure the round trip, in ms. */
const PING_EVERY = 2000;

/**
 * The part of `WebSocket` this uses.
 *
 * Narrow on purpose: a fake implementing five members is all a test needs, and
 * naming them is what makes it obvious that nothing here depends on the
 * browser beyond sending and receiving strings.
 */
export type Socket = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void,
    options?: { signal?: AbortSignal },
  ): void;
};

export const OPEN = 1;

export type ConnectionHooks = {
  /** A validated message from the server. */
  message(message: ServerMessage): void;
  /** Called whenever the connection state changes. */
  status(status: "connecting" | "online" | "offline"): void;
  /** The handshake to send once the socket opens. */
  hello(): ClientMessage;
  /**
   * Whether a drop should look like "reconnecting" or "we never got in".
   * `NetGame` answers from whether it has any frames yet.
   */
  hadFrames(): boolean;
};

export class Connection {
  private socket: Socket | null = null;
  private listeners: AbortController | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private attempts = 0;

  /**
   * Set when the server has told us not to come back. A version mismatch or a
   * full server is not fixed by trying again, and pretending otherwise is how
   * one deploy becomes a self-inflicted denial of service.
   */
  private fatal = false;

  private readonly open: (url: string) => Socket;
  private readonly delay: (attempt: number) => number;

  constructor(
    private readonly url: string,
    private readonly hooks: ConnectionHooks,
    /**
     * Both collaborators are injectable so the retry behaviour can be tested
     * without a network and without a test suite that sleeps for twelve
     * seconds. Timing that only holds when a test waits long enough is timing
     * nobody will keep waiting for.
     */
    wiring: { open?: (url: string) => Socket; delay?: (attempt: number) => number } = {},
  ) {
    this.open = wiring.open ?? ((target) => new WebSocket(target));
    this.delay = wiring.delay ?? reconnectDelay;
    this.connect();
  }

  connect(): void {
    if (this.disposed || this.fatal) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    // Detach whatever came before. Without this a reconnect can leave the old
    // socket alive, which keeps its room occupied and interleaves its frames
    // with the new one's. An AbortController rather than nulling `on*`
    // handlers: one signal removes every listener this socket ever had, and
    // cannot be half-applied the way three separate assignments can.
    if (this.socket) this.detach();

    this.hooks.status(this.hooks.hadFrames() ? "offline" : "connecting");
    const socket = this.open(this.url);
    const listeners = new AbortController();
    const { signal } = listeners;
    this.socket = socket;
    this.listeners = listeners;

    socket.addEventListener(
      "open",
      () => {
        this.send(this.hooks.hello());
        this.pingTimer = setInterval(() => this.send({ t: "ping", sent: Date.now() }), PING_EVERY);
      },
      { signal },
    );

    socket.addEventListener(
      "message",
      (event) => {
        // Validated, not cast. "The server is trustworthy" is an assumption
        // about a deployment rather than about a socket, and a half-upgraded
        // server mid-deploy is the ordinary way it stops being true.
        const message = decode(event.data, parseServerMessage);
        if (message) this.hooks.message(message);
      },
      { signal },
    );

    // `error` and `close` both fire for one failed socket, so this must only
    // ever run once — see the note at the top of the file.
    let dropped = false;
    const drop = (): void => {
      if (dropped) return;
      dropped = true;
      this.stopPinging();
      if (this.disposed || this.socket !== socket) return;
      this.hooks.status("offline");
      if (this.fatal) return;
      // Keep playing what we have and try again; a dropped connection should
      // look like the kitchen freezing, not like the game crashing.
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), this.delay(this.attempts++));
    };
    socket.addEventListener("close", drop, { signal });
    socket.addEventListener("error", drop, { signal });
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(message));
  }

  /**
   * A session started cleanly, so the next drop should retry promptly rather
   * than inheriting the backoff from whatever went wrong before.
   */
  settled(): void {
    this.attempts = 0;
  }

  /** Stop trying. For errors that another attempt cannot fix. */
  giveUp(): void {
    this.fatal = true;
    this.hooks.status("offline");
    this.detach();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.detach();
  }

  private detach(): void {
    this.stopPinging();
    this.listeners?.abort();
    this.listeners = null;
    try {
      this.socket?.close();
    } catch {
      /* already gone */
    }
    this.socket = null;
  }

  private stopPinging(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
