import { unlockedRecipes } from "../sim/cards";
import type { World } from "../sim/types";

/**
 * Pause menu.
 *
 * Controller-first: navigate with any player's stick or D-pad, confirm with A,
 * close with Start/Esc. It lives in the shell rather than the simulation —
 * `sim` has no concept of being paused, which keeps it a pure function of
 * inputs and stays compatible with a future authoritative server (where the
 * world cannot stop just because one client opened a menu).
 */

/**
 * Opening and closing are not in here.
 *
 * They were, twice over: "Open for day 4" and "Close up early" were the pause
 * menu's copy of a keypress that had nothing in the room behind it. Both are
 * the sign by the door now — see `sim/systems/sign.ts`. What is left is the
 * three things that are genuinely *about the session* rather than about the
 * restaurant: leaving the menu, running the day again, and starting over.
 */
export type MenuAction = "resume" | "restartDay" | "resetKitchen";

/** Actions the menu answers itself, because all they do is change the page. */
type PageAction = "recipes" | "controls" | "back";

type Page = "root" | "recipes" | "controls";

type MenuItem = { action: MenuAction | PageAction; label: string; hint?: string };

/**
 * The reference material lives here and nowhere else — a page each.
 *
 * The controls used to sit permanently on the playfield and the recipe steps on
 * the card outside, which is clutter for the ninety-nine percent of the time
 * you already know them. The menu is where you go when you *don't* know
 * something, so that is where they live.
 *
 * They are pages rather than blocks stacked under the actions because that is
 * what they became: a controls table wide enough to edit and a cookbook that
 * grows with the room made the pause menu a screenful you had to scroll to find
 * "Resume" in. One thing at a time, and `Esc` goes back rather than out.
 */

