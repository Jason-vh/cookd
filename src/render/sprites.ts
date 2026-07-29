import * as THREE from "three";
import { cssHex, textSprite } from "./text";

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

const CARD_LINE_HEIGHT = 0.38;
const CARD_LINE_FONT = "600 26px system-ui, sans-serif";

/**
 * A stacked, multi-line contextual label: what a recipe card actually says.
 *
 * A card has four things to tell you — the dish, what it pays, how it is made,
 * and what it will have delivered — and one pill of running text is a sentence
 * nobody reads while standing in front of it. Lines are separate sprites rather
 * than one multi-line canvas so each is only as wide as its own string, which
 * is the same reason `textSprite` measures before it sizes.
 *
 * The first line is the dish and is drawn at full label size; the rest are the
 * detail, and are smaller because they are read second.
 */
export function makeCardLabel(lines: string[], color = 0xffffff): THREE.Object3D {
  const group = new THREE.Group();
  let y = 0;
  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    const sprite =
      index === 0
        ? makeLabel(line, color)
        : textSprite(
            line,
            {
              font: CARD_LINE_FONT,
              color: cssHex(color),
              backing: { kind: "pill", color: "rgba(10,11,16,0.72)" },
              padding: 20,
              supersample: 2,
            },
            CARD_LINE_HEIGHT,
            10,
          );
    sprite.position.y = y;
    group.add(sprite);
    y -= index === 0 ? LABEL_HEIGHT * 0.92 : CARD_LINE_HEIGHT * 0.92;
  }
  return group;
}
