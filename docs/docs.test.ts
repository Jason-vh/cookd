import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Do the docs still describe this codebase?
 *
 * The README used to carry a file tree with a one-line description of every
 * module. It was genuinely useful and it was wrong: it listed `view.ts` as
 * owning "scene, camera, animation, reconciliation" long after four of those
 * had moved out, and it had no entry for ten files that existed. Nobody
 * noticed, because nothing could.
 *
 * That is the real problem with a large hand-written document, and splitting it
 * into ten smaller hand-written documents does not fix it. This does: adding a
 * module without describing it fails `bun run check`, and so does describing one
 * that no longer exists.
 *
 * Deliberately *not* generated. The point of the tree is the one-line
 * description beside each path — the part a generator cannot write — so the
 * tree stays hand-authored and the test only checks that it is complete.
 */

const ROOT = new URL("..", import.meta.url).pathname;

/** Every source file a reader would expect to find described. */
async function sourceFiles(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        found.push(path);
      }
    }
  };
  await walk("src");
  await walk("server");
  return found.sort();
}

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
  test("describes every module, and only modules that exist", async () => {
    const actual = await sourceFiles();
    const documented = await documentedFiles();

    const undocumented = actual.filter((path) => !documented.includes(path));
    const stale = documented.filter((path) => !actual.includes(path));

    // Reported as two separate lists so the failure says which mistake it is.
    expect({ undocumented, stale }).toEqual({ undocumented: [], stale: [] });
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
