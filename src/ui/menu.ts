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

type MenuItem = { action: MenuAction; label: string; hint?: string };

/**
 * The controls live here and nowhere else.
 *
 * They used to sit permanently on the playfield, which is clutter for the
 * ninety-nine percent of the time you already know them. The menu is where you
 * go when you *don't* know something, so that is where they live — and now that
 * they can be changed, where you go to change them. The table itself is
 * `ControlsPanel`, mounted into this element: it is generated from the
 * bindings, which is the only way it can be trusted to be true.
 */

export class PauseMenu {
  /** Where the controls table is mounted. See `ui/controls.ts`. */
  readonly controlsRoot: HTMLElement;
  /** Run when the menu closes, so the controls table can drop a half-made rebind. */
  onHide: (() => void) | null = null;
  private root: HTMLElement;
  private list: HTMLElement;
  private title: HTMLElement;
  private items: MenuItem[] = [];
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
        <div class="controls" data-controls></div>
      </div>
    `;
    this.controlsRoot = root.querySelector("[data-controls]")!;
    this.title = root.querySelector("[data-title]")!;
    this.list = root.querySelector("[data-list]")!;
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(world: World): void {
    this.open = true;
    this.index = 0;
    this.root.classList.add("show");
    this.sync(world);
  }

  hide(): void {
    this.onHide?.();
    this.open = false;
    this.armed = null;
    this.root.classList.remove("show");
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
    const items: MenuItem[] =
      world.phase === "build"
        ? [
            {
              action: "resume",
              label: world.evicted ? "Look around" : "Keep building",
              hint: world.evicted ? "The kitchen is closed" : "Open up at the sign by the door",
            },
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
                  hint: world.evicted
                    ? "A new kitchen, from day one"
                    : "Back to the original layout",
                },
          ]
        : [
            { action: "resume", label: "Resume", hint: `Day ${world.day} in progress` },
            { action: "restartDay", label: "Restart day", hint: "Empty the room and start over" },
          ];

    const signature = items.map((item) => item.label).join("|");
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

    this.title.textContent = world.evicted
      ? "Closed down"
      : world.phase === "build"
        ? `Day ${world.day} closed`
        : "Paused";
    this.paint();
  }

  private paint(): void {
    const children = this.list.children;
    for (let i = 0; i < children.length; i++) {
      children[i]!.classList.toggle("selected", i === this.index);
    }
  }
}
