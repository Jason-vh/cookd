import { DEFAULT_APPEARANCE, type Appearance } from "../data/chefs";
import type { Inputs, World } from "../sim/types";
import type { Game } from "./game";
import { Host, type MenuAction } from "./host";
import type { Save } from "../save";
import { LEVEL, type LevelDef } from "../data/level";

const MAX_LOCAL_PLAYERS = 4;

/**
 * Offline play: the `Host` runs right here in the tab.
 *
 * Worth keeping even once the server exists. It is how the whole game has been
 * debugged so far, it makes `bun run dev` instant with no backend, and it is the
 * fallback when the server is unreachable — a cooking game that refuses to start
 * because a VPS is down would be a poor trade for co-op.
 */
export class LocalGame implements Game {
  readonly localIds: number[] = [];
  readonly ping = null;
  readonly status = "local" as const;

  private host: Host;

  constructor(
    save?: Save | null,
    players = 1,
    level: LevelDef = LEVEL,
    look: Appearance = DEFAULT_APPEARANCE,
  ) {
    this.host = new Host(save, level);
    // Everyone on this sofa asked for the same outfit, because they share a
    // browser. `addPlayer` hands out the free ones — see `pickOutfit`.
    for (let i = 0; i < players; i++) this.localIds.push(this.host.join("", look));
  }

  get world(): World {
    return this.host.world;
  }

  get level(): LevelDef {
    return this.host.level;
  }

  get alpha(): number {
    return this.host.alpha;
  }

  update(elapsed: number, poll: () => Inputs): void {
    this.host.advance(elapsed, { poll });
  }

  addLocalPlayer(name: string, look: Appearance = DEFAULT_APPEARANCE): number | null {
    if (this.localIds.length >= MAX_LOCAL_PLAYERS) return null;
    const id = this.host.join(name, look);
    this.localIds.push(id);
    return id;
  }

  removeLocalPlayer(id: number): void {
    const index = this.localIds.indexOf(id);
    if (index === -1) return;
    this.localIds.splice(index, 1);
    this.host.leave(id);
  }

  menu(action: MenuAction): void {
    this.host.menu(action, this.localIds[0]);
  }

  reset(): void {
    // Host.reset keeps everyone's id, so our local ids stay valid.
    this.host.reset();
  }

  dispose(): void {}
}
