import { APPLIANCES } from "../data/appliances";
import { generateLevel, seedFromCode } from "../data/generate";
import { BEACH_SHACK, PARK_KITCHEN, RANDOM_LEVEL_ID, type LevelDef } from "../data/level";
import { loadIdentity, saveIdentity } from "../identity";
import { levelProblems } from "../data/validate";
import { kitchenWalks, type Walks } from "../data/walks";
import { createWorld } from "../sim/world";
import { horizontalWall, verticalWall } from "../sim/walls";

/**
 * The kitchen contact sheet: fifty floor plans at once. Dev only — `?kitchens`.
 *
 * The model gallery answers "what does a fryer look like". This answers the
 * question that comes after a generator: **is that a restaurant or is it a
 * shape?** Nobody can tell that from one kitchen, because one kitchen is always
 * plausible; you can only tell it from fifty side by side, which is a thing the
 * game itself can never show you.
 *
 * Flat and top-down rather than the game's own renderer. Fifty three-quarter
 * views at thumbnail size would be prettier and would answer nothing: what is
 * being compared here is *plans* — where the pass is, how far the sink is from
 * the tables, whether the dining room is a room or a corridor — and a floor plan
 * is the drawing that shows it.
 *
 * **Keyed by room code, not by seed.** A preview you cannot then play would be
 * a picture of a kitchen nobody can visit: the game seeds from the room code, so
 * that is what the sheet deals in, and clicking a plan opens it.
 *
 * The two hand-drawn kitchens stand at the top of the sheet, because "is this
 * any good" is not a question with an absolute answer. It is asked against the
 * park and the beach, and they should be on the same page in the same ink.
 */

/** Tiles are drawn this big. Small enough for fifty, big enough to read. */
const TILE = 13;

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1, as the join screen

export function startKitchens(root: HTMLElement, count = 50): void {
  document.title = "cookd — kitchens";
  root.className = "sheet";
  root.append(style());

  const header = document.createElement("header");
  header.innerHTML = `
    <h1>Kitchens</h1>
    <p>
      Every plan below is a room code. <strong>Click one to cook in it.</strong>
      The park and the beach are drawn first, in the same ink, because
      &ldquo;is this any good&rdquo; is only a question against them.
    </p>
    <div class="controls">
      <button id="reroll">Reroll ${count}</button>
      <label><input type="checkbox" id="numbers" checked /> show the walks</label>
    </div>
    <div class="legend">${legend()}</div>`;
  root.append(header);

  const grid = document.createElement("div");
  grid.className = "grid";
  root.append(grid);

  const draw = (): void => {
    grid.replaceChildren();
    for (const level of [PARK_KITCHEN, BEACH_SHACK]) {
      grid.append(plan(level, null, level.name));
    }
    for (let i = 0; i < count; i++) {
      const code = randomCode();
      grid.append(plan(generateLevel(seedFromCode(code)), code, code));
    }
  };

  root.querySelector("#reroll")!.addEventListener("click", draw);
  const numbers = root.querySelector<HTMLInputElement>("#numbers")!;
  numbers.addEventListener("change", () => {
    grid.classList.toggle("bare", !numbers.checked);
  });
  draw();
}

function randomCode(): string {
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
  }
  return code;
}

