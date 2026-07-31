import "./ui/style.css";
import { LEVEL, levelById } from "./data/level";
import { InputManager } from "./input";
import { KitchenAudio } from "./audio";
import { View } from "./render/view";
import { Hud } from "./ui/hud";
import { PauseMenu } from "./ui/menu";
import { MenuController } from "./ui/menu-controller";
import { ControlsPanel } from "./ui/controls";
import { promptKey } from "./input/bindings";
import { JoinScreen } from "./ui/join";
import { loadIdentity, saveIdentity } from "./identity";
import { rotateCamera } from "./orientation";
import { assertContentValid } from "./data/validate";
import type { Game } from "./game/game";
import { LocalGame } from "./game/local";
import { NetGame } from "./game/net";
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

const identity = loadIdentity();
const input = new InputManager(identity.keys);

/**
 * The controls table, which is also where the keys are changed. Bound to the
 * input layer and to storage here, because those are the two things that have
 * to agree with it and neither belongs in a DOM widget.
 */
const controls = new ControlsPanel(menu.controlsRoot, {
  bindings: identity.keys,
  capture: (handler) => input.capture(handler),
  onChange: (keys) => {
    identity.keys = keys;
    input.setBindings(keys);
    hud.setStartKey(promptKey(keys, "start"));
    saveIdentity(identity);
  },
});
hud.setStartKey(promptKey(identity.keys, "start"));
// A rebind left half-finished when the menu closed would otherwise eat the
// next key pressed in the kitchen.
menu.onHide = () => controls.stopCapturing();
const params = new URLSearchParams(location.search);
/** `cookd.example/#KITCHEN` — a shareable link *is* the room. */
const roomFromUrl = location.hash
  .replace("#", "")
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, "");
const forceLocal = params.has("local");

let game: Game = new LocalGame(null, 1);
let view = new View(canvas, game.world, LEVEL.biome);
/** Where a *new* kitchen would be built. An existing room keeps its own. */
let wantedLevel = levelById(identity.level) ?? LEVEL;
const audio = new KitchenAudio(identity.muted);

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
  // A different world: what the last one was in the middle of is not news.
  audio.reset();
  if (changed) {
    view.dispose();
    view = new View(canvas, game.world, game.level.biome);
  }
}

let onlineSince = 0;
let wantedPlayers = 1;

/**
 * `creating` means this kitchen does not exist yet as far as we know, so the
 * level is a *request*. Joining sends no opinion at all: the room already has
 * an answer, and carrying a stale preference into someone else's kitchen is the
 * ghost control the join screen just stopped showing.
 */
function goOnline(room: string, name: string, level = wantedLevel, creating = false): void {
  wantedLevel = level;
  identity.name = name;
  identity.room = room;
  if (creating) identity.level = level.id;
  // Written back into `identity` rather than saved past it: the mute toggle
  // also saves, and building its payload from a stale object used to undo the
  // room you had just joined.
  saveIdentity(identity);
  if (location.hash.replace("#", "") !== room) history.replaceState(null, "", `#${room}`);
  // Always one chef to start with. More join by pressing `P` or picking up a
  // controller, which is how a second player actually turns up.
  wantedPlayers = 1;
  onlineSince = performance.now();
  useGame(
    new NetGame(
      socketUrl(),
      room,
      name,
      1,
      identity.token,
      (message, fatal) => {
        // The server's own words, in front of the player. These used to go to
        // `console.warn`, so "refresh to keep playing" — the one message that
        // tells someone how to fix it — was the one nobody ever saw, while the
        // client retried forever behind a "reconnecting" badge.
        hud.notify(message);
        // A fatal error means the client has stopped trying. Falling back to a
        // private offline kitchen is better than a frozen one.
        if (fatal) {
          onlineSince = 0;
          useGame(new LocalGame(null, wantedPlayers, level));
        }
      },
      level,
      {
        creating,
        // The room exists and it is somewhere else. A room code is an
        // invitation to *their* restaurant, so we load theirs rather than
        // telling the guest they picked the wrong place — which means a whole
        // new game and a new view, because the walls are baked at construction.
        onLevel: (id) => {
          const theirs = levelById(id);
          if (theirs) {
            hud.notify(`This kitchen is in the ${theirs.name.toLowerCase()}`);
            goOnline(room, name, theirs);
          }
        },
      },
    ),
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
  onPlayLocal: (id) => {
    // The click that starts the game is the gesture the audio hardware needs;
    // there is no earlier one, and without it the first sound is swallowed.
    audio.unlock();
    wantedLevel = levelById(id) ?? LEVEL;
    identity.level = wantedLevel.id;
    saveIdentity(identity);
    useGame(new LocalGame(null, 1, wantedLevel));
  },
  // An empty level means "joining": we load our best guess so there is
  // something to predict against, and the server corrects us if the kitchen
  // turns out to stand somewhere else.
  onPlayOnline: (room, name, id) => {
    audio.unlock();
    goOnline(room, name, levelById(id) ?? wantedLevel, id !== "");
  },
});

