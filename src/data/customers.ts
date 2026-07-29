/**
 * Who walks in.
 *
 * A customer used to be one set of numbers wearing one of six coats: every
 * diner waited exactly as long as the dish said, ate for exactly `EAT_TIME`,
 * and tipped by the same formula. Demand had a *rate* and no texture.
 *
 * A kind is that texture, and it is content — the same move `biomes.ts` made
 * for locations. Each row multiplies the numbers the dining room already has,
 * so a kind can never introduce a rule: it cannot refuse a dish, order two, or
 * do anything the loop does not already do. That is what keeps a new row from
 * being a new system.
 *
 * The four dials pull against each other on purpose:
 *
 * - `patience` is how long you have. It is the pressure.
 * - `appetite` is how long the *table* is gone for once you have succeeded,
 *   which is throughput — see the note on dwell time in `docs/dining-room.md`.
 * - `generosity` is what the trouble was worth.
 * - `pace` is how fast they walk, which is the only one of the four that is
 *   visible before they sit down.
 *
 * So somebody easy to serve can be expensive to seat, and the room's best
 * customer can also be the one who costs you a table for half a minute.
 *
 * **Every kind has to be readable across the room**, without a label and
 * without the HUD: a coat, a build, and a walking speed. That is the same rule
 * the patience slump follows, and it is why there is no `moodiness: 0.8` here —
 * a dial nobody can see is a difficulty change disguised as content.
 */
export type CustomerKind = {
  id: string;
  name: string;
  /** Relative chance of being the next person through the door. */
  weight: number;
  /** Multiplies the dish's own patience. */
  patience: number;
  /** Multiplies how long their table is occupied once the food lands. */
  appetite: number;
  /** Multiplies the tip they leave behind. */
  generosity: number;
  /** Multiplies walking speed, on the way in and on the way out. */
  pace: number;
  /**
   * Coats to dress in, indexed by customer id.
   *
   * A list rather than a colour so a kind can be a *crowd*: two regulars
   * arriving together should rarely match, while the rare kinds are recognised
   * by being one colour and only ever that colour.
   *
   * Deliberately a different family from `PALETTE.chefs`: at a glance across
   * the room, who works here must never be a question.
   */
  coats: number[];
  /** Overrides the default hair colour. For a kind worth spotting at range. */
  hair?: number;
  /** Multiplies body scale. The coarsest signal there is, so it is used sparingly. */
  build: number;
};

// One row per kind, one line each: this is a table, and reading down the
// `patience` or `weight` column is the point.
// prettier-ignore
export const CUSTOMER_KINDS: CustomerKind[] = [
  // The crowd. Every multiplier is 1, so the recipes' own numbers still mean
  // exactly what they say and the other rows can be read as departures from
  // this one.
  { id: "regular", name: "Regular", weight: 58, patience: 1, appetite: 1, generosity: 1, pace: 1, build: 1,
    coats: [0xc7a98c, 0x8fa3ad, 0xb59aa8, 0x9fae8f, 0xc3b184, 0xa79bb5] },
  // On their lunch break: half the patience, in and out in half the time, and
  // they pay for the privilege. The kind that rewards a kitchen for dropping
  // everything — and the one that punishes a queue, because they walk fast
  // enough to reach the door before you have read the bubble.
  { id: "hurried", name: "In a Hurry", weight: 22, patience: 0.6, appetite: 0.5, generosity: 1.7, pace: 1.35, build: 1,
    coats: [0x4f5a6b, 0x5c5750] },
  // Out for the afternoon. Nothing hurries them, which sounds like a gift and
  // is a table gone for twenty seconds after the plate lands: the one kind
  // whose cost arrives *after* you have served them.
  { id: "leisurely", name: "Taking Their Time", weight: 16, patience: 1.6, appetite: 1.8, generosity: 0.9, pace: 0.78, build: 1.07,
    coats: [0xb4794f, 0x7f8f5e] },
  // Rare, impatient, and worth three ordinary tips. The only row that is really
  // an *event*, so it is the only one with its own hair: a customer worth
  // dropping a pizza for has to be identifiable from the fryer.
  { id: "critic", name: "Critic", weight: 4, patience: 0.85, appetite: 1.1, generosity: 3, pace: 1, build: 1,
    coats: [0x6d5470], hair: 0xdad3c6 },
];

/**
 * The kind everybody else is a departure from, and the answer to an id we do
 * not know.
 */
export const DEFAULT_CUSTOMER_KIND = "regular";

const BY_ID = new Map(CUSTOMER_KINDS.map((kind) => [kind.id, kind]));

/**
 * Resolve a kind id, falling back rather than throwing.
 *
 * Ids arrive over the wire, and a client can be a deploy behind a server that
 * knows a kind it does not. Dropping the frame over a coat colour would freeze
 * the kitchen; serving them as a regular is wrong in a way nobody can see. Same
 * reasoning as unknown recipe ids in `unlockedRecipes`.
 */
export function customerKind(id: string): CustomerKind {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_CUSTOMER_KIND) ?? CUSTOMER_KINDS[0]!;
}
