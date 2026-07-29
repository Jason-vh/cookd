import "./ui/style.css";
import { LEVEL } from "./data/level";
import { InputManager, type MenuNav } from "./input";
import { View } from "./render/view";
import { Hud } from "./ui/hud";
import { PauseMenu } from "./ui/menu";
import { JoinScreen } from "./ui/join";
import { loadIdentity, saveIdentity } from "./identity";
import { assertContentValid } from "./data/validate";
import type { Game } from "./game/game";
import { LocalGame } from "./game/local";
import { NetGame } from "./game/net";
import { emptyInput } from "./sim/world";
import type { Inputs } from "./sim/types";

/**
 * The shell: input in, pixels out. It owns no rules.
 *
 * Everything the game *is* lives behind `Game` — either a `Host` running in
 * this tab or a socket to one running on a server. The shell cannot tell which,
 * and neither can the renderer, which is why adding multiplayer did not touch
 * `sim/` at all.
 */

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const hud = new Hud(document.querySelector<HTMLElement>("#hud")!);
const menu = new PauseMenu(document.querySelector<HTMLElement>("#menu")!);
const input = new InputManager();

const identity = loadIdentity();
const params = new URLSearchParams(location.search);
/** `cookd.example/#KITCHEN` — a shareable link *is* the room. */
const roomFromUrl = location.hash
  .replace("#", "")
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, "");
const forceLocal = params.has("local");

let game: Game = new LocalGame(null, 1);
let view = new View(canvas, game.world, LEVEL.biome);

