import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Does the architecture doc still point at real files?
 *
 * The README used to carry a file tree describing every module. It was genuinely
 * useful and it was wrong: it listed `view.ts` as owning "scene, camera,
 * animation, reconciliation" long after four of those had moved out. Nobody
 * noticed, because nothing could.
 *
 * So this checks that every path the tree names exists. It deliberately does
 * **not** check the reverse — that every file is described — because the two
 * failures are not the same size. A path that has moved or gone is a *lie*: it
 * sends a reader somewhere that is not there, and the more confident the
 * document looks the more expensive that is. A file nobody has described yet is
 * an omission, and the map is a little less useful.
 *
 * Requiring completeness would also tax every new file, and what that actually
 * buys is filler: a one-line description written to get past a test is worse
 * than no line at all. It would not even have caught the original drift — the
 * ten files missing from that tree were all inside `render/`, which was
 * described.
 *
 * Deliberately not generated, either. The value of the tree is the sentence
 * beside each path, which is the part a generator cannot write.
 */

const ROOT = new URL("..", import.meta.url).pathname;

/** The paths named in the architecture doc's tree, resolved from its indentation. */
async function documentedFiles(): Promise<string[]> {
  const text = await readFile(join(ROOT, "docs/architecture.md"), "utf8");
  const fence = /```\n(src\/[\s\S]*?)```/.exec(text);
  expect(fence).not.toBeNull();

  const documented: string[] = [];
  // The directory open at each indent depth, so `movement.ts` nested under
  // `systems/` under `sim/` resolves to `src/sim/systems/movement.ts`. Each
  // entry holds the *full* path to that directory, so the innermost one is the
  // prefix — joining the whole stack would count every ancestor twice.
  const stack: { indent: number; path: string }[] = [];
  for (const line of (fence?.[1] ?? "").split("\n")) {
    const match = /^(\s*)(\S+)/.exec(line);
    if (!match) continue;
    const indent = match[1]?.length ?? 0;
    const name = match[2] ?? "";

    while (stack.length > 0 && indent <= (stack.at(-1)?.indent ?? 0)) stack.pop();
    const prefix = stack.at(-1)?.path ?? "";

    if (name.endsWith("/")) {
      stack.push({ indent, path: prefix + name });
      continue;
    }
    if (name.endsWith(".ts")) documented.push(prefix + name);
  }
  return documented.sort();
}

describe("docs/architecture.md", () => {
  test("only points at modules that exist", async () => {
    const documented = await documentedFiles();
    // A tree that names nothing would pass every assertion below, so check the
    // parser found something first.
    expect(documented.length).toBeGreaterThan(20);

    const stale: string[] = [];
    for (const path of documented) {
      if (!(await Bun.file(join(ROOT, path)).exists())) stale.push(path);
    }
    expect(stale).toEqual([]);
  });
});

describe("the docs link to each other", () => {
  test("every relative link resolves", async () => {
    // A split into ten files is only an improvement if the files can be found
    // from each other. Broken cross-references are the failure mode that makes
    // people go back to one big file.
    const files = ["README.md", ...(await readdir(join(ROOT, "docs"))).map((f) => `docs/${f}`)];
    const broken: string[] = [];

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const text = await readFile(join(ROOT, file), "utf8");
      for (const [, target] of text.matchAll(/\]\(([^)#][^)]*)\)/g)) {
        if (!target || /^[a-z]+:/.test(target)) continue;
        const path = target.split("#")[0];
        if (!path) continue;
        const base = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
        const resolved = join(ROOT, base, path);
        if (!(await Bun.file(resolved).exists())) {
          // Directories are legitimate link targets and `Bun.file` says no.
          const asDir = await readdir(resolved).catch(() => null);
          if (!asDir) broken.push(`${file} -> ${target}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });
});
