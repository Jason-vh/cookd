/**
 * The whole colour language of the game, in one place.
 *
 * Art direction: **warm enamel**. Think enamelware — cream and eggshell bodies,
 * muted sage and dusty teal accents, warm woods, charcoal rims, and a soft
 * glossy sheen rather than a matte or metallic one. Everything is desaturated
 * and pushed warm; nothing is allowed to shout.
 *
 * Readability is still a gameplay concern, but it is now handled by *relative*
 * saturation rather than absolute: the kitchen is muted enough that food, which
 * is only mildly saturated itself, is comfortably the most colourful thing on
 * screen.
 *
 * The world outside the kitchen walls lives in `data/biomes.ts`.
 */

export const PALETTE = {
  // --- kitchen paving ---
  // Warm greige, mid-tone: light enough to feel like a real floor, dark enough
  // that cream enamel appliances read clearly against it.
  floorLight: 0x8e8477,
  floorDark: 0x867c6f,
  floorGrout: 0x726a5f,

  // --- structure ---
  wall: 0xb3a58c,
  wallLow: 0x9c8f76,
  wallTrim: 0xc3b69c,

  // --- appliances ---
  wood: 0xb08d63,
  woodTop: 0xc8a880,
  boardTop: 0xdcc59d,
  steel: 0xb8b2a6,
  steelDark: 0x6f6a61,
  ovenGlass: 0x33302b,
  oil: 0xd8b167,
  ember: 0xff7a2e,
  progressCook: 0xf0b24a,
  flourSack: 0xe4dcc6,
  pail: 0xb8c6cc,
  pailRim: 0x8d9aa1,
  water: 0x5aa3cc,
  waterShine: 0xa8d8ef,
  // Deep enamel bodies, so the two heat appliances read at a glance against
  // the cream-and-wood kitchen instead of blending into it.
  // Classic enamel range: cream body, charcoal hotplate. The camera sees a lot
  // of the top face, so the *top* is what makes an appliance identifiable.
  ovenBody: 0xdfd4c0,
  fryerBody: 0xa96b55,
  crate: 0x9c7a52,
  crateTop: 0x87683f,
  crateTrim: 0x765a37,
  ceramic: 0xf1ece0,
  serving: 0x6f968b,
  servingTop: 0x93c0b1,
  bin: 0x4a453e,
  brass: 0xc9a86b,

  // --- food (mildly saturated: the warmest, brightest things on screen) ---
  tomato: 0xcf5642,
  lettuce: 0x82ab54,
  cheese: 0xe6c069,
  dough: 0xead9bb,
  potato: 0xc39a68,
  pizza: 0xd2a468,
  salad: 0x87b257,
  fries: 0xe0b263,
  burnt: 0x33302b,

  // --- food detail colours (used by the sculpted models) ---
  tomatoFlesh: 0xe08170,
  stem: 0x7d9a55,
  leafLight: 0x9cc06d,
  leafMid: 0x82ab54,
  leafDark: 0x638d40,
  cheeseRind: 0xd6ad55,
  cheeseHole: 0xcda44e,
  doughDust: 0xf3e8d2,
  potatoEye: 0x8a6c47,
  potatoFlesh: 0xdfcda2,
  crustRaw: 0xdfc396,
  crustBaked: 0xc09059,
  sauce: 0xb45340,
  sauceShine: 0xcf6a52,
  pepperoni: 0x9d5344,
  carton: 0xc4705c,
  cartonLip: 0xefe9dd,

  // --- chefs (dusty, distinguishable without being loud) ---
  chefs: [0x6690b5, 0xcf8163, 0x9a80b5, 0x74a37c],
  chefWhites: 0xf2ece0,
  skin: 0xe3bd97,

  // --- customers ---
  // Deliberately a *different* family from the chef colours: at a glance across
  // the room, who works here must never be a question. Softer and cooler, so
  // the four chef colours stay the brightest people on screen.
  customers: [0xc7a98c, 0x8fa3ad, 0xb59aa8, 0x9fae8f, 0xc3b184, 0xa79bb5],
  customerLegs: 0x7b7466,
  hair: 0x4c4038,

  // --- tips ---
  coin: 0xd9b45c,
  coinEdge: 0xbf9741,

  // --- used crockery ---
  plateDirty: 0xd8d2c4,
  crumbs: 0xa8895f,

  // --- feedback ---
  progressGood: 0x8fc47f,
  progressBurn: 0xcb6a4c,
} as const;

/**
 * Surface finishes.
 *
 * `enamel` is the signature one: low roughness, essentially no metalness. That
 * gives a soft broad highlight — glossy like a fired enamel mug rather than
 * mirror-like.
 *
 * Note on metalness: a fully metallic surface *is* its reflections, so without
 * a rich environment it renders near-black. Stylised scenes want semi-metals at
 * most.
 */
export const SURFACE = {
  enamel: { roughness: 0.3, metalness: 0.04 },
  wood: { roughness: 0.78, metalness: 0.0 },
  metal: { roughness: 0.32, metalness: 0.3 },
  paintedMetal: { roughness: 0.45, metalness: 0.1 },
  ceramic: { roughness: 0.22, metalness: 0.0 },
  food: { roughness: 0.58, metalness: 0.0 },
  cloth: { roughness: 0.88, metalness: 0.0 },
  stone: { roughness: 0.92, metalness: 0.0 },
} as const;

export type SurfaceName = keyof typeof SURFACE;
