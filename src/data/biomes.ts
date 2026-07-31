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

export type PropKind =
  | "tree"
  | "blossom"
  | "bush"
  | "rock"
  | "flowers"
  | "tuft"
  | "picnic"
  | "palm"
  | "parasol"
  | "driftwood";

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

/**
 * The other end of the country: bleached sand, a hard sun and a sea breeze.
 *
 * A biome is a *mood*, and the two dials that carry it are the grade and the
 * ground. Everything else here follows from "midday at the coast": the sun is
 * higher and whiter than the park's afternoon, the fog is further away because
 * sea air is clear, and the sand is bright enough that the grade pulls the
 * exposure back down rather than letting the whole frame glare.
 *
 * It reuses the park's prop *kinds* wherever a shape does the same job — a rock
 * is a rock, a tuft of grass is dune grass — and adds three that only make
 * sense here. That is the test for a new `PropKind`: it earns its row when no
 * existing shape means the same thing.
 */
export const BEACH: Biome = {
  id: "beach",
  name: "Beach Shack",
  sky: { top: "#5f9fd0", middle: "#9ec9e4", horizon: "#eae2c8" },
  fog: { color: 0xe8e0c8, near: 44, far: 120 },
  sun: { color: 0xfff6e0, intensity: 2.6, azimuth: 122, elevation: 62 },
  fill: { color: 0xcfe0ee, intensity: 0.5 },
  ambient: { sky: 0xe8f0f6, ground: 0xbfa87e, intensity: 0.85 },
  environmentIntensity: 0.62,
  // Sand throws a great deal of light back up. Left at the park's exposure the
  // whole frame sat half a stop hot and the white plates lost their edges.
  exposure: 0.92,
  grade: { saturation: 0.86, warmth: 0.3, lift: 0.012 },
  ground: { base: 0xe0cfa4, patch: 0xd6c395, accent: 0xeadcb8 },
  patio: { edge: 0xc9b489, trim: 0xa8946c, lift: 0.36, overhang: 0.7 },
  path: { color: 0xd8c9a2, count: 7 },
  foliage: [0x5f8f5a, 0x6f9d5e, 0x82a866],
  blossom: [0xe0b070, 0xe8c98d],
  trunk: 0xa8875e,
  rock: 0xb7ac97,
  flowers: [0xefe3b8, 0xdca9a0, 0xc9d3e2],
  timber: 0xc2a173,
  scatter: [
    { kind: "palm", count: 11, minDistance: 3.5, maxDistance: 22, scale: [0.9, 1.5] },
    { kind: "parasol", count: 5, minDistance: 4, maxDistance: 15, scale: [0.9, 1.2] },
    { kind: "driftwood", count: 9, minDistance: 2.5, maxDistance: 20, scale: [0.7, 1.4] },
    { kind: "rock", count: 14, minDistance: 2.5, maxDistance: 24, scale: [0.5, 1.2] },
    { kind: "flowers", count: 40, minDistance: 2, maxDistance: 24, scale: [0.6, 1] },
    { kind: "tuft", count: 220, minDistance: 1.4, maxDistance: 26, scale: [0.6, 1.4] },
  ],
};

/**
 * A layby off a hot road: dry verge, bleached tarmac, a sun going down behind
 * the traffic.
 *
 * The mood is *late* rather than bright — a low amber sun and long shadows,
 * because a drive-through is somewhere you stop on the way to somewhere else,
 * and the whole room is one long wall with a queue against it. It is the first
 * biome with no `path`: nobody walks up to this kitchen, so a run of paving
 * slabs to the door would be a promise about arrival that the lane keeps
 * instead.
 *
 * Every prop kind is one the park already had. A biome earns a new `PropKind`
 * when no existing shape means the same thing, and a dusty verge is scrub,
 * rocks and grass however far the road goes.
 */
export const ROADSIDE: Biome = {
  id: "roadside",
  name: "Highway Stop",
  sky: { top: "#7f93b0", middle: "#c2b4a8", horizon: "#f0cf9c" },
  fog: { color: 0xe4c9a0, near: 26, far: 86 },
  sun: { color: 0xffd9a0, intensity: 2.4, azimuth: 246, elevation: 22 },
  fill: { color: 0xb9bccb, intensity: 0.38 },
  ambient: { sky: 0xd8cdbb, ground: 0x6f6552, intensity: 0.7 },
  environmentIntensity: 0.48,
  exposure: 1.02,
  grade: { saturation: 0.84, warmth: 0.52, lift: 0.01 },
  ground: { base: 0x9c9268, patch: 0x8d8560, accent: 0xa89c74 },
  patio: { edge: 0x8e8a84, trim: 0x74716c, lift: 0.3, overhang: 0.55 },
  path: null,
  foliage: [0x7f8a52, 0x8d955f, 0x6f7a48],
  blossom: [0xd8c07e, 0xe2d09a],
  trunk: 0x7e6a4c,
  rock: 0xa39887,
  flowers: [0xe6d489, 0xd8b98a, 0xcfc7b2],
  timber: 0xa88f68,
  scatter: [
    { kind: "tree", count: 9, minDistance: 5, maxDistance: 24, scale: [0.8, 1.3] },
    { kind: "bush", count: 18, minDistance: 3, maxDistance: 22, scale: [0.6, 1.1] },
    { kind: "rock", count: 20, minDistance: 2.5, maxDistance: 24, scale: [0.5, 1.3] },
    { kind: "flowers", count: 40, minDistance: 2.5, maxDistance: 24, scale: [0.6, 1] },
    { kind: "tuft", count: 240, minDistance: 1.6, maxDistance: 26, scale: [0.6, 1.4] },
  ],
};

export const BIOMES: Record<string, Biome> = {
  park: PARK,
  beach: BEACH,
  roadside: ROADSIDE,
};

export function biome(id: string): Biome {
  const found = BIOMES[id];
  if (!found) throw new Error(`Unknown biome: ${id}`);
  return found;
}