/** One kitchen: its plan, what it is called, and what a cover costs to walk. */
function plan(level: LevelDef, code: string | null, label: string): HTMLElement {
  const cell = document.createElement(code ? "a" : "div");
  cell.className = "cell";
  if (code && cell instanceof HTMLAnchorElement) {
    cell.href = `/#${code}`;
    // The picker remembers a *choice* rather than a kitchen, so this is what
    // makes the link land here instead of in the last place that was played.
    // Through `identity.ts` rather than at the key it keeps, so the sheet
    // cannot be the one place that still writes last month's shape.
    cell.addEventListener("click", () => {
      saveIdentity({ ...loadIdentity(), level: RANDOM_LEVEL_ID, room: code });
    });
  }

  const walks = kitchenWalks(level);
  const problems = levelProblems(level);
  cell.append(svg(level));

  const caption = document.createElement("p");
  caption.className = "caption";
  const drawn = code ? "" : ` <span class="badge">drawn by hand</span>`;
  caption.innerHTML = `<b>${label}</b> <span class="dim">${level.size.width}\u00d7${level.size.height} \u00b7 ${level.biome}</span>${drawn}`;
  cell.append(caption);

  const numbers = document.createElement("p");
  numbers.className = "walks";
  numbers.innerHTML = walkText(walks);
  cell.append(numbers);

  // Should never fire — `generate.test.ts` runs every seed past the validator.
  // It is here because the one time it does, this is where it will be seen.
  if (problems.length > 0) {
    const bad = document.createElement("p");
    bad.className = "broken";
    bad.textContent = problems.join("; ");
    cell.append(bad);
  }
  return cell;
}

function walkText(walks: Walks): string {
  const park = kitchenWalks(PARK_KITCHEN).total;
  const beach = kitchenWalks(BEACH_SHACK).total;
  // Outside the range the hand-drawn kitchens span is not wrong — the sink is
  // movable and a longer kitchen is a harder one — but it is the thing worth
  // looking at, so it is the thing that is coloured.
  const off = walks.total < beach || walks.total > park;
  return (
    `<span class="${off ? "off" : ""}">loop ${walks.total}</span>` +
    ` <span class="dim">gather ${walks.gather} \u00b7 plate ${walks.plate}` +
    ` \u00b7 serve ${walks.serve} \u00b7 bus ${walks.bus}</span>`
  );
}

/**
 * The plan itself, drawn from the **built world** rather than from the level.
 *
 * Walls are read out of `world.walls`, which is the same array collision uses,
 * so a doorway drawn here is a doorway a customer can walk through — the hole
 * the shell gets punched in it is not repeated, it is the one that exists.
 * Furniture comes from the level, because what is being previewed is the
 * kitchen as it *starts*, before a morning has moved anything.
 */
function svg(level: LevelDef): SVGSVGElement {
  const world = createWorld(level, 0);
  const { width, height } = level.size;
  const node = document.createElementNS(SVG, "svg");
  node.setAttribute("viewBox", `0 0 ${width * TILE} ${height * TILE}`);
  node.setAttribute("width", String(width * TILE));

  const add = (name: string, attrs: Record<string, string | number>): void => {
    const element = document.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    node.append(element);
  };

  add("rect", { x: 0, y: 0, width: width * TILE, height: height * TILE, fill: "#26302a" });
  for (const area of level.paving) {
    add("rect", {
      x: area.x * TILE,
      y: area.y * TILE,
      width: area.width * TILE,
      height: area.height * TILE,
      fill: "#3d4440",
    });
  }
  const room = level.room;
  add("rect", {
    x: room.x * TILE,
    y: room.y * TILE,
    width: room.width * TILE,
    height: room.height * TILE,
    fill: "#5b5145",
  });

  // Furniture. Mounted things — the sign, the posters — hang on a wall over
  // floor anybody may cross, so they are drawn as marks rather than as blocks:
  // reading them as solid is exactly the mistake this sheet exists to catch.
  for (const placement of level.appliances) {
    const def = APPLIANCES[placement.kind];
    const colour = `#${def.color.toString(16).padStart(6, "0")}`;
    const x = placement.at.x * TILE;
    const y = placement.at.y * TILE;
    if (def.mounted) {
      add("circle", { cx: x + TILE / 2, cy: y + TILE / 2, r: 2.5, fill: colour, opacity: 0.9 });
    } else {
      add("rect", {
        x: x + 1,
        y: y + 1,
        width: TILE - 2,
        height: TILE - 2,
        rx: placement.kind === "table" ? TILE / 2 : 2,
        fill: colour,
      });
    }
  }

  // The way in, so a plan can be read for the walk a customer takes.
  add("rect", {
    x: level.door.x * TILE + 2,
    y: level.door.y * TILE + 2,
    width: TILE - 4,
    height: TILE - 4,
    fill: "none",
    stroke: "#e8d9a0",
    "stroke-width": 1.5,
  });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x <= width; x++) {
      if (verticalWall(world, x, y)) {
        add("line", {
          x1: x * TILE,
          y1: y * TILE,
          x2: x * TILE,
          y2: (y + 1) * TILE,
          stroke: "#1b1f1d",
          "stroke-width": 2.5,
        });
      }
    }
  }
  for (let y = 0; y <= height; y++) {
    for (let x = 0; x < width; x++) {
      if (horizontalWall(world, x, y)) {
        add("line", {
          x1: x * TILE,
          y1: y * TILE,
          x2: (x + 1) * TILE,
          y2: y * TILE,
          stroke: "#1b1f1d",
          "stroke-width": 2.5,
        });
      }
    }
  }
  return node;
}

