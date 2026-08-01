import { CHEF_HATS, CHEF_OUTFITS, chefHat, chefOutfit } from "../data/chefs";
import { DEFAULT_LEVEL_ID, LEVELS, RANDOM_LEVEL_ID } from "../data/level";
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

/**
 * Every kitchen the game knows about, named, and then the one it does not.
 *
 * Levels are content, not a menu — so the drawn ones are listed from the
 * registry and the generated one is a single extra entry rather than a second
 * control. What it builds depends on the room code, which is the next field up.
 */
function levelOptions(): string {
  const drawn = Object.values(LEVELS)
    .map((level) => `<option value="${level.id}">${level.name}</option>`)
    .join("");
  return `${drawn}<option value="${RANDOM_LEVEL_ID}">Surprise me</option>`;
}

/**
 * The wardrobe, above the fold and above both panes.
 *
 * Above them because it is the one question that means the same whether you are
 * making a kitchen or walking into one — like your name, and unlike the level.
 * The choice is written straight into `identity`, which the shell saves when
 * the game starts, so it is remembered without a button of its own.
 *
 * Hats are drawn rather than named: picking "beanie" off a list is picking a
 * word, and you would not find out what you had chosen until you were standing
 * in a kitchen. The sketches are the silhouettes `person-mesh.ts` builds, at
 * the size a button can show.
 */
const HAT_SKETCHES: Record<string, string> = {
  toque: '<ellipse cx="12" cy="8" rx="7" ry="5"/><rect x="5" y="11" width="14" height="4" rx="1"/>',
  cap: '<path d="M5 13a7 6 0 0 1 14 0z"/><rect x="11" y="12" width="10" height="3" rx="1.4"/>',
  bandana: '<path d="M5 13a7 5 0 0 1 14 0z"/><path d="M5 12l-3 2 3 1z"/>',
  beanie:
    '<path d="M6 13a6 7 0 0 1 12 0z"/><rect x="5" y="13" width="14" height="3" rx="1.4"/><circle cx="12" cy="5" r="2"/>',
};

function outfitSwatches(selected: string): string {
  return CHEF_OUTFITS.map(
    (outfit) => `<button type="button" class="swatch" data-outfit="${outfit.id}"
      aria-pressed="${outfit.id === selected}" title="${outfit.name}"
      style="--swatch: #${outfit.color.toString(16).padStart(6, "0")}"></button>`,
  ).join("");
}

function hatButtons(selected: string): string {
  return CHEF_HATS.map(
    (hat) => `<button type="button" class="swatch hat" data-hat="${hat.id}"
      aria-pressed="${hat.id === selected}" title="${hat.name}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${HAT_SKETCHES[hat.id] ?? ""}</svg>
    </button>`,
  ).join("");
}

/** Which swatch was clicked, if the click landed on one at all. */
function pickedFrom(event: Event, attribute: "outfit" | "hat"): string | undefined {
  const target = event.target;
  if (!(target instanceof Element)) return undefined;
  // `closest`, because the click may well have landed on the SVG inside the
  // button rather than on the button.
  return target.closest<HTMLElement>(`[data-${attribute}]`)?.dataset[attribute];
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
        <label>Your chef
          <span class="join-swatches" id="join-outfits">${outfitSwatches(identity.outfit)}</span>
          <span class="join-swatches" id="join-hats">${hatButtons(identity.hat)}</span>
        </label>

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
    const remembered = identity.level;
    this.levelField.value =
      LEVELS[remembered] || remembered === RANDOM_LEVEL_ID ? remembered : DEFAULT_LEVEL_ID;

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
    this.root.querySelector("#join-outfits")!.addEventListener(
      "click",
      (event) => {
        const chosen = pickedFrom(event, "outfit");
        if (chosen) this.wear({ outfit: chefOutfit(chosen).id });
      },
      { signal },
    );
    this.root.querySelector("#join-hats")!.addEventListener(
      "click",
      (event) => {
        const chosen = pickedFrom(event, "hat");
        if (chosen) this.wear({ hat: chefHat(chosen).id });
      },
      { signal },
    );
    this.root.addEventListener(
      "keydown",
      (event: KeyboardEvent) => {
        // A focused button already does its own thing on Enter. Without this,
        // choosing a hat with the keyboard also started the game.
        if (event.target instanceof HTMLButtonElement) return;
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

  /**
   * Remember the choice and show it.
   *
   * Written into the shared `identity` rather than handed back through a
   * callback: it is not an answer to the question this screen is asking, it is
   * a thing about *you*, and the shell saves the whole identity the moment a
   * game starts either way.
   */
  private wear(change: { outfit?: string; hat?: string }): void {
    const { identity } = this.options;
    if (change.outfit !== undefined) identity.outfit = change.outfit;
    if (change.hat !== undefined) identity.hat = change.hat;
    this.paint();
  }

  private paint(): void {
    this.card.dataset.mode = this.mode;
    const { outfit, hat } = this.options.identity;
    for (const button of this.root.querySelectorAll<HTMLElement>("[data-outfit]")) {
      button.setAttribute("aria-pressed", String(button.dataset.outfit === outfit));
    }
    for (const button of this.root.querySelectorAll<HTMLElement>("[data-hat]")) {
      button.setAttribute("aria-pressed", String(button.dataset.hat === hat));
    }
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
