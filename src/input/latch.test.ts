import { describe, expect, test } from "bun:test";
import { Latch } from "./latch";

/**
 * The four bugs this type exists to prevent are listed in `latch.ts`. Each was
 * fixed where it was found, with a fresh boolean and fresh rules about who
 * clears it, and none of it was ever tested — because it all lived in
 * `main.ts`, which cannot be imported without a DOM.
 */
describe("Latch", () => {
  test("fires once per press, however long it is held", () => {
    const latch = new Latch();
    expect(latch.pressed(true)).toBe(true);
    // A key is held for about six frames at 60Hz. A one-frame swallow was
    // written to handle that once, and was not enough.
    for (let i = 0; i < 10; i++) expect(latch.pressed(true)).toBe(false);
  });

  test("fires again only after a release", () => {
    const latch = new Latch();
    expect(latch.pressed(true)).toBe(true);
    expect(latch.pressed(false)).toBe(false);
    expect(latch.pressed(true)).toBe(true);
  });

  test("an armed latch swallows the press that armed it", () => {
    // This is the part an edge detector cannot express, and the reason all four
    // bugs were possible: when a press causes a boundary to be crossed, the far
    // side has to be told the button is *already down*, or it sees a rising
    // edge that never happened.
    const latch = new Latch();
    latch.arm();
    expect(latch.pressed(true)).toBe(false);
    expect(latch.isHeld).toBe(true);

    expect(latch.pressed(false)).toBe(false);
    expect(latch.pressed(true)).toBe(true);
  });

  test("release forgets a press without firing", () => {
    const latch = new Latch();
    latch.pressed(true);
    latch.release();
    expect(latch.isHeld).toBe(false);
    expect(latch.pressed(true)).toBe(true);
  });

  test("holding across a boundary cannot re-trigger on the far side", () => {
    // Bug 1: holding `Esc` for two frames closed the pause menu and immediately
    // reopened it, because open and close each had their own edge detector.
    const menuKey = new Latch();

    let open = false;
    const frame = (down: boolean): void => {
      if (menuKey.pressed(down)) open = !open;
    };

    frame(true); // press: opens
    expect(open).toBe(true);
    frame(true); // still held
    frame(true);
    expect(open).toBe(true);
    frame(false); // released
    frame(true); // pressed again: closes
    expect(open).toBe(false);
  });
});