const SVG = "http://www.w3.org/2000/svg";

/**
 * Which block is which.
 *
 * A sink and a plate stack are two greys a tile wide, and without this the
 * sheet is unreadable for the one comparison it exists to support — how far
 * the wash-up is from everything else.
 */
function legend(): string {
  // No board: it is a fitting set on a counter rather than a block of its own,
  // so nothing on a plan is ever drawn as one.
  const shown = [
    "crate",
    "counter",
    "plates",
    "sink",
    "bin",
    "table",
    "stall",
    "cards",
    "sign",
  ] as const;
  const swatches = shown.map((kind) => {
    const def = APPLIANCES[kind];
    const colour = `#${def.color.toString(16).padStart(6, "0")}`;
    const shape = def.mounted ? "border-radius:50%;width:7px;height:7px" : "";
    return `<span class="key"><i style="background:${colour};${shape}"></i>${def.label.toLowerCase()}</span>`;
  });
  return [
    ...swatches,
    `<span class="key"><i class="door"></i>door</span>`,
    `<span class="key"><i class="wall"></i>wall</span>`,
  ].join("");
}

function style(): HTMLStyleElement {
  const sheet = document.createElement("style");
  sheet.textContent = `
    .sheet { position: fixed; inset: 0; overflow: auto; padding: 24px 28px 60px;
      background: #1a1e1c; color: #e6e2d8;
      font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; z-index: 50; }
    .sheet h1 { font-size: 20px; margin: 0 0 4px; }
    .sheet header p { margin: 0 0 10px; color: #9aa39c; max-width: 62ch; }
    .sheet .controls { display: flex; gap: 14px; align-items: center; margin-bottom: 20px; }
    .sheet button { font: inherit; background: #3d4440; color: #e6e2d8;
      border: 1px solid #566159; border-radius: 4px; padding: 5px 12px; cursor: pointer; }
    .sheet button:hover { background: #4a534d; }
    .sheet label { color: #9aa39c; }
    .grid { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
    .cell { display: block; text-decoration: none; color: inherit;
      background: #222724; border: 1px solid #333b36; border-radius: 6px; padding: 8px; }
    a.cell:hover { border-color: #b8a06a; }
    .cell svg { display: block; border-radius: 3px; }
    .caption { margin: 7px 0 1px; }
    .walks { margin: 0; font-size: 11px; }
    .grid.bare .walks { display: none; }
    .sheet .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0 0 22px;
      color: #9aa39c; font-size: 11px; }
    .sheet .key { display: inline-flex; align-items: center; gap: 5px; }
    .sheet .key i { display: inline-block; width: 11px; height: 11px; border-radius: 2px; }
    .sheet .key i.door { border: 1.5px solid #e8d9a0; background: none; }
    .sheet .key i.wall { height: 3px; background: #1b1f1d; border: 1px solid #566159; }
    .badge { color: #8fa88c; font-size: 11px; }
    .dim { color: #808a83; }
    .off { color: #d9a441; }
    .broken { margin: 3px 0 0; font-size: 11px; color: #e06c5a; max-width: 30ch; }
  `;
  return sheet;
}
