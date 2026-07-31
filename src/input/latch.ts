/**
 * A control that must be *released* before it counts again.
 *
 * This file exists because the same bug has now been written four times, and
 * the comment naming the general rule was sitting three lines above the fourth
 * instance the whole time:
 *
 * > a control which means two things either side of a boundary needs a latch
 * > that spans the boundary, never an edge test on one side of it.
 *
 * The four:
 *
 *  1. Holding `Esc` for two frames closed the pause menu and immediately
 *     reopened it — open and close each had their own edge detector.
 *  2. Picking "Close up early" closed the menu into the build phase, and the
 *     still-held `Enter` read as a fresh `start` and opened the next day. The
 *     menu item looked like it did nothing; the only trace was the day counter.
 *     (Both menu items have since become the sign by the door; the latch is
 *     what stops the confirm that closed the menu turning it.)
 *  3. The one-frame swallow written to fix (2) was not enough — a key is held
 *     for about six frames.
 *  4. On a gamepad, `B` is both *back* (closes the menu) and an alternate
 *     *use*. Closing the menu with it started chopping whatever you were
 *     facing. Keyboard was unaffected, so it survived every keyboard playtest.
 *
 * Each was fixed where it was found, with a fresh boolean and a fresh set of
 * rules about who clears it. Four booleans, four sets of rules, four bugs. One
 * type instead, testable without a DOM — which `main.ts` is not, and which is
 * why none of this was ever covered.
 */
export class Latch {
  private held = false;

  /**
   * True exactly once per press: on the transition from released to held.
   * Stays false for as long as the control is still down.
   */
  pressed(down: boolean): boolean {
    const fired = down && !this.held;
    this.held = down;
    return fired;
  }

  /**
   * Mark the control as already held, without firing.
   *
   * This is the part an edge detector cannot express, and the reason all four
   * bugs above were possible. When a press causes a boundary to be crossed, the
   * far side must be told the button is *already down* — otherwise it sees a
   * rising edge that never happened, because the press belonged to the near
   * side.
   */
  arm(): void {
    this.held = true;
  }

  /** Forget the press without firing. For when the control stops applying. */
  release(): void {
    this.held = false;
  }

  get isHeld(): boolean {
    return this.held;
  }
}
