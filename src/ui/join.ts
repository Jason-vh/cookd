import type { InputManager } from "../input";
import type { Identity } from "../identity";

/**
 * The first thing you see: who you are, which kitchen, how many of you.
 *
 * Deliberately tiny. A cooking game with friends should be one field and one
 * button away from playing, and the room code doubles as the URL — sharing the
 * link is the whole invite flow.
 */

type Options = {
  identity: Identity;
  /** Room parsed out of the URL hash, if any. */
  room: string;
  offline: boolean;
  onPlayLocal: (players: number) => void;
  onPlayOnline: (room: string, name: string, players: number) => void;
};

function randomRoom(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  let code = "";
  for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  return code;
}

export class JoinScreen {
  isOpen = false;

  private readonly root: HTMLElement;
  private readonly options: Options;
  private nameField!: HTMLInputElement;
  private roomField!: HTMLInputElement;
  private playersField!: HTMLSelectElement;

  constructor(root: HTMLElement, options: Options) {
    this.root = root;
    this.options = options;
    this.build();
  }

  private build(): void {
    const { identity, room } = this.options;
    this.root.innerHTML = `
      <div class="join-card">
        <h1>cookd</h1>
        <p class="join-sub">Local co-op, online co-op, same kitchen.</p>
        <label>Your name<input id="join-name" maxlength="16" placeholder="Chef" autocomplete="off"></label>
        <label>Kitchen code<input id="join-room" maxlength="8" placeholder="MAIN" autocomplete="off"></label>
        <label>Players on this screen
          <select id="join-players">
            <option value="1">1</option><option value="2">2</option>
            <option value="3">3</option><option value="4">4</option>
          </select>
        </label>
        <div class="join-actions">
          <button id="join-online" class="primary">Join kitchen</button>
          <button id="join-local">Play offline</button>
        </div>
        <p class="join-hint">Share the page URL to invite someone. Anyone can reset the kitchen.</p>
      </div>`;

    this.nameField = this.root.querySelector<HTMLInputElement>("#join-name")!;
    this.roomField = this.root.querySelector<HTMLInputElement>("#join-room")!;
    this.playersField = this.root.querySelector<HTMLSelectElement>("#join-players")!;

    this.nameField.value = identity.name;
    this.roomField.value = room || identity.room || randomRoom();
    this.playersField.value = String(identity.players);

    this.root.querySelector("#join-online")!.addEventListener("click", () => this.confirmOnline());
    this.root.querySelector("#join-local")!.addEventListener("click", () => {
      this.hide();
      this.options.onPlayLocal(this.players());
    });
    this.root.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") this.confirmOnline();
    });
  }

  private players(): number {
    return Math.min(4, Math.max(1, Number(this.playersField.value) || 1));
  }

  private confirmOnline(): void {
    const room = (this.roomField.value || "MAIN").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    const name = this.nameField.value.trim().slice(0, 16) || "Chef";
    this.hide();
    this.options.onPlayOnline(room || "MAIN", name, this.players());
  }

  show(): void {
    this.isOpen = true;
    this.root.classList.add("open");
    setTimeout(() => this.nameField.focus(), 0);
  }

  hide(): void {
    this.isOpen = false;
    this.root.classList.remove("open");
  }

  /** Gamepad `A` also confirms, so a controller-only player can get in. */
  poll(input: InputManager): void {
    const nav = input.pollMenu();
    if (nav.confirm) this.confirmOnline();
  }
}
