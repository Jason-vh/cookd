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

/** The five numbers in the corner. */
type StatKey = "day" | "time" | "timelabel" | "money" | "served" | "lost";

export class Hud {
  private readonly log: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly bannerCard: HTMLElement;
  private readonly connectionNode: HTMLElement | null;
  /**
   * The stat nodes, looked up once.
   *
   * `set()` used to run `stats.querySelector(\`[data-${key}]\`)` on every call,
   * six times per `update`, and `update` runs every frame — 360 attribute
   * selector queries a second to change five short strings that mostly do not
   * change.
   */
  private readonly stats = new Map<StatKey, Element>();
  /** Timers from `notify`, cancelled on teardown. */
  private readonly notices = new Set<ReturnType<typeof setTimeout>>();

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
    const stats = root.querySelector("#stats");
    const log = root.querySelector("#log");
    const notice = root.querySelector("#notice");
    const banner = root.querySelector("#banner");
    const card = banner?.querySelector(".card");
    if (
      !(stats instanceof HTMLElement) ||
      !(log instanceof HTMLElement) ||
      !(notice instanceof HTMLElement) ||
      !(banner instanceof HTMLElement) ||
      !(card instanceof HTMLElement)
    ) {
      throw new Error("hud markup is missing a node it just wrote");
    }
    this.log = log;
    this.notice = notice;
    this.banner = banner;
    this.bannerCard = card;
    this.connectionNode = stats.querySelector(".connection");

    const keys: StatKey[] = ["day", "time", "timelabel", "money", "served", "lost"];
    for (const key of keys) {
      const node = stats.querySelector(`[data-${key}]`);
      if (node) this.stats.set(key, node);
    }
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
    const timer = setTimeout(() => {
      line.remove();
      this.notices.delete(timer);
    }, 6000);
    this.notices.add(timer);
  }

  /** Cancel anything still pending. Notices outlive the element otherwise. */
  dispose(): void {
    for (const timer of this.notices) clearTimeout(timer);
    this.notices.clear();
  }

  private set(key: StatKey, value: string): void {
    const node = this.stats.get(key);
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

  /**
   * The end-of-day card.
   *
   * Built once and updated by `textContent`, rather than rebuilt as an HTML
   * string every frame. Reading `card.innerHTML` to compare forced the browser
   * to serialise the DOM back to a string 60 times a second, and interpolating
   * simulation values into markup is a habit that only stays safe for as long
   * as every value happens to be a number.
   */
  private syncBanner(world: World): void {
    const show = world.phase === "build";
    this.banner.classList.toggle("show", show);
    if (!show) return;
    if (this.bannerCard.childElementCount === 0) this.buildBannerCard();
    this.setBanner("title", `Day ${world.day} closed`);
    this.setBanner(
      "summary",
      `$${world.money} earned \u00b7 ${world.served} served \u00b7 ${world.lost} walked out`,
    );
    this.setBanner("next", `Rearrange the kitchen, then open for day ${world.day + 1}.`);
  }

  private buildBannerCard(): void {
    const title = document.createElement("h1");
    title.dataset.banner = "title";
    const summary = document.createElement("p");
    summary.dataset.banner = "summary";
    const next = document.createElement("p");
    next.dataset.banner = "next";
    const keys = document.createElement("p");
    keys.className = "banner-keys";
    for (const key of ["Enter", "Y"]) {
      const span = document.createElement("span");
      span.textContent = key;
      keys.append(span, " ");
    }
    keys.append("or the pause menu");
    this.bannerCard.replaceChildren(title, summary, next, keys);
  }

  private setBanner(key: string, value: string): void {
    const node = this.bannerCard.querySelector(`[data-banner="${key}"]`);
    if (node && node.textContent !== value) node.textContent = value;
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
