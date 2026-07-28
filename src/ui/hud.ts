import { LAST_ORDERS } from "../sim/systems/customers";
import type { World } from "../sim/types";

/**
 * DOM HUD. Kept out of the WebGL layer on purpose: text, layout and
 * accessibility are things the browser is already very good at.
 *
 * There is deliberately **no order list** here. Orders used to be tickets in
 * this panel; now they are bubbles over the tables of the people who placed
 * them, which says the same thing plus who, where and how far away. Keeping
 * both would have split the player's attention between the room and the corner
 * of the screen, and only one of those can also tell you how far you have to
 * walk.
 */
/** Connection state, for the badge in the corner. */
export type Connection = {
  status: "local" | "connecting" | "online" | "offline";
  ping: number | null;
  room: string;
};

export class Hud {
  private stats: HTMLElement;
  private log: HTMLElement;
  private notice!: HTMLElement;
  private banner: HTMLElement;
  private connectionNode: HTMLElement | null = null;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div id="stats" class="panel">
        <div><span class="label">Day</span><span class="big" data-day>1</span></div>
        <div><span class="label" data-timelabel>Time</span><span class="big" data-time>0:00</span></div>
        <div><span class="label">Money</span><span class="big" data-money>$0</span></div>
        <div><span class="label">Served</span><span class="big" data-served>0</span></div>
        <div><span class="label">Lost</span><span class="big" data-lost>0</span></div>
        <div class="connection"></div>
      </div>
      <div id="log"></div>
      <div id="notice"></div>
      <div id="banner"><div class="card"></div></div>
    `;
    this.stats = root.querySelector("#stats")!;
    this.log = root.querySelector("#log")!;
    this.notice = root.querySelector("#notice")!;
    this.banner = root.querySelector("#banner")!;
    this.connectionNode = this.stats.querySelector(".connection");
  }

  update(world: World, connection?: Connection): void {
    this.syncConnection(connection);
    this.set("day", String(world.day));
    // The clock keeps its digits and the label carries the meaning — a stat
    // whose value changes width makes the whole panel jump.
    this.set("time", formatTime(Math.max(0, world.dayTime)));
    this.set("timelabel", dayPhase(world));
    this.set("money", `$${world.money}`);
    this.set("served", String(world.served));
    this.set("lost", String(world.lost));

    this.syncLog(world);
    this.syncBanner(world);
  }

  /**
   * Who you're playing with, and how far away they are. Shown only online —
   * offline there is nothing to say and a permanent "local" badge is noise.
   */
  private syncConnection(connection?: Connection): void {
    if (!this.connectionNode) return;
    if (!connection || connection.status === "local") {
      this.connectionNode.textContent = "";
      this.connectionNode.className = "connection";
      return;
    }
    const ping = connection.ping === null ? "" : ` · ${Math.round(connection.ping)}ms`;
    const label =
      connection.status === "online"
        ? `${connection.room}${ping}`
        : connection.status === "connecting"
          ? "connecting…"
          : "reconnecting…";
    this.connectionNode.textContent = label;
    this.connectionNode.className = `connection ${connection.status}`;
  }

  /**
   * A one-off line from the *shell* — connection trouble, not kitchen news.
   * It has its own node because `syncLog` replaces the sim log wholesale.
   */
  notify(text: string): void {
    const line = document.createElement("div");
    line.textContent = text;
    this.notice.append(line);
    setTimeout(() => line.remove(), 6000);
  }

  private set(key: string, value: string): void {
    const node = this.stats.querySelector(`[data-${key}]`);
    if (node && node.textContent !== value) node.textContent = value;
  }

  private syncLog(world: World): void {
    const text = world.events.map((e) => e.text).join("\n");
    if (this.log.dataset.text === text) return;
    this.log.dataset.text = text;
    this.log.replaceChildren(
      ...world.events.map((e) => {
        const div = document.createElement("div");
        div.textContent = e.text;
        return div;
      }),
    );
  }

  private syncBanner(world: World): void {
    const show = world.phase === "build";
    this.banner.classList.toggle("show", show);
    if (!show) return;
    const card = this.banner.querySelector(".card")!;
    const html = `
      <h1>Day ${world.day} closed</h1>
      <p>$${world.money} earned &middot; ${world.served} served &middot; ${world.lost} walked out</p>
      <p>Rearrange the kitchen, then open for day ${world.day + 1}.</p>
      <p class="banner-keys"><span>Enter</span> <span>Y</span> or the pause menu</p>
    `;
    if (card.innerHTML !== html) card.innerHTML = html;
  }
}

/**
 * What the clock means right now.
 *
 * Past closing time the number just sits at 0:00 while the room empties, so the
 * last stretch of a day says what is actually happening instead: no new
 * customers are coming, and the day ends when these ones do.
 */
function dayPhase(world: World): string {
  if (world.phase !== "service") return "Time";
  if (world.dayTime <= 0) return "Closing";
  if (world.dayTime <= LAST_ORDERS) return "Last orders";
  return "Time";
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

