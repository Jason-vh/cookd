import {
  ACTION_LABELS,
  GLOBAL_ACTIONS,
  PLAYER_ACTIONS,
  bindKey,
  clearKeys,
  chordKey,
  defaultBindings,
  keysFor,
  keysLabel,
  type KeyBindings,
  type Slot,
} from "../input/bindings";

/**
 * The controls table, and the place you change them.
 *
 * It was a block of hand-written HTML in the pause menu — the only description
 * of the keys, and one that could quietly disagree with the input layer. Now it
 * is generated from the bindings themselves, which is both how it stays true
 * and how it became editable: a key cap that knows which action it belongs to
 * is a button waiting to happen.
 *
 * Rebinding is a mouse job. Keyboard keys are chosen by *pressing* the key, so
 * navigating the table with the keyboard would fight the thing being done to
 * it; a pad, meanwhile, has a fixed layout and nothing here to change.
 */

export type ControlsOptions = {
  bindings: KeyBindings;
  /** Wait for one keypress. Returns a cancel function. See `InputManager.capture`. */
  capture: (handler: (event: KeyboardEvent) => void) => () => void;
  onChange: (bindings: KeyBindings) => void;
};

/** What the pad does for each action, since that half is not remappable. */
const PAD_LABELS: Record<string, string> = {
  up: "Stick \u2191",
  down: "Stick \u2193",
  left: "Stick \u2190",
  right: "Stick \u2192",
  grab: "A",
  use: "X / B",
  start: "Y",
  menu: "Start",
  addPlayer: "Any button",
  dropPlayer: "\u2014",
  mute: "\u2014",
  turnLeft: "L1",
  turnRight: "R1",
};

export class ControlsPanel {
  private readonly root: HTMLElement;
  private readonly capture: ControlsOptions["capture"];
  private readonly onChange: (bindings: KeyBindings) => void;
  private bindings: KeyBindings;
  /** The cap waiting for a key, if any. */
  private pending: { button: HTMLButtonElement; slot: Slot; cancel: () => void } | null = null;

  constructor(root: HTMLElement, options: ControlsOptions) {
    this.root = root;
    this.bindings = options.bindings;
    this.capture = options.capture;
    this.onChange = options.onChange;
    this.render();
  }

  /** Stop waiting for a key — the menu closed, or the panel is being rebuilt. */
  stopCapturing(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.cancel();
    pending.button.classList.remove("capturing");
    pending.button.textContent = keysLabel(keysFor(this.bindings, pending.slot));
  }

  private apply(bindings: KeyBindings): void {
    this.bindings = bindings;
    this.onChange(bindings);
    this.render();
  }

  private render(): void {
    this.stopCapturing();
    this.root.replaceChildren(
      head("", ["Player 1", "Player 2", "Gamepad"]),
      ...PLAYER_ACTIONS.map((action) =>
        row(ACTION_LABELS[action], [
          this.cap({ scheme: 0, action }),
          this.cap({ scheme: 1, action }),
          pad(action),
        ]),
      ),
      head("This browser", ["Key", "", "Gamepad"]),
      ...GLOBAL_ACTIONS.map((action) =>
        row(ACTION_LABELS[action], [
          this.cap({ scheme: "global", action }),
          document.createElement("span"),
          pad(action),
        ]),
      ),
      this.footer(),
    );
  }

  /** One editable key cap. */
  private cap(slot: Slot): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "key-cap";
    button.textContent = keysLabel(keysFor(this.bindings, slot));
    button.addEventListener("click", () => this.beginCapture(button, slot));
    return button;
  }

  private beginCapture(button: HTMLButtonElement, slot: Slot): void {
    // A second click on the cap you are already editing is a change of mind.
    const editing = button.classList.contains("capturing");
    this.stopCapturing();
    if (editing) return;

    button.classList.add("capturing");
    button.textContent = "Press a key\u2026";
    const cancel = this.capture((event) => {
      // Escape backs out and Backspace unbinds. Both are still bindable from
      // any *other* cap — this only applies while one is waiting for a key.
      if (event.code === "Escape") {
        this.render();
        return;
      }
      if (event.code === "Backspace" || event.code === "Delete") {
        this.apply(clearKeys(this.bindings, slot));
        return;
      }
      this.apply(bindKey(this.bindings, slot, chordKey(event.code, event.shiftKey)));
    });
    this.pending = { button, slot, cancel };
  }

  private footer(): HTMLElement {
    const note = document.createElement("p");
    note.className = "controls-note";
    note.append(
      "Click a key to change it. ",
      chip("Esc"),
      " cancels, ",
      chip("Backspace"),
      " clears it, and holding ",
      chip("Shift"),
      " binds the pair. A controller joins by pressing any button.",
    );

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "controls-reset";
    reset.textContent = "Reset to defaults";
    reset.addEventListener("click", () => this.apply(defaultBindings()));

    const footer = document.createElement("div");
    footer.className = "controls-footer";
    footer.append(note, reset);
    return footer;
  }
}

function head(title: string, labels: string[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "controls-row controls-head";
  const name = document.createElement("span");
  name.textContent = title;
  el.append(name);
  for (const label of labels) {
    const i = document.createElement("i");
    i.textContent = label;
    el.append(i);
  }
  return el;
}

function row(label: string, cells: HTMLElement[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "controls-row";
  const name = document.createElement("span");
  name.textContent = label;
  el.append(name, ...cells);
  return el;
}

function pad(action: string): HTMLElement {
  const el = document.createElement("b");
  el.className = "pad-cap";
  el.textContent = PAD_LABELS[action] ?? "\u2014";
  return el;
}

function chip(text: string): HTMLElement {
  const el = document.createElement("b");
  el.className = "key";
  el.textContent = text;
  return el;
}
