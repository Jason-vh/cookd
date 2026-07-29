import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The one rule in `docs/architecture.md`, checked.
 *
 * > `src/sim` is pure. It must never import from `src/render`, `src/ui` or
 * > `src/input`, and must never touch the DOM.
 *
 * It has held for the life of the project on care alone, which is not nothing —
 * but it is the load-bearing rule of the whole codebase and it was resting on
 * nobody making a mistake in a hurry.
 *
 * The second test is a weaker, newer rule: the render layer may *read* the
 * simulation, but it should read things that are **true** (`sim/queries.ts`),
 * not reach into the things that **happen** (`sim/systems/*`). Those are tick
 * functions whose job is mutation; the queries that had accumulated in them
 * were only there because that is where they were first needed.
 */

const ROOT = new URL("../..", import.meta.url).pathname;

async function sources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

/**
 * Every module a file imports.
 *
 * Both forms: `import x from "y"` and the side-effect `import "y"`. The second
 * is easy to forget and is exactly how a DOM-touching module would sneak into
 * the simulation — it was missing from the first version of this helper, and a
 * deliberately planted violation walked straight past it.
 */
async function importsOf(file: string): Promise<string[]> {
  const text = await readFile(join(ROOT, file), "utf8");
  const withBinding = [...text.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)];
  const bare = [...text.matchAll(/^import\s+"([^"]+)";/gm)];
  return [...withBinding, ...bare].map(([, target]) => target ?? "");
}

describe("the simulation is pure", () => {
  test("imports nothing from render, ui or input", async () => {
    const offenders: string[] = [];
    for (const file of await sources("src/sim")) {
      for (const target of await importsOf(file)) {
        if (/(^|\/)(render|ui|input)\//.test(target)) offenders.push(`${file} -> ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("does not touch the DOM", async () => {
    // `three` is the other half of this: importing it would drag in WebGL and
    // make the simulation unrunnable on a server.
    const offenders: string[] = [];
    for (const file of await sources("src/sim")) {
      const text = await readFile(join(ROOT, file), "utf8");
      for (const global of ["document", "window", "localStorage", "performance."]) {
        if (text.includes(global)) offenders.push(`${file} uses ${global}`);
      }
      if ((await importsOf(file)).includes("three")) offenders.push(`${file} imports three`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("the render layer reads what is true, not what happens", () => {
  test("imports no simulation system", async () => {
    // `sim/systems/*` are the tick functions. A query that the renderer needs
    // belongs in `sim/queries.ts`, where it is obviously read-only — see the
    // note at the top of that file for why sharing the query is right and
    // copying it into a view-model would not be.
    const offenders: string[] = [];
    for (const file of [...(await sources("src/render")), ...(await sources("src/ui"))]) {
      for (const target of await importsOf(file)) {
        if (target.includes("sim/systems")) offenders.push(`${file} -> ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("never writes to the world", async () => {
    // The renderer mirrors the simulation. A `world.x =` in here is a rule
    // being implemented twice, which is how the two come to disagree.
    const offenders: string[] = [];
    for (const file of [...(await sources("src/render")), ...(await sources("src/ui"))]) {
      const text = await readFile(join(ROOT, file), "utf8");
      for (const [line] of text.matchAll(/^\s*world\.\w+(\.\w+)*\s*(=[^=]|\+\+|--|\+=|-=)/gm)) {
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
