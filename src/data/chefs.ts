/**
 * The wardrobe: what a chef is wearing.
 *
 * Content rather than palette, for the same reason customers' coats are
 * (`customers.ts`): a colour somebody *chooses* is a thing the game is about,
 * it travels on the wire as an id, and it has to mean the same on every screen.
 * `render/palette.ts` keeps the colours nobody picks.
 *
 * Two dials, and they answer different questions. An **outfit** is who you are
 * in a room of four chefs, so there is one per seat the server allows and the
 * kitchen guarantees they are all different — see `pickOutfit`. A **hat** is
 * yours to keep whatever else is going on, so two chefs may wear the same one.
 *
 * Both stay inside the uniform: hats are chef's whites like the apron, because
 * a toque and an apron are what say *staff* from across the dining room, and a
 * customisation that made a chef read as a diner would be buying personality
 * with the one distinction the game cannot afford to lose.
 */

export type ChefOutfit = {
  id: string;
  name: string;
  color: number;
};

/**
 * One per player a room can hold, so nobody is ever forced to double up.
 *
 * Dusty and distinguishable — and a deliberately different family from the
 * customer coats in `customers.ts`, which is the same rule read from the other
 * side: who works here must never be a question.
 */
export const CHEF_OUTFITS: ChefOutfit[] = [
  { id: "blue", name: "Blue", color: 0x6690b5 },
  { id: "terracotta", name: "Terracotta", color: 0xcf8163 },
  { id: "violet", name: "Violet", color: 0x9a80b5 },
  { id: "green", name: "Green", color: 0x74a37c },
  { id: "teal", name: "Teal", color: 0x4f9fa3 },
  { id: "amber", name: "Amber", color: 0xd2a24c },
  { id: "rose", name: "Rose", color: 0xc0657a },
  { id: "indigo", name: "Indigo", color: 0x5f6fa8 },
];

/** Hat shapes `render/person-mesh.ts` knows how to build. */
export const CHEF_HATS = [
  { id: "toque", name: "Toque" },
  { id: "cap", name: "Cap" },
  { id: "bandana", name: "Bandana" },
  { id: "beanie", name: "Beanie" },
] as const;

export type HatId = (typeof CHEF_HATS)[number]["id"];
export type ChefHat = (typeof CHEF_HATS)[number];

/** How a chef is dressed: one outfit id, one hat id. */
export type Appearance = {
  outfit: string;
  hat: string;
};

export const DEFAULT_APPEARANCE: Appearance = { outfit: "blue", hat: "toque" };

const OUTFITS_BY_ID = new Map(CHEF_OUTFITS.map((outfit) => [outfit.id, outfit]));
const HATS_BY_ID = new Map<string, ChefHat>(CHEF_HATS.map((hat) => [hat.id, hat]));

/**
 * Resolve an id, falling back rather than throwing.
 *
 * Ids arrive over the wire and out of localStorage, and both can be a deploy
 * behind: dressing somebody in the default is wrong in a way only they will
 * notice, while refusing the frame would freeze the kitchen over a hat. Same
 * reasoning as `customerKind`.
 */
export function chefOutfit(id: string): ChefOutfit {
  return OUTFITS_BY_ID.get(id) ?? CHEF_OUTFITS[0]!;
}

export function chefHat(id: string): ChefHat {
  return HATS_BY_ID.get(id) ?? CHEF_HATS[0];
}

/**
 * The outfit somebody asked for, or the nearest free one.
 *
 * Two players who both chose blue would be two identical chefs, and a co-op
 * kitchen where you cannot tell which one you are is worse than one where you
 * did not get your first choice. Which is exactly what happens on a sofa: four
 * seats share one browser, so they share one saved preference.
 *
 * Preference, not instruction — the same bargain the join screen's level
 * picker makes. Resolved once, where the players are, so every screen is told
 * the answer instead of computing its own.
 */
export function pickOutfit(wanted: string, taken: readonly string[]): string {
  const known = OUTFITS_BY_ID.has(wanted) ? wanted : DEFAULT_APPEARANCE.outfit;
  if (!taken.includes(known)) return known;
  const free = CHEF_OUTFITS.find((outfit) => !taken.includes(outfit.id));
  // More chefs than outfits should be impossible — there is one per seat — but
  // a room that grew would rather double up than refuse somebody a body.
  return free?.id ?? known;
}
