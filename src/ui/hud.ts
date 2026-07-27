import { RECIPE_BY_ID, RECIPE_STEPS } from "../data/recipes";
import type { World } from "../sim/types";

/**
 * DOM HUD. Kept out of the WebGL layer on purpose: text, layout and
 * accessibility are things the browser is already very good at.
 *
 * Rows are reconciled by order id rather than re-rendered, so the HUD does not
 * thrash the DOM every frame.
 */
/** Connection state, for the badge in the corner. */
export type Connection = {
  status: "local" | "connecting" | "online" | "offline";
  ping: number | null;
  room: string;
};

export class Hud {
  private stats: HTMLElement;
  private orders: HTMLElement;
  private log: HTMLElement;
  private notice!: HTMLElement;
  private banner: HTMLElement;
  private rows = new Map<number, { root: HTMLElement; fill: HTMLElement; accent: string }>();
  private connectionNode: HTMLElement | null = null;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div id="stats" class="panel">
        <div><span class="label">Day</span><span class="big" data-day>1</span></div>
        <div><span class="label">Time</span><span class="big" data-time>0:00</span></div>
        <div><span class="label">Money</span><span class="big" data-money>$0</span></div>
        <div><span class="label">Served</span><span class="big" data-served>0</span></div>
        <div><span class="label">Lost</span><span class="big" data-lost>0</span></div>
        <div class="connection"></div>
      </div>
      <div id="orders"></div>
      <div id="log"></div>
      <div id="notice"></div>
      <div id="banner"><div class="card"></div></div>
    `;
    this.stats = root.querySelector("#stats")!;
    this.orders = root.querySelector("#orders")!;
    this.log = root.querySelector("#log")!;
    this.notice = root.querySelector("#notice")!;
    this.banner = root.querySelector("#banner")!;
    this.connectionNode = this.stats.querySelector(".connection");
  }

  update(world: World, connection?: Connection): void {
    this.syncConnection(connection);
    this.set("day", String(world.day));
    this.set("time", formatTime(Math.max(0, world.dayTime)));
    this.set("money", `$${world.money}`);
    this.set("served", String(world.served));
    this.set("lost", String(world.lost));

    this.syncOrders(world);
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

  private syncOrders(world: World): void {
    const seen = new Set<number>();
    for (const order of world.orders) {
      seen.add(order.id);
      let row = this.rows.get(order.id);
      if (!row) {
        const recipe = RECIPE_BY_ID.get(order.recipeId);
        const root = document.createElement("div");
        root.className = "order";
        root.innerHTML = `
          <div class="name"><span>${recipe?.name ?? order.recipeId}</span><span>$${recipe?.reward ?? 0}</span></div>
          <div class="steps">${(RECIPE_STEPS[order.recipeId] ?? []).join(" &rsaquo; ")}</div>
          <div class="bar"><div></div></div>
        `;
        this.orders.appendChild(root);
        row = { root, fill: root.querySelector(".bar > div")!, accent: "" };
        this.rows.set(order.id, row);
      }
      const ratio = Math.max(0, order.remaining / order.patience);
      row.fill.style.width = `${(ratio * 100).toFixed(1)}%`;
      // One custom property drives both the bar and the ticket's edge accent.
      const accent = ratio > 0.5 ? "var(--good)" : ratio > 0.25 ? "var(--warn)" : "var(--bad)";
      if (row.accent !== accent) {
        row.accent = accent;
        row.root.style.setProperty("--accent", accent);
      }
    }

    for (const [id, row] of this.rows) {
      if (seen.has(id)) continue;
      row.root.remove();
      this.rows.delete(id);
    }
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
    `;
    if (card.innerHTML !== html) card.innerHTML = html;
  }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

