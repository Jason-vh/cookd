import * as THREE from "three";
import { LAYER, setLayer } from "./layers";
import { cssHex, spriteMaterial, textTexture, type TextStyle } from "./text";

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

/**
 * The look of a popup: an outlined value, not a pill.
 *
 * An outline rather than a background because these float over the room rather
 * than labelling a thing in it, and supersampled because they are read at a
 * glance while both they and the chef under them are moving.
 */
const STYLE: TextStyle = {
  font: "800 34px system-ui, -apple-system, Segoe UI, sans-serif",
  color: "#ffffff",
  // Drawn centred on the glyph edge, so it spills half its width outside the
  // text box; the padding below is what stops that being clipped.
  backing: { kind: "outline", color: "rgba(14,15,20,0.85)", width: 7 },
  padding: 14,
  supersample: 3,
};

export class Popups {
  private readonly live: Popup[] = [];
  private readonly pool: THREE.Sprite[] = [];

  constructor(private readonly scene: THREE.Scene) {}

  spawn(text: string, color: number, x: number, y: number, z: number): void {
    const sprite = this.pool.pop() ?? this.make();
    const label = textTexture(text, { ...STYLE, color: cssHex(color) });
    const mat = material(sprite);
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
      const mat = material(popup.sprite);
      mat.opacity = t < 0.66 ? 1 : 1 - (t - 0.66) / 0.34;
      const pop = t < 0.16 ? 0.7 + 0.3 * (t / 0.16) : 1;
      popup.sprite.scale.set(HEIGHT * popup.aspect * pop, HEIGHT * pop, 1);
    }
  }

  private make(): THREE.Sprite {
    // Its own material per pooled sprite: the map and opacity are both animated
    // per popup, so a shared one would make every live popup fade together.
    const sprite = new THREE.Sprite(spriteMaterial(EMPTY));
    sprite.renderOrder = 20;
    setLayer(sprite, LAYER.UI);
    return sprite;
  }

  /** Release every sprite this pool is holding, live or spare. */
  dispose(): void {
    for (const popup of this.live) this.scene.remove(popup.sprite);
    for (const sprite of [...this.live.map((p) => p.sprite), ...this.pool]) {
      material(sprite).dispose();
    }
    this.live.length = 0;
    this.pool.length = 0;
  }
}

/**
 * Placeholder map for a freshly pooled sprite, replaced on its first `spawn`.
 * Shared and never drawn, so one is enough.
 */
const EMPTY = new THREE.Texture();

/**
 * A sprite's material as the single sprite material it is.
 *
 * `Sprite.material` is typed loosely enough that reading `.opacity` needs
 * narrowing; this states the invariant once rather than casting at four call
 * sites.
 */
function material(sprite: THREE.Sprite): THREE.SpriteMaterial {
  if (!(sprite.material instanceof THREE.SpriteMaterial)) {
    throw new Error("popup sprite lost its material");
  }
  return sprite.material;
}
