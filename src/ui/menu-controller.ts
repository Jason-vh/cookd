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
  /** Pop a sub-page. False when there was nowhere to go, so the menu closes. */
  back(): boolean;
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

    // Both, every frame: `||` would short-circuit past one of the latches and
    // leave it believing a still-held button had been released.
    const menuPressed = this.menuKey.pressed(nav.menu);
    const backPressed = this.back.pressed(nav.back);

    // Leave before navigate: `back` and `menu` both back out, and a frame where
    // one of them is down is not also a frame that should move the cursor.
    if (menuPressed || backPressed) {
      // On the cookbook or the controls, out means back to the actions.
      if (!this.menu.back()) this.close();
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
      this.up.pressed(nav.up);
      this.down.pressed(nav.down);
      this.confirm.pressed(nav.confirm);
    }

    this.menu.sync(this.world());
  }

  /**
   * Filter a tick of gameplay input.
   *
   * Returns idle input while the menu is open. The world is **paused** as well
   * — that is `open`'s doing and it is a fact about the room, not about this
   * screen — but the two are separate on purpose: the pause is a request that
   * takes a round trip online, and the frames that land before it does must not
   * be driven by a chef whose player is reading the controls.
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
    // The whole kitchen stops, for everybody. Reading the controls during a
    // rush used to cost you the rush; now it costs the room a minute, and the
    // room can see whose minute it is.
    this.act("pause");
    // Everything that could have been down when the menu opened is armed, so
    // the menu does not immediately act on the press that opened it.
    this.menuKey.arm();
    this.confirm.arm();
    this.back.arm();
  }

  private close(): void {
    this.menu.hide();
    this.act("resume");
    // ...and symmetrically: the press that closed the menu must not reach the
    // kitchen. `menuKey` and `back` are already held; arming `confirm` covers
    // closing via a confirm-shaped action below.
    this.menuKey.arm();
    this.back.arm();
  }

  private run(): void {
    const chosen = this.menu.confirm();
    // Held across the boundary: `Enter` confirms *and* is `start`, and the
    // gamepad's `A` confirms *and* grabs — which is now also how the sign by the
    // door is turned. A confirm still held as the menu closes would otherwise
    // reach the kitchen as a fresh grab at whatever the chef is facing.
    this.confirm.arm();
    switch (chosen) {
      case "resume":
        this.close();
        return;
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
  return {
    move: { x: 0, y: 0 },
    grab: false,
    use: false,
    rotate: false,
    start: false,
    menu: false,
  };
}
