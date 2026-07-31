import { DEFAULT_LEVEL_ID, LEVELS } from "../data/level";
import type { InputManager } from "../input";
import type { Identity } from "../identity";

/**
 * The first thing you see, and it asks one question at a time.
 *
 * There are two entirely different things a person can be doing here — *making*
 * a kitchen, or walking into one that already exists — and they need different
 * answers. Making one asks where it is; joining one cannot, because the place a
 * kitchen stands in is fixed the day it is built. The screen used to put both
 * on one form behind one button, so "Where" was heeded or silently ignored
 * depending on whether the code you typed happened to be taken.
 *
 * The URL decides which you get: a link with a room in it is an invitation, and
 * has nothing left to ask but your name. A bare URL is someone starting out.
 * Either side can switch to the other, because sometimes the code arrives by
 * voice rather than by link.
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
  onPlayLocal: (level: string) => void;
  /**
   * `level` is empty when joining: only the person making a kitchen gets an
   * opinion about where it is, and a control that is sometimes ignored should
   * not be on the screen in the first place.
   */
  onPlayOnline: (room: string, name: string, level: string) => void;
};

type Mode = "create" | "join";

/** Every kitchen the game knows about, named. Levels are content, not a menu. */
function levelOptions(): string {
  return Object.values(LEVELS)
    .map((level) => `<option value="${level.id}">${level.name}</option>`)
    .join("");
}

function randomRoom(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  let code = "";
  for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  return code;
}

/**
 * A room code out of whatever was typed, pasted or shared.
 *
 * Codes are read aloud as often as they are clicked, so the field takes the
 * whole invite URL as happily as the four letters at the end of it.
 */
function parseCode(raw: string): string {
  return (raw.split("#").pop() ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

export class JoinScreen {
  isOpen = false;

  private readonly root: HTMLElement;
  private readonly options: Options;
  private card!: HTMLElement;
  private nameField!: HTMLInputElement;
  private codeField!: HTMLInputElement;
  private levelField!: HTMLSelectElement;
  private mode: Mode = "create";
  /** The code came from the link, so it is a fact rather than a question. */
  private readonly linked: boolean;
  private readonly listeners = new AbortController();

  constructor(root: HTMLElement, options: Options) {
    this.root = root;
    this.options = options;
    this.linked = options.room !== "";
    this.mode = this.linked ? "join" : "create";
    this.build();
  }

  private build(): void {
    const { identity, room } = this.options;
    const rejoin = identity.room ? `Rejoin ${identity.room}` : "Got a code from a friend?";
    this.root.innerHTML = `
      <div class="join-card">
        <h1>cookd</h1>
        <label>Your name<input id="join-name" maxlength="16" placeholder="Chef" autocomplete="off"></label>

        <section data-pane="create">
          <label>Where<select id="join-level">${levelOptions()}</select></label>
          <div class="join-actions">
            <button id="join-start" class="primary">Start a kitchen</button>
            <button id="join-local">Play offline</button>
          </div>
          <p class="join-hint">
            A new kitchen gets a code of its own, and the page URL becomes the
            invite — share it and they walk straight in.
          </p>
          <button class="join-switch" id="join-to-join">${rejoin}</button>
        </section>

        <section data-pane="join">
          <label data-code-entry>Kitchen code<input id="join-room" maxlength="40" placeholder="ABCD or a link" autocomplete="off"></label>
          <p class="join-code" data-code></p>
          <div class="join-actions">
            <button id="join-enter" class="primary">Join kitchen</button>
          </div>
          <p class="join-hint">
            A kitchen keeps the place it was built in, so there is nothing to
            choose — just walk in.
          </p>
          <button class="join-switch" id="join-to-create">Start your own instead</button>
        </section>
      </div>`;

    this.card = this.root.querySelector(".join-card")!;
    this.nameField = this.root.querySelector<HTMLInputElement>("#join-name")!;
    this.codeField = this.root.querySelector<HTMLInputElement>("#join-room")!;
    this.levelField = this.root.querySelector<HTMLSelectElement>("#join-level")!;

    this.nameField.value = identity.name;
    this.codeField.value = room || identity.room;
    this.root.querySelector("[data-code]")!.textContent = room;
    this.levelField.value = LEVELS[identity.level] ? identity.level : DEFAULT_LEVEL_ID;

    // One signal for every listener, so `dispose` cannot detach some of them
    // and leave others. The keydown handler in particular outlived the screen
    // it belongs to, which is harmless for a process-lifetime singleton and
    // exactly the sort of thing that stops being harmless later.
    const { signal } = this.listeners;
    const on = (id: string, run: () => void): void => {
      this.root.querySelector(`#${id}`)?.addEventListener("click", run, { signal });
    };
    on("join-start", () => this.create());
    on("join-enter", () => this.join());
    on("join-local", () => {
      this.hide();
      this.options.onPlayLocal(this.levelField.value);
    });
    on("join-to-join", () => this.setMode("join"));
    on("join-to-create", () => this.setMode("create"));
    this.root.addEventListener(
      "keydown",
      (event: KeyboardEvent) => {
        if (event.key === "Enter") this.confirm();
      },
      { signal },
    );

    this.paint();
  }

  dispose(): void {
    this.listeners.abort();
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.paint();
    const field = mode === "join" && !this.linked ? this.codeField : this.nameField;
    field.focus();
  }

  private paint(): void {
    this.card.dataset.mode = this.mode;
    // Arriving by link, the code is not a question: showing it as an editable
    // field would invite an answer nobody asked for.
    this.card.classList.toggle("linked", this.linked);
  }

  /** Whichever button this side of the screen means "yes". */
  private confirm(): void {
    if (this.mode === "create") this.create();
    else this.join();
  }

  private chefName(): string {
    return this.nameField.value.trim().slice(0, 16) || "Chef";
  }

  private create(): void {
    this.hide();
    this.options.onPlayOnline(randomRoom(), this.chefName(), this.levelField.value);
  }

  private join(): void {
    const room = this.linked ? this.options.room : parseCode(this.codeField.value);
    // Nowhere to go. Better to sit here with the cursor in the empty field than
    // to invent a room and drop someone into a stranger's kitchen.
    if (!room) {
      this.codeField.focus();
      return;
    }
    this.hide();
    this.options.onPlayOnline(room, this.chefName(), "");
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
    if (nav.confirm) this.confirm();
  }
}