function socketUrl(): string {
  // `?server=ws://host/ws` points the client at a different server. Used for
  // testing against a latency proxy, and for running the client against a
  // remote kitchen while developing locally.
  const override = params.get("server");
  if (override) return override;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

/**
 * Swap the running game — offline to online, or back.
 *
 * The renderer usually survives untouched: worlds built from the same level
 * have identical walls and camera framing, and the only things that change are
 * appliance and player ids, which `View` already drops meshes for (it has to,
 * for resets and for people leaving).
 *
 * A *different* level is the exception, because `View` bakes the walls and the
 * floor into one static batch when it is built. That used to be unrepresentable
 * — there was one level, and nothing in the render layer could be freed — so
 * this is the one place the disposal work actually pays for itself.
 */
function useGame(next: Game): void {
  const changed = next.level.id !== game.level.id;
  game.dispose();
  game = next;
  if (changed) {
    view.dispose();
    view = new View(canvas, game.world, game.level.biome);
  }
}

let onlineSince = 0;
let wantedPlayers = 1;

function goOnline(room: string, name: string): void {
  saveIdentity({ ...identity, name, room });
  if (location.hash.replace("#", "") !== room) history.replaceState(null, "", `#${room}`);
  // Always one chef to start with. More join by pressing `P` or picking up a
  // controller, which is how a second player actually turns up.
  wantedPlayers = 1;
  onlineSince = performance.now();
  useGame(
    new NetGame(socketUrl(), room, name, 1, identity.token, (message, fatal) => {
      // The server's own words, in front of the player. These used to go to
      // `console.warn`, so "refresh to keep playing" — the one message that
      // tells someone how to fix it — was the one nobody ever saw, while the
      // client retried forever behind a "reconnecting" badge.
      hud.notify(message);
      // A fatal error means the client has stopped trying. Falling back to a
      // private offline kitchen is better than a frozen one.
      if (fatal) {
        onlineSince = 0;
        useGame(new LocalGame(null, wantedPlayers));
      }
    }),
  );
}

/**
 * If the kitchen cannot be reached, play on your own rather than staring at an
 * empty field. A cooking game that refuses to start because a VPS is down is a
 * poor trade for co-op, and the join screen is one keypress away.
 */
const FALLBACK_AFTER = 6000;

function fallbackIfUnreachable(now: number): void {
  if (!onlineSince) return;
  // This only ever means "we never got in". Once connected, a drop is the
  // reconnect path's problem — silently moving a player into a private offline
  // kitchen mid-session, while their friends carry on without them, would be a
  // far stranger failure than showing "reconnecting".
  if (game.status === "online") {
    onlineSince = 0;
    return;
  }
  if (now - onlineSince < FALLBACK_AFTER) return;
  onlineSince = 0;
  useGame(new LocalGame(null, wantedPlayers));
  hud.notify("Could not reach that kitchen — playing offline");
}

const join = new JoinScreen(document.querySelector<HTMLElement>("#join")!, {
  identity,
  room: roomFromUrl,
  offline: forceLocal,
  onPlayLocal: () => {
    useGame(new LocalGame(null, 1));
  },
  onPlayOnline: (room, name) => goOnline(room, name),
});

if (forceLocal) join.hide();
else join.show();

// --- menu -------------------------------------------------------------------

let previousNav: MenuNav = { up: false, down: false, confirm: false, menu: false, back: false };

/**
 * Is the menu key held down *right now*, tracked across the open/closed
 * boundary.
 *
 * Opening and closing used to use separate edge detectors — one against the
 * menu's own nav state, one against gameplay input — and holding `Esc` for two
 * frames closed the menu and immediately reopened it. One key, one latch: it
 * has to be released before it can act again, whichever side of the boundary
 * we are on.
 */
let menuKeyDown = false;

/**
 * The button that confirmed a menu item, held down across the boundary.
 *
 * `Enter` confirms in the menu **and** is the `start` button in play, and the
 * gamepad's `A` confirms and grabs. Picking "Close up early" therefore closed
 * the menu into the build phase and then, while the key was still down, read as
 * a fresh `start` press — which opens the next day. The kitchen shut and
 * reopened between two frames, so the menu item looked like it did nothing at
 * all, and the only trace was the day counter going up.
 *
 * Swallowing a single frame is not enough: a key is held for a tenth of a
 * second, which is six of them. It has to be *released* before play sees it,
 * exactly like `menuKeyDown` for the menu key. This is the third variant of
 * the same bug in this file — the general rule is that a control which means
 * two things either side of a boundary needs a latch that spans the boundary,
 * never an edge test on one side of it.
 */
let confirmHeld = false;

function openMenu(): void {
  menu.show(game.world);
  previousNav = { ...previousNav, menu: true, confirm: true, back: true };
}

function closeMenu(): void {
  menu.hide();
}

function runMenuAction(): void {
  confirmHeld = true;
  switch (menu.confirm()) {
    case "resume":
      closeMenu();
      break;
    case "startDay":
      game.menu("startDay");
      closeMenu();
      break;
    case "endDay":
      game.menu("endDay");
      closeMenu();
      break;
    case "restartDay":
      game.menu("restartDay");
      closeMenu();
      break;
    case "resetKitchen":
      game.reset();
      closeMenu();
      break;
    default:
      break;
  }
}

// --- loop --------------------------------------------------------------------

/**
 * Render at most 60 times a second.
 *
 * `requestAnimationFrame` runs at the display's refresh rate, so on a 120 Hz
 * laptop panel the game was drawing every frame twice over — twice the draw
 * calls, twice the shadow map, twice the post-processing chain — to show the
 * same thing. The simulation is a fixed 60 Hz timestep either way, so the extra
 * frames only ever re-interpolated a chef between two positions they were
 * already being drawn between.
 *
 * The 2 ms tolerance matters: a 60 Hz display delivers frames a hair under
 * 16.67 ms apart, and without slack every other one would miss the budget and
 * halve the game to 30 fps.
 */
const FRAME_BUDGET = 1000 / 60 - 2;

/**
 * A window you are not looking at still gets `requestAnimationFrame` at the full
 * refresh rate. Chrome throttles a *hidden* or fully occluded tab, but not one
 * that has merely lost focus — so a kitchen sitting visible in the corner of the
 * screen while you work in another window kept drawing 60 complete frames a
 * second, post-processing and all.
 *
 * Only drawing is throttled. `game.update` keeps its cadence because online it
 * is also what sends this client's inputs to the server, and a client that goes
 * quiet for a few seconds is one that has to noisily catch up when it returns.
 * Skipping the draw is free; skipping the tick is not.
 */
const UNFOCUSED_RENDER_FPS = 10;

let focused = true;
window.addEventListener("blur", () => {
  focused = false;
});
window.addEventListener("focus", () => {
  focused = true;
});

let lastRender = 0;

/** True at most `UNFOCUSED_RENDER_FPS` times a second while unfocused. */
function shouldRender(now: number): boolean {
  if (focused) return true;
  if (now - lastRender < 1000 / UNFOCUSED_RENDER_FPS) return false;
  lastRender = now;
  return true;
}

let last = performance.now();
let menuWasOpen = false;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const since = now - last;
  if (since < FRAME_BUDGET) return;
  const elapsed = Math.min(0.25, since / 1000);
  last = now;

  fallbackIfUnreachable(now);

  if (join.isOpen) {
    join.poll(input);
    if (shouldRender(now)) view.render(game.world, game.alpha, game.localIds);
    return;
  }

  input.bindGamepads(game.localIds, () => game.addLocalPlayer(identity.name));
  input.releaseGamepads(game.localIds);
  if (input.consumeAddPlayerRequest()) game.addLocalPlayer(identity.name);
  if (input.consumeDropPlayerRequest() && game.localIds.length > 1) {
    // Never drop the last one — you would be left watching a kitchen you
    // cannot reach into.
    game.removeLocalPlayer(game.localIds[game.localIds.length - 1]!);
  }

  if (menu.isOpen) {
    const nav = input.pollMenu();
    const closing = nav.menu || nav.back;
    if (closing && !menuKeyDown) closeMenu();
    else if (nav.up && !previousNav.up) menu.move(-1);
    else if (nav.down && !previousNav.down) menu.move(1);
    else if (nav.confirm && !previousNav.confirm) runMenuAction();
    // Carried across the open/closed boundary — see `menuKeyDown`.
    menuKeyDown = closing;
    previousNav = nav;
    menu.sync(game.world);
  }

  // Handed to the game as a function so it can be called once per *tick*. A
  // frame can run zero ticks, and the input layer clears its press buffer on
  // every poll, so polling once per frame silently eats quick taps.
  const poll = (): Inputs => {
    // The world keeps running while you read the menu. Online it has to — one
    // player cannot stop a kitchen four people are standing in — so it does
    // here too, rather than pause meaning two different things. Your chef
    // stands still and everyone can see it.
    //
    // `menuWasOpen` swallows the frame the menu closed on, so the button that
    // dismissed it does not also grab something.
    if (menu.isOpen || menuWasOpen) return idleInputs();

    const polled = input.poll(game.localIds);

    // ...and the confirm button stays swallowed until it is let go. See
    // `confirmHeld`.
    if (confirmHeld) {
      let stillDown = false;
      for (const id of game.localIds) {
        const one = polled[id];
        if (!one) continue;
        if (one.grab || one.start) stillDown = true;
        one.grab = false;
        one.start = false;
      }
      confirmHeld = stillDown;
    }
    const pressed = game.localIds.some((id) => polled[id]?.menu);
    if (pressed && !menuKeyDown) {
      menuKeyDown = true;
      openMenu();
      return idleInputs();
    }
    menuKeyDown = pressed;
    return polled;
  };

  game.update(elapsed, poll);
  menuWasOpen = menu.isOpen;
  if (shouldRender(now)) view.render(game.world, game.alpha, game.localIds);
  hud.update(game.world, {
    status: game.status,
    ping: game.ping,
    room: game.status === "local" ? "" : roomOf(),
  });
}

function idleInputs(): Inputs {
  const inputs: Inputs = {};
  for (const id of game.localIds) inputs[id] = emptyInput();
  return inputs;
}

function roomOf(): string {
  return location.hash.replace("#", "") || "MAIN";
}

declare global {
  interface Window {
    /** Dev-only console handle. See the block at the bottom of this file. */
    cookd?: {
      readonly world: Game["world"];
      readonly game: Game;
      view: View;
      input: InputManager;
      menu: PauseMenu;
      join: JoinScreen;
    };
  }
}

if (import.meta.env.DEV) {
  // Content is compiled in, so if it is coherent at build time it is coherent
  // for every player. Checking it here means a typo in a recipe is a loud
  // failure the moment the dev server reloads, rather than an unreachable dish
  // or a throw out of `ingredient()` ten minutes into a game.
  assertContentValid();

  window.cookd = {
    get world() {
      return game.world;
    },
    get game() {
      return game;
    },
    view,
    input,
    menu,
    join,
  };
}

requestAnimationFrame(frame);
