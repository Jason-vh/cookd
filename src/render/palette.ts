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
  // The bell oven, a tier up: the same range in dark enamel, so an upgrade is
  // legible as "the good one" from across the kitchen without changing shape.
  ovenBodyPro: 0x3f4550,
  fryerBody: 0xa96b55,
  crate: 0x9c7a52,
  crateTop: 0x87683f,
  crateTrim: 0x765a37,
  /** Behind the slats: dark enough that the gaps read as a shadowed inside. */
  crateInner: 0x4f3b25,
  // The market stall: painted timber and a striped canvas awning. Warmer and
  // more saturated than anything inside the kitchen, because it is *not* the
  // kitchen — it should read as somewhere you go out to, from across the patio.
  stallBody: 0x9c5f4a,
  stallPost: 0x7a4636,
  stallCounter: 0xd8bd93,
  awning: 0xd8705c,
  awningStripe: 0xf1ece0,
  /** Shutters, drawn while the stall is closed for service. */
  shutter: 0x6d5344,
  // The recipe card stand, one apron along from the stall. Paper and pine:
  // lighter than anything the stall is made of, because a card is the one thing
  // out here that is not for sale.
  cardFace: 0xf4ead6,
  cardEdge: 0xd9c49a,
  cardEasel: 0x8a6a45,
  // The sign hanging in the door. Painted board on a brass hook, and the two
  // faces of the day: a green that means come in, and a red that means not yet.
  // Saturated on purpose — it is the one thing in the room whose whole job is to
  // be read from the other side of it.
  signBoard: 0x6b4a30,
  signHook: 0xc9a86b,
  signOpen: 0x4e8a5c,
  signClosed: 0xa8483f,
  ceramic: 0xf1ece0,
  /**
   * The recessed base every appliance stands on.
   *
   * One colour for all of them, warm and dark: a toe-kick is read as the shadow
   * under the thing rather than as part of it, so it must not argue with the
   * body above it — a plinth painted to match would just make the box taller.
   */
  plinth: 0x4c453c,
  bin: 0x4a453e,
  brass: 0xc9a86b,
  // Scuffed stainless, and the one pool of water in the kitchen. The suds are
  // brighter than the ceramic so a full sink reads from across the room.
  sinkBody: 0x9aa5ad,
  sinkBasin: 0x77828b,
  suds: 0xeef5f7,

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
  // Coats are not here: they belong to a *kind* of customer, so they live in
  // `data/customers.ts` beside the patience and the appetite they arrive with,
  // exactly as a biome's colours live in `data/biomes.ts`. The rule they follow
  // is written down there — a different family from the chef colours, because
  // at a glance across the room, who works here must never be a question.
  customerLegs: 0x7b7466,
  hair: 0x4c4038,

  // --- cars ---
  // Paintwork is not here either: a car is what a *kind* of customer arrives
  // in, so it is painted out of the coats in `data/customers.ts` — the same
  // rule, and the reason a hurried driver is the dark saloon. What is here is
  // everything every car shares.
  /** The lane a drive-through's cars queue in, and the dashes down it. */
  tarmac: 0x585552,
  tarmacLine: 0xd9cfae,
  carGlass: 0x50606b,
  carTyre: 0x2f2d2c,
  carHub: 0xb9b5ad,
  carLight: 0xf6e6b8,
  carShadow: 0x6b6357,

  // --- tips ---
  coin: 0xd9b45c,
  coinEdge: 0xbf9741,

  // --- used crockery ---
  plateDirty: 0xd8d2c4,
  /**
   * The enamel band around a plate's rim.
   *
   * Crockery is the one pale disc in the kitchen that is not food, and it has to
   * say so from across the room: a raw pizza base, a flattened round of dough
   * and a plate are the same silhouette in nearly the same cream. Dusty teal is
   * the house accent, no ingredient is anywhere near it, and a stack shows one
   * band per plate — which is how you count them.
   */
  plateRim: 0x7f9ba0,
  crumbs: 0xa8895f,

  // --- feedback ---
  /** Dark, but never pure black — it would flatten in the shadow pass. */
  eye: 0x2a2b33,
  progressGood: 0x8fc47f,
  progressBurn: 0xcb6a4c,
  /** Unfilled part of a dial: dark enough to read as a groove, not a ring. */
  dialTrack: 0x1b1d24,

  // --- popups ---
  // These were CSS strings inline in `view.ts` while the rest of the palette
  // was numbers, so the two colour systems could not meet and nobody could see
  // that `#ffd479` was being used for two different rewards.
  /** Money paid for a delivery. */
  rewardServe: 0xffd479,
  /** Money picked up with a dirty plate — a different decision, so a different colour. */
  rewardTip: 0xb8e08a,
  /** Somebody gave up and left. */
  lossWalkout: 0xe08a6f,
  /** Money going out: a purchase. */
  spend: 0xe0b8a0,
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
