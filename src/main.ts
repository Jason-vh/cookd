import "./ui/style.css";

/**
 * The entry point, and the one fork in it.
 *
 * `?gallery` opens the model gallery — every model the game can draw, side by
 * side on turntables under the game's own lighting — instead of a kitchen. It
 * is a development tool, so it is guarded by `import.meta.env.DEV` *and*
 * imported dynamically: neither branch is in the other's bundle, and the
 * gallery is in no production bundle at all.
 *
 * The game itself is `shell.ts`, unchanged and unaware that this fork exists.
 */
if (import.meta.env.DEV && new URLSearchParams(location.search).has("gallery")) {
  const { startGallery } = await import("./render/gallery");
  startGallery(document.querySelector<HTMLCanvasElement>("#game")!);
} else {
  await import("./shell");
}