export class PauseMenu {
  /** Where the controls table is mounted. See `ui/controls.ts`. */
  readonly controlsRoot: HTMLElement;
  /** Run when the controls page is left, so it can drop a half-made rebind. */
  onControlsClosed: (() => void) | null = null;
  private root: HTMLElement;
  private list: HTMLElement;
  private title: HTMLElement;
  private recipes: HTMLElement;
  /** The menu the recipe list was last built for. */
  private menuSignature = "";
  private items: MenuItem[] = [];
  private page: Page = "root";
  /** Where the cursor was on the root page, so coming back lands on the way in. */
  private rootIndex = 0;
  /** A destructive action waiting for a second press. */
  private armed: MenuAction | null = null;
  private armedAt = 0;
  private index = 0;
  private open = false;
  private signature = "";

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <div class="card">
        <h1 data-title>Paused</h1>
        <ul data-list></ul>
        <div class="recipes" data-recipes hidden></div>
        <div class="controls" data-controls hidden></div>
      </div>
    `;
    this.controlsRoot = root.querySelector("[data-controls]")!;
    this.title = root.querySelector("[data-title]")!;
    this.list = root.querySelector("[data-list]")!;
    this.recipes = root.querySelector("[data-recipes]")!;
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(world: World): void {
    this.open = true;
    this.index = 0;
    this.rootIndex = 0;
    this.page = "root";
    this.root.classList.add("show");
    this.sync(world);
  }

  hide(): void {
    this.goto("root");
    this.open = false;
    this.armed = null;
    this.root.classList.remove("show");
  }

  /**
   * Back out one step. False means there was nowhere left to go.
   *
   * `Esc` and the pad's `B` mean "out of here", and on a sub-page here is the
   * page, not the game — closing the menu from the cookbook would drop you back
   * into a rush you had stepped out of to read.
   */
  back(): boolean {
    if (this.page === "root") return false;
    this.goto("root");
    return true;
  }

  private goto(page: Page): void {
    if (page === this.page) return;
    // A rebind waiting for a key is only meaningful on the page showing it.
    if (this.page === "controls") this.onControlsClosed?.();
    if (page === "root") this.index = this.rootIndex;
    else {
      this.rootIndex = this.index;
      this.index = 0;
    }
    this.page = page;
    this.disarm();
  }

  move(delta: number): void {
    if (this.items.length === 0) return;
    this.disarm();
    this.index = (this.index + delta + this.items.length) % this.items.length;
    this.paint();
  }

  /**
   * Confirming a destructive action asks a second time.
   *
   * Reset wipes the kitchen **for everyone in the room**, and the menu is
   * driven by whichever button also happens to mean "yes" everywhere else in
   * the game. One mis-timed press should not cost four people their layout.
   * Arming is cleared by moving, closing the menu, or a few seconds passing.
   */
  confirm(): MenuAction | null {
    const action = this.items[this.index]?.action ?? null;
    if (action === "recipes" || action === "controls") {
      this.goto(action);
      return null;
    }
    if (action === "back") {
      this.goto("root");
      return null;
    }
    if (action !== "resetKitchen") {
      this.armed = null;
      return action;
    }
    if (this.armed === action) {
      this.armed = null;
      return action;
    }
    this.armed = action;
    this.armedAt = Date.now();
    this.signature = "";
    return null;
  }

  private disarm(): void {
    if (!this.armed) return;
    this.armed = null;
    this.signature = "";
  }

  /** Menu contents depend on the phase, so rebuild when that changes. */
  sync(world: World): void {
    if (!this.open) return;
    // Arming times out: a menu left open on "are you sure?" should not still be
    // one press from wiping the kitchen when someone comes back to it.
    if (this.armed && Date.now() - this.armedAt > 4000) this.disarm();
    const items = this.itemsFor(world);

    // The page is part of the signature: the same labels on a different page
    // are a different list.
    const signature = [this.page, ...items.map((item) => item.label)].join("|");
    if (signature !== this.signature) {
      this.signature = signature;
      this.items = items;
      this.index = Math.min(this.index, items.length - 1);
      // Built as nodes rather than an HTML string. Every value here is an
      // internal literal today, but `Open for day ${world.day + 1}` is
      // interpolated simulation state, and "safe because of where the data
      // happens to come from" is not a property that survives a refactor.
      this.list.replaceChildren(
        ...items.map((item) => {
          const li = document.createElement("li");
          const label = document.createElement("span");
          label.textContent = item.label;
          const hint = document.createElement("em");
          hint.textContent = item.hint ?? "";
          li.append(label, hint);
          return li;
        }),
      );
    }

    this.title.textContent = this.titleFor(world);
    this.recipes.hidden = this.page !== "recipes";
    this.controlsRoot.hidden = this.page !== "controls";
    this.syncRecipes(world);
    this.paint();
  }

  private titleFor(world: World): string {
    if (this.page === "recipes") return "Recipes";
    if (this.page === "controls") return "Controls";
    return world.evicted
      ? "Closed down"
      : world.phase === "build"
        ? `Day ${world.day} closed`
        : "Paused";
  }

  private itemsFor(world: World): MenuItem[] {
    if (this.page !== "root") return [{ action: "back", label: "Back", hint: "Esc" }];

    const reference: MenuItem[] = [
      { action: "recipes", label: "Recipes", hint: "How every dish on your menu is made" },
      { action: "controls", label: "Controls", hint: "The keys, and where to change them" },
    ];

    return world.phase === "build"
      ? [
          {
            action: "resume",
            label: world.evicted ? "Look around" : "Keep building",
            hint: world.evicted ? "The kitchen is closed" : "Open up at the sign by the door",
          },
          ...reference,
          // The same action either way. An evicted room has exactly one way
          // forward and this is it, so it is named for what it now does
          // rather than for the layout it happens to restore.
          this.armed === "resetKitchen"
            ? {
                action: "resetKitchen" as const,
                label: world.evicted
                  ? "Start again — are you sure?"
                  : "Reset kitchen — are you sure?",
                hint: "Confirm again · wipes it for everyone",
              }
            : {
                action: "resetKitchen" as const,
                label: world.evicted ? "Start again" : "Reset kitchen",
                hint: world.evicted ? "A new kitchen, from day one" : "Back to the original layout",
              },
        ]
      : [
          { action: "resume", label: "Resume", hint: `Day ${world.day} in progress` },
          ...reference,
          { action: "restartDay", label: "Restart day", hint: "Empty the room and start over" },
        ];
  }

  /**
   * The cookbook: how to make everything this kitchen has unlocked.
   *
   * The steps used to be printed on the recipe card standing outside, which was
   * the wrong place twice over. It answered "how is this made" about a dish
   * nobody had bought yet, and it put a paragraph of instructions on an object
   * whose whole job is to be a picture. A chef wanting the method is asking
   * about **their own menu**, and the pause menu is already where the game's
   * other "how does this work" page lives — the controls table.
   *
   * Unlocked only, so it grows as the room does: a list that showed the whole
   * library would be a spoiler and a shopping list for dishes the kitchen
   * cannot cook.
   */
  private syncRecipes(world: World): void {
    const menu = unlockedRecipes(world);
    const signature = menu.map((recipe) => recipe.id).join("|");
    if (signature === this.menuSignature) return;
    this.menuSignature = signature;

    const head = document.createElement("div");
    head.className = "recipes-head";
    head.textContent = menu.length === 1 ? "On the menu" : `On the menu · ${menu.length} dishes`;

    // Nodes rather than an HTML string, for the reason the action list is: the
    // strings are content today and content is the thing that changes.
    this.recipes.replaceChildren(
      head,
      ...menu.map((recipe) => {
        const row = document.createElement("div");
        row.className = "recipes-row";
        const name = document.createElement("b");
        name.textContent = recipe.name;
        const steps = document.createElement("span");
        steps.textContent = recipe.steps.join(" \u2192 ");
        row.append(name, steps);
        return row;
      }),
    );
  }

  private paint(): void {
    const children = this.list.children;
    for (let i = 0; i < children.length; i++) {
      children[i]!.classList.toggle("selected", i === this.index);
    }
  }
}
