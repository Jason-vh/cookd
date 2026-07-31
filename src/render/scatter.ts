import type { PropKind, ScatterEntry } from "../data/biomes";

/**
 * Where the scenery goes — as arithmetic, with no three.js in it.
 *
 * This is rejection sampling with a bail-out, and it has three ways to quietly
 * do nothing: the 40-attempt limit gives up silently, a `continue` skips a prop
 * that would not fit, and a scatter budget can therefore under-deliver without
 * anybody noticing that the park has half the trees it asked for. All of that
 * was untestable while it lived in `environment.ts`, which imports three.js and
 * calls `document.createElement` \u2014 the same trap `anim.ts` and `camera.ts` were
 * pulled out of.
 *
 * It is also deterministic on purpose: online, two clients must scatter the
 * same park from the same seed, or the scenery is a per-machine opinion.
 */

/** How much room a prop needs, by kind. */
export type PropSpace = {
  /**
   * Collision radius, deliberately smaller than the visual silhouette: tree
   * canopies and bush tops are *allowed* to overlap, which looks natural. It is
   * the bases that must not collide.
   */
  radius: number;
  /** How far from the kitchen's edge this kind must stay. */
  clearance: number;
};

export type Placement = { entry: ScatterEntry; x: number; z: number };

/**
 * Ground the scenery may not stand on, relative to the kitchen's centre.
 *
 * A list of rectangles rather than one half-width and half-depth, because
 * "paved" stopped being a single rectangle round the building the day the
 * market moved down a path. The keep-out list and the paving the renderer lays
 * are the same rectangles, so a tree cannot grow in the market square.
 */
export type KeepOut = { minX: number; maxX: number; minZ: number; maxZ: number };

type Placed = { x: number; z: number; radius: number };

/** Give up on a spot after this many tries and move on. */
const ATTEMPTS = 40;

/**
 * Positions for every prop a biome asks for, relative to the kitchen's centre.
 *
 * Props are placed largest-first: they are the hardest to fit, and everything
 * else can then arrange itself around them. `random` is consumed in a fixed
 * order so the result is reproducible from a seed.
 */
export function scatter(
  entries: readonly ScatterEntry[],
  space: Record<PropKind, PropSpace>,
  keepOut: readonly KeepOut[],
  random: () => number,
): Placement[] {
  const placed: Placed[] = [];
  const out: Placement[] = [];

  const order = [...entries].sort((a, b) => space[b.kind].radius - space[a.kind].radius);

  for (const entry of order) {
    const { radius, clearance } = space[entry.kind];
    for (let i = 0; i < entry.count; i++) {
      const spot = findSpot(random, entry, radius, clearance, keepOut, placed);
      if (!spot) continue;
      placed.push({ x: spot.x, z: spot.z, radius });
      out.push({ entry, x: spot.x, z: spot.z });
    }
  }
  return out;
}

/**
 * Rejection sampling: anywhere in the ring this entry allows, but never on the
 * paving and never overlapping a prop that is already there.
 */
function findSpot(
  random: () => number,
  entry: ScatterEntry,
  radius: number,
  clearance: number,
  keepOut: readonly KeepOut[],
  placed: readonly Placed[],
): { x: number; z: number } | null {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const angle = random() * Math.PI * 2;
    const distance = entry.minDistance + random() * (entry.maxDistance - entry.minDistance);
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;

    if (keepOut.some((area) => inside(x, z, clearance, area))) continue;
    if (placed.some((other) => overlaps(x, z, radius, other))) continue;
    return { x, z };
  }
  return null;
}

function inside(x: number, z: number, clearance: number, area: KeepOut): boolean {
  return (
    x > area.minX - clearance &&
    x < area.maxX + clearance &&
    z > area.minZ - clearance &&
    z < area.maxZ + clearance
  );
}

function overlaps(x: number, z: number, radius: number, other: Placed): boolean {
  const minimum = radius + other.radius;
  const dx = x - other.x;
  const dz = z - other.z;
  return dx * dx + dz * dz < minimum * minimum;
}
