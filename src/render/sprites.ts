import type * as THREE from "three";
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
export function makeLabel(text: string): THREE.Sprite {
  return textSprite(
    text,
    {
      font: LABEL_FONT,
      color: "#ffffff",
      backing: { kind: "pill", color: "rgba(10,11,16,0.72)" },
      padding: 24,
      supersample: 2,
    },
    LABEL_HEIGHT,
    10,
  );
}
