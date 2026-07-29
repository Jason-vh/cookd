import type { InputManager } from "../input";
import type { Identity } from "../identity";

/**
 * The first thing you see: who you are, and which kitchen.
 *
 * Deliberately tiny. A cooking game with friends should be one field and one
 * button away from playing, and the room code doubles as the URL — sharing the
 * link is the whole invite flow.
 *
 * There is no "how many of you" question. Extra players join by pressing `P` or
 * picking up a controller, which is how couch co-op actually starts — someone
 * wanders in halfway through. Asking up front made you answer a question about
 * a game you had not seen yet, and the answer was already changeable.
 */

type Options = {
  identity: Identity;
  /** Room parsed out of the URL hash, if any. */
  room: string;
  offline: boolean;
  onPlayLocal: () => void;
  onPlayOnline: (room: string, name: string) => void;
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
  private readonly listeners = new AbortController();

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
        <label>Your name<input id="join-name" maxlength="16" placeholder="Chef" autocomplete="off"></label>
        <label>Kitchen code<input id="join-room" maxlength="8" placeholder="MAIN" autocomplete="off"></label>
        <div class="join-actions">
          <button id="join-online" class="primary">Join kitchen</button>
          <button id="join-local">Play offline</button>
        </div>
        <p class="join-hint">Share the page URL to invite someone.</p>
      </div>`;

    this.nameField = this.root.querySelector<HTMLInputElement>("#join-name")!;
    this.roomField = this.root.querySelector<HTMLInputElement>("#join-room")!;

    this.nameField.value = identity.name;
    this.roomField.value = room || identity.room || randomRoom();

    // One signal for every listener, so `dispose` cannot detach some of them
    // and leave others. The keydown handler in particular outlived the screen
    // it belongs to, which is harmless for a process-lifetime singleton and
    // exactly the sort of thing that stops being harmless later.
    const { signal } = this.listeners;
    this.root
      .querySelector("#join-online")
      ?.addEventListener("click", () => this.confirmOnline(), { signal });
    this.root.querySelector("#join-local")?.addEventListener(
      "click",
      () => {
        this.hide();
        this.options.onPlayLocal();
      },
      { signal },
    );
    this.root.addEventListener(
      "keydown",
      (event: KeyboardEvent) => {
        if (event.key === "Enter") this.confirmOnline();
      },
      { signal },
    );
  }

  dispose(): void {
    this.listeners.abort();
  }

  private confirmOnline(): void {
    const room = (this.roomField.value || "MAIN")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
    const name = this.nameField.value.trim().slice(0, 16) || "Chef";
    this.hide();
    this.options.onPlayOnline(room || "MAIN", name);
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
