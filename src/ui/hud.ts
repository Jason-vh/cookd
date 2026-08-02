import { rentFor } from "../data/economy";
import { RECIPE_BY_ID } from "../data/recipes";
import { isLastOrders } from "../sim/queries";
import { beatsRecord, daysPlayed } from "../sim/run";
import { weatherOf } from "../sim/weather";
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
  private readonly paused: HTMLElement;
  private readonly pausedCard: HTMLElement;
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
      <div id="paused"><div class="card"></div></div>
    `;
    const stats = root.querySelector("#stats");
    const log = root.querySelector("#log");
    const notice = root.querySelector("#notice");
    const banner = root.querySelector("#banner");
    const card = banner?.querySelector(".card");
    const paused = root.querySelector("#paused");
    const pausedCard = paused?.querySelector(".card");
    if (
      !(stats instanceof HTMLElement) ||
      !(log instanceof HTMLElement) ||
      !(notice instanceof HTMLElement) ||
      !(banner instanceof HTMLElement) ||
      !(card instanceof HTMLElement) ||
      !(paused instanceof HTMLElement) ||
      !(pausedCard instanceof HTMLElement)
    ) {
      throw new Error("hud markup is missing a node it just wrote");
    }
    this.paused = paused;
    this.pausedCard = pausedCard;
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
    // `-$15` rather than `$-15`: a debt is a minus in front of an amount, and
    // the till can be in one now. See `chargeRent`.
    this.set("money", money(world.money));
    this.stats.get("money")?.classList.toggle("owed", world.money < 0);
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
   * Somebody else has the kitchen stopped.
   *
   * Only for *somebody else*: whoever paused is looking at the menu they paused
   * with, and telling them their own menu is open would be the game explaining
   * a thing they are holding. `ours` is the shell's to answer — the world knows
   * a room is paused and by whom, and which of those chefs is on this screen is
   * exactly the sort of thing the simulation has no business knowing.
   */
  syncPause(world: World, ours: boolean): void {
    const show = world.pausedBy !== null && !ours;
    this.paused.classList.toggle("show", show);
    if (!show) return;
    const text = `${world.pausedName} paused the kitchen`;
    if (this.pausedCard.textContent !== text) this.pausedCard.textContent = text;
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
    // A repossessed kitchen never shrinks to a strip: the card is the only
    // thing on screen that says the run has ended.
    this.banner.classList.toggle(
      "slim",
      !hasReport && this.settled === world.day && !world.evicted,
    );

    if (world.evicted) {
      // The run is over, and the card is the only thing that says so. It keeps
      // yesterday's report above it: the last day's numbers are the epitaph.
      this.setBanner("title", `Day ${closed.day} \u2014 closed down`);
      this.setBanner("open", "The rent went unpaid twice, and the kitchen is repossessed");
      // Nothing left to forecast: the kitchen is not opening again.
      this.setBanner("weather", "");
      // What the run is worth, which is the only thing on this card that is
      // about *next time*. Without it a lost run leaves nothing behind but a
      // fresh kitchen, and "again" is a button rather than a reason.
      this.setBanner("record", runNotice(world));
      this.bannerCard
        .querySelector('[data-banner="record"]')
        ?.classList.toggle("beaten", beatsRecord(world));
      this.setBanner("note", "Start again from the pause menu");
      this.bannerCard.querySelector('[data-banner="note"]')?.classList.remove("urgent");
      if (hasReport) this.setReport(closed, world.money);
      return;
    }

    this.setBanner("title", `Day ${world.day} \u2014 morning`);
    // The forecast, above the instruction rather than below it, because it is a
    // thing to *know before spending*: what the shop is worth this morning
    // depends on whether anybody will be sitting outside this afternoon. This
    // is the whole of how a player learns the terrace exists, which is why the
    // sentence lives in `data/weather.ts` beside the numbers it describes.
    this.setBanner("weather", weatherOf(world).note);
    // Where, not which button. The day is opened by turning the sign in the
    // doorway, so the instruction names a *place in the room* — which is the
    // whole reason the sign exists. See `sim/systems/sign.ts`.
    this.setBanner("open", "Turn the sign by the door to open");
    // Rent is the one cost nobody presses a button for, so the morning it is
    // due says so before the day opens rather than after it has been taken.
    // A debt is the same line doing a different job: it is the last warning
    // before the run ends, so it stops being a footnote and turns red.
    this.setBanner("note", rentNotice(world));
    // The record belongs to the end of a run, not to every morning of one: a
    // mark quoted daily is a target to fall short of, and the game already has
    // a landlord for that.
    this.setBanner("record", "");
    this.bannerCard
      .querySelector('[data-banner="note"]')
      ?.classList.toggle("urgent", world.money < 0);
    if (hasReport) this.setReport(closed, world.money);
  }

  /**
   * Yesterday, as a receipt: what happened, what came in, what went out.
   *
   * It used to be two sentences of dot-separated terms, which read as a list of
   * facts rather than as an account — `Earned $40 · Tips $12 · Rent −$20` makes
   * the reader do the arithmetic *and* work out which way each number points.
   * Now the amounts are a right-aligned column in tabular figures, signed, and
   * ruled off above the total, so "where did the day go" is answered by looking
   * down one column.
   *
   * A row with nothing to say is removed rather than shown as a zero. "Walked
   * out: none" and "Rent −0" are noise on the two cards — a clean day, and the
   * first days of a run — that most want to be read quickly.
   */
  private setReport(closed: Ledger, balance: number): void {
    this.setBanner("report-title", `Day ${closed.day}`);
    // Shown even at zero: a day that fed nobody is a day the card has to be
    // willing to say fed nobody.
    this.setRow("served", `${closed.served}`, true);

    const lost = Object.entries(closed.lost)
      .map(([id, count]) => `${count} \u00d7 ${RECIPE_BY_ID.get(id)?.name ?? id}`)
      .join(", ");
    this.setRow("lost", lost, lost !== "");

    // Earned and tips are always shown, zero included: a day that took nothing
    // is the day the card most needs to say so out loud.
    this.setRow("earned", signed(closed.earned), true);
    this.setRow("tips", signed(closed.tips), true);
    this.setRow("rent", signed(-closed.rent), closed.rent > 0);
    this.setRow("balance", money(balance), true);
    this.bannerCard.querySelector('[data-row="balance"]')?.classList.toggle("owed", balance < 0);
  }

  /** One line of the receipt, or none: an empty row is removed, not blanked. */
  private setRow(key: string, value: string, show: boolean): void {
    const line = this.bannerCard.querySelector(`[data-row="${key}"]`);
    line?.classList.toggle("empty", !show);
    if (show) this.setBanner(key, value);
  }

  private buildBannerCard(): void {
    const reportTitle = document.createElement("h2");
    reportTitle.dataset.banner = "report-title";
    const ledger = document.createElement("dl");
    ledger.className = "ledger";
    ledger.append(
      row("served", "Served"),
      row("lost", "Walked out", "out"),
      row("earned", "Earned", "in"),
      row("tips", "Tips", "in"),
      row("rent", "Rent", "out"),
      row("balance", "In the till", "total"),
    );
    const report = document.createElement("div");
    report.className = "report";
    report.append(reportTitle, ledger);

    const title = document.createElement("h1");
    title.dataset.banner = "title";
    // Dressed as the footnote below it, and hidden with it when the card folds
    // down to a strip: once the morning has been read, the sky is out of the
    // window and does not need a caption.
    const weather = document.createElement("p");
    weather.className = "banner-note";
    weather.dataset.banner = "weather";
    const open = document.createElement("p");
    open.dataset.banner = "open";
    open.className = "banner-open";

    // The run's own line, under the instruction and above the footer: what this
    // kitchen has been worth, and what there is to beat. Only the closed-down
    // card fills it in, and like the footer it is hidden by `:empty`.
    const record = document.createElement("p");
    record.className = "banner-note banner-record";
    record.dataset.banner = "record";

    // The card's footer, and the only thing under the instruction: what tonight
    // will cost, what is still owed, or how to start a new run. Empty when
    // there is none of that to say, and hidden by `:empty` rather than by a
    // class.
    //
    // It used to be the grab key spelled out — `Space facing it, or A on a pad`
    // — which was a keybinding printed over the game for the life of the run to
    // teach a verb the player has already used to get to the sign. The
    // instruction above it names a *place*, which is the whole reason the sign
    // exists, and the pause menu's controls table is where keys are read.
    const note = document.createElement("p");
    note.className = "banner-note";
    note.dataset.banner = "note";
    this.bannerCard.replaceChildren(report, title, weather, open, record, note);
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

/** A signed amount: `−$15` rather than `$-15`. */
function money(amount: number): string {
  return amount < 0 ? `\u2212$${-amount}` : `$${amount}`;
}

/**
 * The same, with the plus written out.
 *
 * Only on the receipt's movement rows, never on the till: `+$96` and `−$20` are
 * a direction each, and a balance has none — it is where the day landed.
 */
function signed(amount: number): string {
  return amount > 0 ? `+$${amount}` : money(amount);
}

/** One label/amount pair of the receipt, built once and filled by `setRow`. */
function row(key: string, label: string, tone?: "in" | "out" | "total"): HTMLElement {
  const line = document.createElement("div");
  line.className = tone ? `row ${tone}` : "row";
  line.dataset.row = key;
  const term = document.createElement("dt");
  term.textContent = label;
  const value = document.createElement("dd");
  value.dataset.banner = key;
  line.append(term, value);
  return line;
}

/**
 * What this run was worth, on the card that ends it.
 *
 * Three sentences for three situations, and the difference between them is the
 * whole point of keeping a record: a first run sets the mark, a good one takes
 * it, and an ordinary one is told what is still standing. The days come first
 * in all three because days are the score — see `sim/run.ts`.
 */
function runNotice(world: World): string {
  const days = daysPlayed(world);
  const run = `${days} ${days === 1 ? "day" : "days"}, $${world.takings} taken`;
  if (beatsRecord(world)) {
    return world.best === null
      ? `${run} \u2014 the mark to beat in this kitchen`
      : `${run} \u2014 a record, past run ${world.best.run}'s ${world.best.days}`;
  }
  const best = world.best!;
  return `${run} \u2014 the best here is still ${best.days} days, $${best.takings}`;
}

/**
 * What the landlord wants tonight, or what he is still owed.
 *
 * The debt is the louder of the two on purpose: an unpaid rent is one closing
 * time away from ending the run, and the morning is when it can still be fixed
 * — by serving well, or by selling something back to the stall.
 */
function rentNotice(world: World): string {
  if (world.money < 0)
    return `${money(world.money)} owed \u2014 clear it today or lose the kitchen`;
  const rent = rentFor(world.day);
  return rent > 0 ? `Rent $${rent} due at closing` : "";
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
