import { RECIPE_BY_ID } from "../data/recipes";
import { isLastOrders } from "../sim/queries";
import type { Ledger, World } from "../sim/types";

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
  /**
   * The morning the summary has already been dismissed for.
   *
   * Shell state, not simulation state: one player folding the card away is not
   * a thing the kitchen needs an opinion about, and it certainly is not a thing
   * that should fold it away on somebody else's screen. Keyed by day so the
   * next morning's card comes back on its own.
   */
  private dismissed = 0;
  /**
   * The morning the banner has already stepped aside for.
   *
   * The card is the game's only tutorial, so it arrives loud — and then the
   * build phase is the half of the game where you most want to see the room it
   * is standing in front of. Once the player has answered it, or simply walked
   * off, it shrinks to a line. Shell state and keyed by day, like `dismissed`:
   * the next morning's card comes back on its own.
   */
  private settled = 0;
  /** What to call the key that opens the next day — the player may have moved it. */
  private startKey = "Enter";

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
  /** The keys changed: say the new one rather than the one this was written with. */
  setStartKey(label: string): void {
    this.startKey = label;
    this.setBanner("open", `Press ${label} to open`);
  }

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
   * Fold away the end-of-day card, leaving the morning banner.
   *
   * Called by the shell when anybody presses confirm. The card must never trap
   * a player: it is a report, the kitchen behind it is playable, and the same
   * button that dismisses it is the one they already know.
   */
  dismissSummary(world: World): void {
    this.dismissed = world.day;
    this.settled = world.day;
  }

  /**
   * The player is getting on with their morning, so the banner gets out of the
   * way. Movement only — a report still on screen is something to read, and
   * reading it is not a reason to lose it.
   */
  settleBanner(world: World): void {
    this.settled = world.day;
  }

  /**
   * The morning banner, and the day that just closed.
   *
   * The build phase is now the **morning of the upcoming day**, so this is two
   * things stacked: a report on yesterday, and one unmissable instruction for
   * today. Day one has no yesterday, which is exactly the case that has to work
   * hardest — a player alone in a kitchen that will not start until they press
   * something. That instruction is the entire tutorial budget, so it is spent
   * on prominence rather than on a new screen.
   *
   * Prominence is not permanence: once it has been answered the whole thing
   * becomes a pill at the top edge carrying the sentence and nothing else. The
   * morning is the half of the game that is about *looking at the room*, and a
   * card parked in front of it all morning was the wrong price for a tutorial
   * that has already been read.
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

    const closed = world.today;
    // A ledger for a day nobody played is not a report; day one has nothing to
    // say and should not pretend otherwise.
    const hasReport = closed.day < world.day && this.dismissed !== world.day;
    this.bannerCard.classList.toggle("with-report", hasReport);
    // A report is the one thing worth a whole card. Everything else the morning
    // has to say fits on one line.
    this.banner.classList.toggle("slim", !hasReport && this.settled === world.day);

    this.setBanner("title", `Day ${world.day} \u2014 morning`);
    this.setBanner("open", `Press ${this.startKey} to open`);
    if (hasReport) this.setReport(closed, world.money);
  }

  /** Yesterday, in one card: what came in, what went out, and what was missed. */
  private setReport(closed: Ledger, balance: number): void {
    this.setBanner("report-title", `Day ${closed.day}`);
    this.setBanner(
      "report",
      [`Earned $${closed.earned}`, `Tips $${closed.tips}`, `Balance $${balance}`].join(" \u00b7 "),
    );
    const lost = Object.entries(closed.lost)
      .map(([id, count]) => `${count} \u00d7 ${RECIPE_BY_ID.get(id)?.name ?? id}`)
      .join(", ");
    this.setBanner(
      "report-service",
      `${closed.served} served` + (lost ? ` \u00b7 walked out: ${lost}` : ""),
    );
  }

  private buildBannerCard(): void {
    const reportTitle = document.createElement("h2");
    reportTitle.dataset.banner = "report-title";
    reportTitle.className = "report-line";
    const report = document.createElement("p");
    report.dataset.banner = "report";
    report.className = "report-line";
    const service = document.createElement("p");
    service.dataset.banner = "report-service";
    service.className = "report-line";

    const title = document.createElement("h1");
    title.dataset.banner = "title";
    const open = document.createElement("p");
    open.dataset.banner = "open";
    open.className = "banner-open";

    // The keyboard's key is in the instruction itself, so this row is what the
    // instruction cannot say: the other ways in. It goes with the card.
    const keys = document.createElement("p");
    keys.className = "banner-keys";
    const pad = document.createElement("span");
    pad.textContent = "Y";
    keys.append(pad, " on a pad, or the pause menu");
    this.bannerCard.replaceChildren(reportTitle, report, service, title, open, keys);
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
  if (world.phase !== "service") return "Preparing";
  if (world.dayTime <= 0) return "Closing";
  if (isLastOrders(world)) return "Last orders";
  return "Time";
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
