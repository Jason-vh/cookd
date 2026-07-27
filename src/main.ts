import "./ui/style.css";
import { LEVEL } from "./data/level";
import { InputManager, type MenuNav } from "./input";
import { View } from "./render/view";
import { Hud } from "./ui/hud";
import { PauseMenu } from "./ui/menu";
import { JoinScreen } from "./ui/join";
import { loadIdentity, saveIdentity } from "./identity";
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
const roomFromUrl = location.hash.replace("#", "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const forceLocal = params.has("local");

let game: Game = new LocalGame(null, 1);
const view = new View(canvas, game.world, LEVEL.biome);

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
 * The renderer survives untouched. Every world is built from the same level, so
 * the walls and the camera framing are identical; the only things that change
 * are appliance and player ids, and `View` already drops meshes for ids that
 * stop existing (it has to, for resets and for people leaving).
 */
function useGame(next: Game): void {
  game.dispose();
  game = next;
}

let onlineSince = 0;
let wantedPlayers = 1;

function goOnline(room: string, name: string, players: number): void {
  saveIdentity({ ...identity, name, players, room });
  if (location.hash.replace("#", "") !== room) history.replaceState(null, "", `#${room}`);
  wantedPlayers = players;
  onlineSince = performance.now();
  useGame(new NetGame(socketUrl(), room, name, players, identity.token));
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
  onPlayLocal: (players) => {
    useGame(new LocalGame(null, players));
  },
  onPlayOnline: (room, name, players) => goOnline(room, name, players),
});

if (forceLocal) join.hide();
else join.show();

// --- menu -------------------------------------------------------------------

let previousNav: MenuNav = { up: false, down: false, confirm: false, menu: false, back: false };

function openMenu(): void {
  menu.show(game.world);
  previousNav = { ...previousNav, menu: true, confirm: true, back: true };
}

function closeMenu(): void {
  menu.hide();
}

function runMenuAction(): void {
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

let last = performance.now();
let menuWasOpen = false;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const elapsed = Math.min(0.25, (now - last) / 1000);
  last = now;

  fallbackIfUnreachable(now);

  if (join.isOpen) {
    join.poll(input);
    view.render(game.world, game.alpha);
    return;
  }

  input.bindGamepads(game.localIds, () => game.addLocalPlayer(identity.name));
  input.releaseGamepads(game.localIds);
  if (input.consumeAddPlayerRequest()) game.addLocalPlayer(identity.name);

  if (menu.isOpen) {
    const nav = input.pollMenu();
    if ((nav.menu && !previousNav.menu) || (nav.back && !previousNav.back)) closeMenu();
    else if (nav.up && !previousNav.up) menu.move(-1);
    else if (nav.down && !previousNav.down) menu.move(1);
    else if (nav.confirm && !previousNav.confirm) runMenuAction();
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
    if (game.localIds.some((id) => polled[id]?.menu)) {
      openMenu();
      return idleInputs();
    }
    return polled;
  };

  game.update(elapsed, poll);
  menuWasOpen = menu.isOpen;
  view.render(game.world, game.alpha);
  hud.update(game.world, { status: game.status, ping: game.ping, room: game.status === "local" ? "" : roomOf() });
}

function idleInputs(): Inputs {
  const inputs: Inputs = {};
  for (const id of game.localIds) inputs[id] = emptyInput();
  return inputs;
}

function roomOf(): string {
  return location.hash.replace("#", "") || "MAIN";
}

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).cookd = {
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
