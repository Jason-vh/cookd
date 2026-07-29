import * as THREE from "three";
import { LAYER, setLayer } from "./layers";

/**
 * Floating "+$12" text that rises off a chef's head when they serve.
 *
 * The number is the only feedback that says *how well* you did — the money
 * counter in the HUD is a running total nobody watches mid-service, and a tip
 * for a fast serve is invisible there. Putting it on the chef ties the reward
 * to the action and the player who made it.
 *
 * Sprites are pooled and drawn on the UI layer, so they cast no shadow and stay
 * out of any pass that rebuilds the scene (see layers.ts).
 */

const LIFETIME = 1.1;
const RISE = 0.9;
/** World height of the text. Width follows from what the text measures. */
const HEIGHT = 0.55;

type Popup = {
  sprite: THREE.Sprite;
  age: number;
  origin: THREE.Vector3;
  /** Width per unit height of this popup's text, kept for the pop-in scale. */
  aspect: number;
};

type Label = { texture: THREE.Texture; aspect: number };

const textureCache = new Map<string, Label>();

const FONT = "800 34px system-ui, -apple-system, Segoe UI, sans-serif";

/**
 * Text on a canvas, **fitted to the text**.
 *
 * It used to be a fixed 128x64 box with the string centred in it, which worked
 * for as long as every popup was "+$12". The first one that said "walked out"
 * ran off both ends of its own texture and rendered as a smear. Measuring first
 * is the same fix `makeNameTag` already carries, for the same reason — nothing
 * about a popup should care how many characters it has.
 */
function textTexture(text: string, color: string): Label {
  const key = `${text}|${color}`;
  const cached = textureCache.get(key);
  if (cached) return cached;

  const scale = 3; // supersample: these are read at a glance, mid-motion
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = FONT;
  // Padding leaves room for the outline, which is drawn centred on the glyph
  // edge and so spills half its width outside the text box.
  const padding = 14;
  const width = Math.ceil(measure.measureText(text).width) + padding * 2;
  const height = 64;

  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d")!;
  // Every context setting below has to come *after* the resize: changing a
  // canvas's dimensions resets its 2D context to defaults.
  ctx.scale(scale, scale);
  ctx.font = FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  // Outline first so the value stays legible over any biome or appliance.
  ctx.lineWidth = 7;
  ctx.strokeStyle = "rgba(14,15,20,0.85)";
  ctx.strokeText(text, width / 2, height / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, width / 2, height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.generateMipmaps = false; // mipmaps turn small text to mush
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  const label = { texture, aspect: width / height };
  textureCache.set(key, label);
  return label;
}

export class Popups {
  private readonly live: Popup[] = [];
  private readonly pool: THREE.Sprite[] = [];

  constructor(private readonly scene: THREE.Scene) {}

  spawn(text: string, color: string, x: number, y: number, z: number): void {
    const sprite = this.pool.pop() ?? this.make();
    const label = textTexture(text, color);
    const mat = sprite.material as THREE.SpriteMaterial;
    mat.map = label.texture;
    mat.opacity = 1;
    // Sized per popup, so every string renders at the same letter height
    // whatever its length.
    sprite.scale.set(HEIGHT * label.aspect, HEIGHT, 1);
    sprite.visible = true;
    sprite.position.set(x, y, z);
    this.scene.add(sprite);
    this.live.push({ sprite, age: 0, origin: new THREE.Vector3(x, y, z), aspect: label.aspect });
  }

  update(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const popup = this.live[i]!;
      popup.age += dt;
      const t = popup.age / LIFETIME;
      if (t >= 1) {
        this.scene.remove(popup.sprite);
        popup.sprite.visible = false;
        this.pool.push(popup.sprite);
        this.live.splice(i, 1);
        continue;
      }
      // Rise fast then coast, and only fade over the last third — a number that
      // starts fading immediately reads as a glitch rather than a reward.
      popup.sprite.position.y = popup.origin.y + RISE * (1 - (1 - t) * (1 - t));
      const mat = popup.sprite.material as THREE.SpriteMaterial;
      mat.opacity = t < 0.66 ? 1 : 1 - (t - 0.66) / 0.34;
      const pop = t < 0.16 ? 0.7 + 0.3 * (t / 0.16) : 1;
      popup.sprite.scale.set(HEIGHT * popup.aspect * pop, HEIGHT * pop, 1);
    }
  }

  private make(): THREE.Sprite {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, fog: false }),
    );
    sprite.renderOrder = 20;
    setLayer(sprite, LAYER.UI);
    return sprite;
  }
}
