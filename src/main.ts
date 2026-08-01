import "./ui/style.css";

/**
 * The entry point, and the one fork in it.
 *
 * `?gallery` opens the model gallery — every model the game can draw, side by
 * side on turntables under the game's own lighting — instead of a kitchen.
 *
 * `?kitchens` opens the floor-plan sheet: fifty generated kitchens at once,
 * with the two hand-drawn ones beside them for scale. The gallery answers "what
 * does a fryer look like"; this answers "is that a restaurant or a shape",
 * which is a question no single kitchen can be asked.
 *
 * Both are development tools, so both are guarded by `import.meta.env.DEV`
 * *and* imported dynamically: no branch is in another's bundle, and neither is
 * in a production bundle at all.
 *
 * The game itself is `shell.ts`, unchanged and unaware that this fork exists.
 */
const params = new URLSearchParams(location.search);

if (import.meta.env.DEV && params.has("gallery")) {
  const { startGallery } = await import("./render/gallery");
  startGallery(document.querySelector<HTMLCanvasElement>("#game")!);
} else if (import.meta.env.DEV && params.has("kitchens")) {
  const { startKitchens } = await import("./ui/kitchens");
  const asked = Number(params.get("kitchens"));
  const sheet = document.createElement("div");
  document.body.append(sheet);
  startKitchens(sheet, Number.isFinite(asked) && asked > 0 ? Math.min(asked, 500) : 50);
} else {
  await import("./shell");
}
