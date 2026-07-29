import { beforeEach, describe, expect, test } from "bun:test";
import { InputManager } from "./index";

/**
 * The input layer normally needs a browser, but the gamepad-to-player binding
 * is pure bookkeeping and is exactly where a bug cost us a kitchen full of
 * chefs. Stubbing `navigator.getGamepads` is enough to drive it.
 */

type FakePad = { index: number; buttons: { pressed: boolean }[]; axes: number[] };

function pad(index: number, pressed = false): FakePad {
  return { index, buttons: [{ pressed }], axes: [0, 0] };
}

/**
 * Stub the two browser globals `InputManager` reaches for.
 *
 * `defineProperty` rather than assignment, and rather than the
 * `globalThis as unknown as { navigator: unknown }` this used to be. That cast
 * compiled whatever shape the test claimed, so a stub could drift from what the
 * source actually calls and still typecheck — the exact failure mode a test
 * stub exists to catch. `navigator` is also not guaranteed writable, so plain
 * assignment was relying on Bun being lenient about it.
 */
function defineGlobal(name: string, value: object): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function setPads(pads: FakePad[]): void {
  defineGlobal("navigator", { getGamepads: (): FakePad[] => pads });
}

function stubWindow(): void {
  defineGlobal("window", { addEventListener: (): void => {} });
}

describe("gamepad seating", () => {
  beforeEach(() => {
    stubWindow();
    setPads([]);
  });

  test("a connected but untouched pad does not create a player", () => {
    const input = new InputManager();
    setPads([pad(0, false)]);
    let joins = 0;
    input.bindGamepads([], () => {
      joins++;
      return 1;
    });
    expect(joins).toBe(0);
  });

  test("a pad takes a free seat without creating anything", () => {
    const input = new InputManager();
    setPads([pad(0, true)]);
    let joins = 0;
    input.bindGamepads([7], () => {
      joins++;
      return 99;
    });
    expect(joins).toBe(0);
  });

  test("a pressed pad with no free seat asks for exactly one", () => {
    const input = new InputManager();
    setPads([pad(0, true)]);
    let joins = 0;
    input.bindGamepads([0], () => {
      joins++;
      return 1;
    });
    // Seat 0 is free on the first call, so the pad simply takes it.
    expect(joins).toBe(0);

    setPads([pad(0, true), pad(1, true)]);
    input.bindGamepads([0], () => {
      joins++;
      return 1;
    });
    expect(joins).toBe(1);
  });

  /**
   * The one that mattered. Online, `addPlayer` returns null because the server
   * owns player ids and answers a round trip later. Until it does, the pad
   * still has no seat — and asking again every frame created a chef per frame.
   * One controller filled a four-player kitchen in under a second.
   */
  test("a pending online join is asked for once, not once per frame", () => {
    const input = new InputManager();
    setPads([pad(0, true)]);
    let joins = 0;
    const askServer = (): number | null => {
      joins++;
      return null; // the server will answer later
    };

    // Eleven frames — roughly one 180ms round trip at 60fps.
    for (let frame = 0; frame < 11; frame++) input.bindGamepads([], askServer);
    expect(joins).toBe(1);

    // The server answers: the roster grows, and the pad takes the new seat.
    input.bindGamepads([4], askServer);
    expect(joins).toBe(1);

    // A second pad may now ask for its own.
    setPads([pad(0, true), pad(1, true)]);
    for (let frame = 0; frame < 5; frame++) input.bindGamepads([4], askServer);
    expect(joins).toBe(2);
  });
});
