/**
 * Biomes: where a kitchen is located.
 *
 * A biome owns everything outside the kitchen walls — sky, sunlight, ground and
 * the props scattered around it. Levels reference one by id, so adding a
 * location (beach, night market, ski lodge, space station) means adding an
 * entry here plus, at most, a new prop builder in `render/environment.ts`.
 *
 * This is content: plain data, no logic, no three.js.
 */

export type PropKind = "tree" | "blossom" | "bush" | "rock" | "flowers" | "tuft" | "picnic";

export type ScatterEntry = {
  kind: PropKind;
  count: number;
  /** Ring around the kitchen, in tiles, that props are scattered into. */
  minDistance: number;
  maxDistance: number;
  /** Random uniform scale range. */
  scale: [number, number];
};

export type Biome = {
  id: string;
  name: string;
  /** Background gradient, top to bottom. */
  sky: { top: string; middle: string; horizon: string };
  fog: { color: number; near: number; far: number };
  /** Sun direction in degrees: azimuth around Y, elevation above the horizon. */
  sun: { color: number; intensity: number; azimuth: number; elevation: number };
  fill: { color: number; intensity: number };
  ambient: { sky: number; ground: number; intensity: number };
  environmentIntensity: number;
  exposure: number;
  /**
   * Global colour grade applied as a post pass. One dial for the whole look:
   * `saturation` below 1 pulls colour out, `warmth` above 0 pushes the image
   * toward amber, `lift` raises the blacks so shadows stay soft rather than
   * crushing to near-black.
   */
  grade: { saturation: number; warmth: number; lift: number };
  ground: { base: number; patch: number; accent: number };
  /** The raised platform the kitchen sits on. */
  patio: { edge: number; trim: number; lift: number; overhang: number };
  /** Paving slabs leading away from the serving side. */
  path: { color: number; count: number } | null;
  scatter: ScatterEntry[];
  /** Prop palettes, indexed randomly per instance. */
  foliage: number[];
  blossom: number[];
  trunk: number;
  rock: number;
  flowers: number[];
  timber: number;
};

export const PARK: Biome = {
  id: "park",
  name: "City Park",
  // A hazy warm afternoon rather than a poster-bright midday.
  sky: { top: "#a9bccb", middle: "#cbd3d2", horizon: "#e9e0cf" },
  fog: { color: 0xdcd5c6, near: 30, far: 92 },
  sun: { color: 0xffeccd, intensity: 2.2, azimuth: 38, elevation: 46 },
  fill: { color: 0xbfc9d6, intensity: 0.42 },
  ambient: { sky: 0xdcd9cd, ground: 0x6d6a4c, intensity: 0.72 },
  environmentIntensity: 0.5,
  exposure: 1.0,
  grade: { saturation: 0.9, warmth: 0.38, lift: 0.006 },
  ground: { base: 0x8d9a66, patch: 0x84915e, accent: 0x99a672 },
  patio: { edge: 0x9a8c76, trim: 0x847860, lift: 0.36, overhang: 0.7 },
  path: { color: 0xc0b4a0, count: 7 },
  foliage: [0x6f8f52, 0x7d9a5c, 0x628247, 0x88a468],
  blossom: [0xd9a8b4, 0xe4bec5],
  trunk: 0x8a6b4e,
  rock: 0x9d9488,
  flowers: [0xe8d98a, 0xefe9dd, 0xd39fae, 0xb09ac6],
  timber: 0xb5906a,
  scatter: [
    { kind: "tree", count: 14, minDistance: 3.5, maxDistance: 22, scale: [0.85, 1.45] },
    { kind: "blossom", count: 4, minDistance: 4, maxDistance: 20, scale: [0.8, 1.15] },
    { kind: "bush", count: 22, minDistance: 2.2, maxDistance: 20, scale: [0.7, 1.3] },
    { kind: "rock", count: 12, minDistance: 2.5, maxDistance: 24, scale: [0.6, 1.4] },
    { kind: "picnic", count: 3, minDistance: 4.5, maxDistance: 13, scale: [0.95, 1.1] },
    { kind: "flowers", count: 70, minDistance: 2, maxDistance: 24, scale: [0.7, 1.2] },
    { kind: "tuft", count: 260, minDistance: 1.4, maxDistance: 26, scale: [0.6, 1.5] },
  ],
};

export const BIOMES: Record<string, Biome> = {
  park: PARK,
};

export function biome(id: string): Biome {
  const found = BIOMES[id];
  if (!found) throw new Error(`Unknown biome: ${id}`);
  return found;
}
