import { describe, expect, test } from "bun:test";
import { MenuController } from "./menu-controller";
import type { MenuAction } from "../game/host";
import type { MenuAction as MenuChoice } from "./menu";
import { createWorld } from "../sim/world";
import { LEVEL } from "../data/level";
import type { Inputs, PlayerInput } from "../sim/types";
import type { MenuNav } from "../input";

/**
 * The boundary between the pause menu and the kitchen, tested without a DOM.
 *
 * This logic produced four bugs and had no tests, because it lived in
 * `main.ts` — a file that touches `window` at import time. `PauseMenu` and
 * `InputManager` are stood in for here by the two small surfaces this
 * controller actually uses.
 */

const NO_NAV: MenuNav = { up: false, down: false, confirm: false, menu: false, back: false };

/** Just enough `PauseMenu` to drive the controller. */
function fakeMenu(chosen: MenuChoice | null = null) {
  const state = { open: false, moved: 0, confirms: 0 };
  const menu = {
    get isOpen() {
      return state.open;
    },
    show: () => {
      state.open = true;
    },
    hide: () => {
      state.open = false;
    },
    move: (delta: number) => {
      state.moved += delta;
    },
    confirm: () => {
      state.confirms++;
      return chosen;
    },
    sync: () => {},
  };
  return { menu, state };
}

function controller(chosen: MenuChoice | null = null) {
  const { menu, state } = fakeMenu(chosen);
  const acted: MenuAction[] = [];
  let resets = 0;
  const control = new MenuController(
    menu,
    () => createWorld(LEVEL, 0),
    (action: MenuAction) => acted.push(action),
    () => {
      resets++;
    },
  );
  return { control, state, acted, resets: () => resets, menu };
}

function nav(control: MenuController, partial: Partial<MenuNav>): void {
  control.update({ pollMenu: () => ({ ...NO_NAV, ...partial }) });
}

function play(control: MenuController, partial: Partial<PlayerInput>): Inputs {
  const one: PlayerInput = {
    move: { x: 0, y: 0 },
    grab: false,
    use: false,
    start: false,
    menu: false,
    ...partial,
  };
  return control.filter({ 0: one }, [0]);
}

describe("opening and closing", () => {
  test("holding the menu key does not close the menu it just opened", () => {
    // Bug 1. Two edge detectors, one on each side of the boundary, so holding
    // `Esc` for two frames opened and immediately closed it again.
    const { control, state } = controller();
    play(control, { menu: true });
    expect(state.open).toBe(true);

    for (let i = 0; i < 6; i++) nav(control, { menu: true });
    expect(state.open).toBe(true);

    nav(control, {}); // released
    nav(control, { menu: true });
    expect(state.open).toBe(false);
  });

  test("the world keeps running, but your chef stands still", () => {
    // Pausing cannot mean "time stops" — online one player cannot stop a
    // kitchen four people are standing in — so it means the same thing offline.
    const { control } = controller();
    play(control, { menu: true });
    const inputs = play(control, { move: { x: 1, y: 0 }, grab: true });
    expect(inputs[0]).toEqual({
      move: { x: 0, y: 0 },
      grab: false,
      use: false,
      start: false,
      menu: false,
    });
  });
});

describe("controls that mean two things", () => {
  test("the button that confirmed a menu item does not then grab", () => {
    // Bug 2. `Enter` confirms *and* is `start`; the pad's `A` confirms *and*
    // grabs — which is also how the sign by the door is turned. "Close up
    // early" closed the menu and the still-held key read as a fresh press in
    // the kitchen, so the menu item looked like it had done nothing at all.
    const { control, state, acted } = controller("restartDay");
    play(control, { menu: true });
    nav(control, {}); // release the key that opened it
    nav(control, { confirm: true });
    expect(acted).toEqual(["restartDay"]);
    expect(state.open).toBe(false);

    // Six frames of the key still being down, which is how long a press lasts.
    for (let i = 0; i < 6; i++) {
      expect(play(control, { grab: true, start: true })[0]?.start).toBe(false);
    }
    // Released, then pressed again: now it is a real press.
    play(control, {});
    expect(play(control, { start: true })[0]?.start).toBe(true);
  });

  test("closing the menu with the gamepad's B does not start chopping", () => {
    // Bug 4, and the one that had no test. On a pad, `B` is both *back* (closes
    // the menu) and an alternate *use*. The swallow covered `grab` and `start`
    // only, so dismissing the menu ran the appliance the chef was facing for
    // the six or so frames the button stayed down. Keyboard was unaffected,
    // which is why it survived every playtest.
    const { control, state } = controller();
    play(control, { menu: true });
    nav(control, {});
    nav(control, { back: true });
    expect(state.open).toBe(false);

    for (let i = 0; i < 6; i++) {
      expect(play(control, { use: true })[0]?.use).toBe(false);
    }
    play(control, {});
    expect(play(control, { use: true })[0]?.use).toBe(true);
  });

  test("a control held from before the menu opened is not swallowed forever", () => {
    const { control } = controller();
    play(control, { menu: true });
    nav(control, {});
    nav(control, { back: true });
    // One release is all it takes.
    play(control, {});
    expect(play(control, { use: true, grab: true })[0]).toMatchObject({
      use: true,
      grab: true,
    });
  });
});

describe("navigation", () => {
  test("moves once per press, not once per frame", () => {
    const { control, state } = controller();
    play(control, { menu: true });
    nav(control, {});
    for (let i = 0; i < 5; i++) nav(control, { down: true });
    expect(state.moved).toBe(1);
    nav(control, {});
    nav(control, { down: true });
    expect(state.moved).toBe(2);
  });

  test("a reset goes through the reset path, not the menu-action path", () => {
    const { control, acted, resets } = controller("resetKitchen");
    play(control, { menu: true });
    nav(control, {});
    nav(control, { confirm: true });
    expect(acted).toEqual([]);
    expect(resets()).toBe(1);
  });

  test("nothing happens while the menu is closed", () => {
    const { control, state } = controller();
    nav(control, { down: true, confirm: true });
    expect(state.moved).toBe(0);
    expect(state.confirms).toBe(0);
  });
});
