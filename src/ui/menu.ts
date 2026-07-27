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

export type MenuAction = "resume" | "startDay" | "endDay" | "restartDay" | "resetKitchen";

type MenuItem = { action: MenuAction; label: string; hint?: string };

export class PauseMenu {
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
      </div>
    `;
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
            { action: "startDay", label: `Open for day ${world.day + 1}`, hint: "Start service" },
            { action: "resume", label: "Keep building", hint: "Back to the kitchen" },
            this.armed === "resetKitchen"
              ? {
                  action: "resetKitchen" as const,
                  label: "Reset kitchen — are you sure?",
                  hint: "Confirm again · wipes it for everyone",
                }
              : {
                  action: "resetKitchen" as const,
                  label: "Reset kitchen",
                  hint: "Back to the original layout",
                },
          ]
        : [
            { action: "resume", label: "Resume", hint: `Day ${world.day} in progress` },
            { action: "endDay", label: "Close up early", hint: "Skip to rearranging" },
            { action: "restartDay", label: "Restart day", hint: "Clear orders and start over" },
          ];

    const signature = items.map((item) => item.label).join("|");
    if (signature !== this.signature) {
      this.signature = signature;
      this.items = items;
      this.index = Math.min(this.index, items.length - 1);
      this.list.replaceChildren(
        ...items.map((item) => {
          const li = document.createElement("li");
          li.innerHTML = `<span>${item.label}</span><em>${item.hint ?? ""}</em>`;
          return li;
        }),
      );
    }

    this.title.textContent = world.phase === "build" ? `Day ${world.day} closed` : "Paused";
    this.paint();
  }

  private paint(): void {
    const children = this.list.children;
    for (let i = 0; i < children.length; i++) {
      children[i]!.classList.toggle("selected", i === this.index);
    }
  }
}