if (forceLocal) join.hide();
else join.show();

// --- menu -------------------------------------------------------------------

/**
 * All of the menu's dealings with the controls live in `MenuController`, along
 * with the three latches that span the open/closed boundary. This file used to
 * carry four module-level booleans encoding that one idea in four shapes, and
 * produced the same bug four times — see `input/latch.ts`.
 */
const menuControl = new MenuController(
  menu,
  () => game.world,
  (action) => game.menu(action),
  () => game.reset(),
);

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

function frame(now: number): void {
  requestAnimationFrame(frame);
  const since = now - last;
  if (since < FRAME_BUDGET) return;
  const elapsed = Math.min(0.25, since / 1000);
  last = now;

  fallbackIfUnreachable(now);

  // Before the join screen's early return: the kitchen is drawn behind it, and
  // being able to walk around the outside of a room you are deciding whether to
  // cook in is the point of showing it at all.
  const turn = input.consumeRotateRequest();
  if (turn) rotateCamera(turn);

  if (join.isOpen) {
    join.poll(input);
    if (shouldRender(now)) view.render(game.world, game.alpha, game.localIds);
    return;
  }

  if (input.consumeMuteRequest()) {
    identity.muted = audio.toggleMute();
    saveIdentity(identity);
    const muted = identity.muted;
    hud.notify(muted ? "Sound off" : "Sound on");
  }

  input.bindGamepads(game.localIds, () => game.addLocalPlayer(identity.name));
  input.releaseGamepads(game.localIds);
  if (input.consumeAddPlayerRequest()) game.addLocalPlayer(identity.name);
  if (input.consumeDropPlayerRequest() && game.localIds.length > 1) {
    // Never drop the last one — you would be left watching a kitchen you
    // cannot reach into.
    game.removeLocalPlayer(game.localIds[game.localIds.length - 1]!);
  }

  menuControl.update(input);

  // Handed to the game as a function so it can be called once per *tick*. A
  // frame can run zero ticks, and the input layer clears its press buffer on
  // every poll, so polling once per frame silently eats quick taps.
  const poll = (): Inputs => {
    const inputs = menuControl.filter(input.poll(game.localIds), game.localIds);
    // Confirm folds away the end-of-day report. It is a *shell* concern, so it
    // is read here rather than in the simulation: one player putting the card
    // down must not put it down on everybody else's screen, and the kitchen has
    // no business knowing what is drawn over it.
    if (game.world.phase === "build" && Object.values(inputs).some((i) => i?.grab || i?.start)) {
      hud.dismissSummary(game.world);
    }
    return inputs;
  };

  game.update(elapsed, poll);
  // Heard every frame, even the ones that are not drawn: a kitchen in an
  // unfocused window is still a kitchen you want to hear burn.
  audio.sync(game.world, game.localIds);
  if (shouldRender(now)) view.render(game.world, game.alpha, game.localIds);
  hud.update(game.world, {
    status: game.status,
    ping: game.ping,
    room: game.status === "local" ? "" : roomOf(),
  });
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
