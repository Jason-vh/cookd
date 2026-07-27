import type { Inputs, World } from "../sim/types";
import type { MenuAction } from "./host";

/**
 * What the shell needs from a game, whether it is running locally or on a
 * server on another continent.
 *
 * `world` is always a real `World`, which is why the renderer never had to
 * learn that multiplayer exists: online it is assembled from snapshots, offline
 * it is the live simulation. `alpha` means the same thing in both — how far to
 * interpolate towards the newest state.
 */
export interface Game {
  readonly world: World;
  readonly alpha: number;
  /** Player ids driven by this browser. */
  readonly localIds: number[];
  /** Null when there is no network, otherwise round-trip time in ms. */
  readonly ping: number | null;
  readonly status: "local" | "connecting" | "online" | "offline";

  /**
   * Advance by `elapsed` seconds.
   *
   * `poll` is a *function*, deliberately, and is called **once per tick** — not
   * once per frame. A frame can legitimately run zero ticks (120Hz display,
   * 60Hz simulation), and the input layer clears its "pressed since last poll"
   * buffer every time it is asked. Polling once per frame therefore throws away
   * quick taps: press and release inside one frame, and the grab never happened.
   */
  update(elapsed: number, poll: () => Inputs): void;
  addLocalPlayer(name: string): number | null;
  removeLocalPlayer(id: number): void;
  menu(action: MenuAction): void;
  reset(): void;
  dispose(): void;
}
