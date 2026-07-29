import type { MenuNav } from "../input";
import { Latch } from "../input/latch";
import type { Inputs, PlayerInput, World } from "../sim/types";
import type { MenuAction } from "../game/host";
import type { MenuAction as MenuChoice } from "./menu";

/**
 * What this controller needs from the pause menu, and nothing more.
 *
 * A narrow structural type rather than `PauseMenu` itself: the controller uses
 * six methods of a class with eleven fields, all of which are DOM. Naming the
 * six is what lets the boundary logic — which produced four bugs and had no
 * tests — be exercised without a browser.
 */
export type MenuView = {
  readonly isOpen: boolean;
  show(world: World): void;
  hide(): void;
  move(delta: number): void;
  confirm(): MenuChoice | null;
  sync(world: World): void;
};

/** Menu navigation is device-agnostic, so this is all of the input layer it needs. */
export type MenuInput = { pollMenu(): MenuNav };

/**
 * The pause menu's relationship with the rest of the controls.
 *
 * Split out of `main.ts`, where it was four module-level booleans
 * (`previousNav`, `menuKeyDown`, `confirmHeld`, `menuWasOpen`) encoding one
 * idea in four shapes, spread across seven sites, and untestable because
 * importing `main.ts` touches `window`. That combination produced the same bug
 * four times — see the note on `Latch`.
 *
 * The idea is small: **every control that means one thing in the menu and
 * another in play needs a single latch spanning the boundary.** There are three
 * such controls, so there are three latches and no other state.
 */
export class MenuController {
  /** Opens *and* closes. One key, one latch, or holding it does both. */
  private readonly menuKey = new Latch();
  /** Confirms in the menu; is `grab`/`start` in play. */
  private readonly confirm = new Latch();
  /** Closes the menu; is an alternate `use` on a gamepad. */
  private readonly back = new Latch();
  private readonly up = new Latch();
  private readonly down = new Latch();

  /**
   * `world` is a getter rather than a parameter threaded through every call.
   * The menu needs the world only to render its own labels ("Open for day 4"),
   * and making the input path carry it would put a simulation argument on
   * `filter`, which is about buttons.
   */
  constructor(
    private readonly menu: MenuView,
    private readonly world: () => World,
    private readonly act: (action: MenuAction) => void,
    private readonly reset: () => void,
  ) {}

  get isOpen(): boolean {
    return this.menu.isOpen;
  }

  /**
   * Drive the menu itself, once per frame, while it is open.
   *
   * Navigation is device-agnostic (`pollMenu` reads every keyboard scheme and
   * every pad), so it does not go through per-player inputs.
   */
  update(input: MenuInput): void {
    if (!this.menu.isOpen) return;
    const nav = input.pollMenu();

    // Close before navigate: `back` and `menu` both close, and a frame where
    // one of them is down is not also a frame that should move the cursor.
    if (this.menuKey.pressed(nav.menu) || this.back.pressed(nav.back)) {
      this.close();
    } else if (this.up.pressed(nav.up)) {
      this.menu.move(-1);
    } else if (this.down.pressed(nav.down)) {
      this.menu.move(1);
    } else if (this.confirm.pressed(nav.confirm)) {
      this.run();
    } else {
      // Not an else-if chain by accident: the latches above only advance for
      // the branch that was taken, so anything not tested this frame has to be
      // told the control is still down or it will fire late.
      this.menuKey.pressed(nav.menu);
      this.back.pressed(nav.back);
      this.up.pressed(nav.up);
      this.down.pressed(nav.down);
      this.confirm.pressed(nav.confirm);
    }

    this.menu.sync(this.world());
  }

  /**
   * Filter a tick of gameplay input.
   *
   * Returns idle input while the menu is open — the world keeps running, online
   * it has to, so pausing means "your chef stands still" rather than "time
   * stops for four people". Otherwise it blanks any control that is still held
   * over from the menu.
   */
  filter(inputs: Inputs, localIds: readonly number[]): Inputs {
    if (this.menu.isOpen) return blank(inputs);

    // Opening is checked here rather than in `update`, because the menu key is
    // read from *gameplay* input when the menu is closed and from `pollMenu`
    // when it is open. One latch spans that, which is the entire lesson.
    const menuDown = localIds.some((id) => inputs[id]?.menu === true);
    if (this.menuKey.pressed(menuDown)) {
      this.open();
      return blank(inputs);
    }

    // Anything held across the boundary is swallowed until it is released.
    // `use` is in here because on a gamepad `B` is both *back* and *use*: the
    // button that dismissed the menu would otherwise start chopping whatever
    // the chef happened to be facing, for the six or so frames a press lasts.
    const swallowConfirm = this.confirm.isHeld;
    const swallowBack = this.back.isHeld;
    let confirmDown = false;
    let backDown = false;

    for (const id of localIds) {
      const one = inputs[id];
      if (!one) continue;
      if (swallowConfirm) {
        confirmDown ||= one.grab || one.start;
        one.grab = false;
        one.start = false;
      }
      if (swallowBack) {
        backDown ||= one.use;
        one.use = false;
      }
    }

    if (swallowConfirm && !confirmDown) this.confirm.release();
    if (swallowBack && !backDown) this.back.release();
    return inputs;
  }

  private open(): void {
    this.menu.show(this.world());
    // Everything that could have been down when the menu opened is armed, so
    // the menu does not immediately act on the press that opened it.
    this.menuKey.arm();
    this.confirm.arm();
    this.back.arm();
  }

  private close(): void {
    this.menu.hide();
    // ...and symmetrically: the press that closed the menu must not reach the
    // kitchen. `menuKey` and `back` are already held; arming `confirm` covers
    // closing via a confirm-shaped action below.
    this.menuKey.arm();
    this.back.arm();
  }

  private run(): void {
    const chosen = this.menu.confirm();
    // Held across the boundary: `Enter` confirms *and* is `start`, and the
    // gamepad's `A` confirms *and* grabs. "Close up early" once closed the menu
    // into the build phase and then, still held, read as a fresh `start` and
    // opened the next day — so the menu item looked like it did nothing at all.
    this.confirm.arm();
    switch (chosen) {
      case "resume":
        this.close();
        return;
      case "startDay":
      case "endDay":
      case "restartDay":
        this.act(chosen);
        this.close();
        return;
      case "resetKitchen":
        this.reset();
        this.close();
        return;
      default:
        return;
    }
  }
}

/** Every seat, standing perfectly still. */
function blank(inputs: Inputs): Inputs {
  const out: Inputs = {};
  for (const [id, input] of Object.entries(inputs)) {
    if (input) out[Number(id)] = idle(input);
  }
  return out;
}

function idle(from: PlayerInput): PlayerInput {
  void from;
  return { move: { x: 0, y: 0 }, grab: false, use: false, start: false, menu: false };
}
