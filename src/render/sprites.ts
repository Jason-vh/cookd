import * as THREE from "three";
import { markUI } from "./layers";
import { PILL_HEIGHT_PX, cssHex, panelTexture, spriteMaterial, textSprite } from "./text";

/**
 * The two labelled sprites in the world: a chef's name tag, and the contextual
 * name that appears when somebody looks at an appliance.
 *
 * Thin wrappers over `text.ts`, which owns the canvas work. They are separate
 * because the sizes and fonts are art direction and the texture plumbing is not.
 */

/**
 * A name tag above a chef. Only exists online, where there is a name to show.
 */
const TAG_HEIGHT = 0.42;
const TAG_FONT = "700 32px system-ui, -apple-system, Segoe UI, sans-serif";

export function makeNameTag(text: string, color: number): THREE.Sprite {
  return textSprite(
    text,
    {
      font: TAG_FONT,
      color: cssHex(color),
      backing: { kind: "pill", color: "rgba(10,11,16,0.6)" },
      padding: 17,
      supersample: 2,
    },
    TAG_HEIGHT,
    11,
  );
}

const LABEL_HEIGHT = 0.56;
const LABEL_FONT = "700 30px system-ui, sans-serif";

/** The contextual name that appears when a chef looks at an appliance. */
export function makeLabel(text: string, color = 0xffffff): THREE.Sprite {
  return textSprite(
    text,
    {
      font: LABEL_FONT,
      color: cssHex(color),
      backing: { kind: "pill", color: "rgba(10,11,16,0.72)" },
      padding: 24,
      supersample: 2,
    },
    LABEL_HEIGHT,
    10,
  );
}

/**
 * World units per canvas pixel, taken from what a plain label already does.
 *
 * A pill is `LABEL_HEIGHT` tall for `PILL_HEIGHT_PX` of canvas, so this ratio is
 * the size type comes out at everywhere else in the game. Applying it to the
 * card's *own* canvas height is what keeps a four-line card and a one-line
 * label the same to read — rather than the card being a fixed world height that
 * quietly shrinks its type every time a line is added to it.
 */
const CARD_SCALE = LABEL_HEIGHT / PILL_HEIGHT_PX;

export type RecipeCardText = {
  name: string;
  price: string;
  /** What the kitchen would be sent with it, already phrased. */
  delivery: string;
  blurb: string;
};

/**
 * The recipe card a chef reads by standing in front of the board.
 *
 * It is the same object as the print on the A-frame outside — one you look at,
 * one you are close enough to read — so it is drawn as a **card**: cream stock,
 * a rule under the name, the price with it, and the blurb below. It used to be
 * four dark pills of different widths stacked in the air, which is what a
 * debugger shows you, not what a restaurant does.
 *
 * The board itself carries no lettering at all. At the followed camera a panel
 * is about forty pixels across, so this is the only surface in the feature that
 * can actually be read — which is the reason it is worth drawing properly.
 */
export function makeRecipeCard(text: RecipeCardText, tint = 0xffffff): THREE.Sprite {
  const ink = cssHex(tint === 0xffffff ? 0x2f2a24 : tint);
  const muted = cssHex(tint === 0xffffff ? 0x6f6357 : tint);
  const drawn = panelTexture(
    [
      { text: text.name, font: "700 30px Georgia, system-ui, serif", color: ink },
      { text: text.price, font: "700 26px system-ui, sans-serif", color: ink, gap: 4 },
      {
        text: text.blurb,
        font: "italic 22px Georgia, system-ui, serif",
        color: muted,
        gap: 14,
        rule: true,
      },
      { text: text.delivery, font: "600 21px system-ui, sans-serif", color: muted, gap: 8 },
    ].filter((line) => line.text !== ""),
    { stock: "rgba(244,234,214,0.97)", edge: "rgba(47,42,36,0.35)", padding: 22, radius: 14 },
  );
  const height = drawn.pixelHeight * CARD_SCALE;
  const sprite = new THREE.Sprite(spriteMaterial(drawn.texture));
  sprite.scale.set(height * drawn.aspect, height, 1);
  sprite.renderOrder = 10;
  markUI(sprite);
  return sprite;
}
