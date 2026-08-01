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
  /**
   * The canvas's own height in pixels.
   *
   * What a caller needs to size a sprite so that **type comes out the same size
   * on screen** whatever is drawn on it. A single-line pill is always
   * `PILL_HEIGHT_PX` tall, so one world height suits every one of them; a panel
   * is as tall as its contents came to, and scaling that to a fixed world
   * height shrinks the type as lines are added — which is exactly how a
   * four-line card ended up rendered at a quarter of label size.
   */
  pixelHeight: number;
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

/**
 * The canvas height of a single-line pill, and the reference every other drawn
 * surface is scaled against. See `TextTexture.pixelHeight`.
 */
export const PILL_HEIGHT_PX = 64;
const CANVAS_HEIGHT = PILL_HEIGHT_PX;

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

  return {
    texture: canvasTexture(element),
    aspect: width / CANVAS_HEIGHT,
    pixelHeight: CANVAS_HEIGHT,
  };
}

/** The four non-obvious settings every text texture in this game needs. */
function canvasTexture(element: HTMLCanvasElement): THREE.Texture {
  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  // See the note at the top: mipmaps turn small text into a smudge.
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  return texture;
}

/** One line of a drawn panel: its text, its font, its colour, and how it sits. */
export type PanelLine = {
  text: string;
  font: string;
  color: string;
  /** Space above this line, in canvas pixels. A rule is drawn in it if `rule`. */
  gap?: number;
  rule?: boolean;
};

export type PanelStyle = {
  stock: string;
  edge: string;
  padding: number;
  radius: number;
};

/**
 * A drawn panel: several lines of type on one piece of stock, as one texture.
 *
 * The alternative, and what this replaced, is a sprite per line. That is fine
 * for two lines and wrong for four: each pill is only as wide as its own
 * string, so a name, a price and a note arrive as three different widths of
 * dark lozenge stacked in the air, and the result reads as debug output rather
 * than as something the game meant to show you.
 *
 * One canvas means one shape, one margin and one alignment for the whole thing
 * — which is the difference between text in chips and a card.
 *
 * Sized to its own contents in both directions, so the caller never picks a box
 * and hopes: the width is the widest line plus padding, and the height is what
 * the lines and their gaps actually came to.
 */
export function panelTexture(lines: PanelLine[], style: PanelStyle): TextTexture {
  const key = `panel|${lines.map((l) => `${l.text}~${l.font}~${l.color}~${l.gap ?? 0}~${l.rule ? 1 : 0}`).join("|")}|${style.stock}|${style.edge}|${style.padding}|${style.radius}`;
  const cached = textures.get(key);
  if (cached) return cached;

  const scale = 2;
  const measure = context(document.createElement("canvas"));
  let width = 0;
  let height = style.padding;
  const tops: number[] = [];
  for (const line of lines) {
    measure.font = line.font;
    width = Math.max(width, Math.ceil(measure.measureText(line.text).width));
    height += line.gap ?? 0;
    tops.push(height);
    height += lineHeight(line.font);
  }
  width += style.padding * 2;
  height += style.padding;

  const element = document.createElement("canvas");
  element.width = width * scale;
  element.height = height * scale;
  const ctx = context(element);
  // After the resize, always: changing a canvas's size resets its context.
  ctx.scale(scale, scale);

  ctx.fillStyle = style.stock;
  roundRect(ctx, 0.5, 0.5, width - 1, height - 1, style.radius);
  ctx.fill();
  ctx.strokeStyle = style.edge;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const [index, line] of lines.entries()) {
    const top = tops[index] ?? 0;
    if (line.rule) {
      // Centred in the gap above the line it belongs to, and inset from both
      // margins so it reads as a rule rather than as the edge of something.
      const y = Math.round(top - (line.gap ?? 0) / 2) + 0.5;
      ctx.strokeStyle = style.edge;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(style.padding, y);
      ctx.lineTo(width - style.padding, y);
      ctx.stroke();
    }
    ctx.font = line.font;
    ctx.fillStyle = line.color;
    ctx.fillText(line.text, width / 2, top);
  }

  const drawn = { texture: canvasTexture(element), aspect: width / height, pixelHeight: height };
  textures.set(key, drawn);
  return drawn;
}

/** The line box for a CSS font shorthand: its pixel size plus a little leading. */
function lineHeight(font: string): number {
  const size = /(\d+(?:\.\d+)?)px/.exec(font);
  return Math.round(Number(size?.[1] ?? 16) * 1.32);
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
