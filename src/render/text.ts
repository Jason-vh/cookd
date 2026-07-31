import * as THREE from "three";
import { markUI } from "./layers";

/**
 * Text as a texture, and text as a sprite, in one place.
 *
 * There were three of these: `makeNameTag`, `makeLabel` and popups.ts's
 * `textTexture`. Each measured the string, sized a canvas to it, drew a
 * backing, and built a CanvasTexture with the same four non-obvious settings —
 * and the reason all three had the same four is that each was arrived at
 * separately, by hitting the same bug.
 *
 * `generateMipmaps: false` is the clearest example. At the size these draw on
 * screen the minified mip levels average the text into whatever is behind it
 * and the label becomes a grey smudge. That was found and fixed twice, in two
 * files, months apart. `fog: false` is the same story: sprites are UI, and
 * without it a label on the far side of the kitchen fades into the background
 * along with the scenery. So is measuring the string before sizing the canvas —
 * fixed once for name tags when "Cassandra" and "Bo" got the same box, and
 * again for popups when "walked out" ran off both ends of its own texture.
 *
 * Three fixes, each carried once, each having to be found twice. One
 * implementation means the next one is carried once and found once.
 */

export type TextStyle = {
  /** CSS font shorthand. */
  font: string;
  color: string;
  /**
   * How the text is separated from what is behind it. A pill reads as a label
   * on a thing; an outline reads as a value floating over the room.
   */
  backing: { kind: "pill"; color: string } | { kind: "outline"; color: string; width: number };
  /** Horizontal padding around the measured text, in canvas pixels. */
  padding: number;
  /** Draw at this multiple and let the GPU downsample. For text read mid-motion. */
  supersample?: number;
};

export type TextTexture = {
  texture: THREE.Texture;
  /** Width per unit height, so a sprite can be scaled to fit its own string. */
  aspect: number;
};

/**
 * Cached by full appearance, never evicted.
 *
 * Bounded in practice by the strings the game can produce: appliance labels are
 * a fixed set, popups are money amounts and a handful of phrases, name tags are
 * one per player per colour. A long-lived public room that saw thousands of
 * distinct names would accumulate a canvas each — worth knowing, not worth an
 * LRU until a room stays up long enough for it to matter.
 */
const textures = new Map<string, TextTexture>();
const materials = new Map<string, THREE.SpriteMaterial>();

const CANVAS_HEIGHT = 64;

function keyOf(text: string, style: TextStyle): string {
  const backing =
    style.backing.kind === "pill"
      ? `pill:${style.backing.color}`
      : `outline:${style.backing.color}:${style.backing.width}`;
  return `${text}|${style.font}|${style.color}|${backing}|${style.padding}|${style.supersample ?? 1}`;
}

export function textTexture(text: string, style: TextStyle): TextTexture {
  const key = keyOf(text, style);
  const cached = textures.get(key);
  if (cached) return cached;
  const drawn = draw(text, style);
  textures.set(key, drawn);
  return drawn;
}

/** A sprite scaled to `height` in world units, as wide as its own text needs. */
export function textSprite(
  text: string,
  style: TextStyle,
  height: number,
  order = 10,
): THREE.Sprite {
  const key = keyOf(text, style);
  let material = materials.get(key);
  if (!material) {
    material = spriteMaterial(textTexture(text, style).texture);
    materials.set(key, material);
  }
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(height * textTexture(text, style).aspect, height, 1);
  sprite.renderOrder = order;
  markUI(sprite);
  return sprite;
}

export function spriteMaterial(texture: THREE.Texture): THREE.SpriteMaterial {
  return new THREE.SpriteMaterial({
    map: texture,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    // Sprites are UI. Without this, scene fog fades a label on the far side of
    // the kitchen into the background along with the scenery behind it.
    fog: false,
    toneMapped: false,
  });
}

function draw(text: string, style: TextStyle): TextTexture {
  const scale = style.supersample ?? 1;

  // Measured, never fixed-width. See the note at the top of the file.
  const measure = context(document.createElement("canvas"));
  measure.font = style.font;
  const width = Math.max(1, Math.ceil(measure.measureText(text).width) + style.padding * 2);

  const element = document.createElement("canvas");
  element.width = width * scale;
  element.height = CANVAS_HEIGHT * scale;
  const ctx = context(element);
  // Every context setting below has to come *after* the resize: changing a
  // canvas's dimensions resets its 2D context to defaults.
  ctx.scale(scale, scale);

  if (style.backing.kind === "pill") {
    ctx.fillStyle = style.backing.color;
    roundRect(ctx, 0, CANVAS_HEIGHT * 0.2, width, CANVAS_HEIGHT * 0.6, CANVAS_HEIGHT * 0.3);
    ctx.fill();
  }

  ctx.font = style.font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (style.backing.kind === "outline") {
    // Outline first, so the value stays legible over any biome or appliance.
    ctx.lineJoin = "round";
    ctx.lineWidth = style.backing.width;
    ctx.strokeStyle = style.backing.color;
    ctx.strokeText(text, width / 2, CANVAS_HEIGHT / 2);
  }
  ctx.fillStyle = style.color;
  ctx.fillText(text, width / 2, CANVAS_HEIGHT / 2);

  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  // See the note at the top: mipmaps turn small text into a smudge.
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;

  return { texture, aspect: width / CANVAS_HEIGHT };
}

function context(element: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = element.getContext("2d");
  if (!ctx) throw new Error("2d canvas is unavailable");
  return ctx;
}

/**
 * A square canvas and its context.
 *
 * The same four lines appeared in `meshes.ts`, twice in `environment.ts` and
 * once here — which, for a file whose own header is an essay about carrying a
 * fix once, was one site too many.
 */
export function canvas2d(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement("canvas");
  element.width = size;
  element.height = size;
  return [element, context(element)];
}

/** A palette entry as CSS, for the many places a colour number meets a canvas. */
export function cssHex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}
