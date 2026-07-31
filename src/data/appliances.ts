import type { Station } from "../sim/types";

export type ApplianceDef = {
  label: string;
  color: number;
  /** Visual height in tiles. */
  height: number;
  /** Can a player put an item down on it? */
  acceptsItems: boolean;
  /** Which kinds of work this appliance can perform. */
  stations: Station[];
  /** Work-rate multiplier. A dedicated station beats improvising on a counter. */
  speed: number;
  /**
   * How long finished food survives on it, as a multiple of the dish's burn
   * time. 1 everywhere except on an upgrade bought to buy time.
   */
  patience: number;
  /**
   * The kind this is a better version of, or null when it is the plain one.
   *
   * A `string` rather than an `ApplianceKind` because the union is derived from
   * this very table, and a column typed by its own keys is a circular type.
   * `validate.ts` checks the name resolves, shares a station with its upgrade
   * and costs more — the same job the type would have done, one startup later.
   */
  upgrades: string | null;
  /**
   * Can a player pick the appliance itself up during the build phase?
   *
   * Doubles as the line between what the *level* owns and what a *player*
   * owns: immovable appliances are furniture of the place (walls, the market
   * stall), so they are rebuilt from the level itself and never written to a
   * save. See `snapshot` and `restore`.
   */
  movable: boolean;
  /**
   * Does it hang on the wall rather than stand on the floor?
   *
   * A mounted appliance owns its tile without occupying it: the square under
   * the sign is floor a chef walks over, the same way the dividing wall stopped
   * being a column of squares when walls moved onto the seams. Nothing may be
   * built there — that is `placeable`, and a separate fact.
   */
  mounted: boolean;
  /** List price at the stall. Sells back for half of it — see `data/economy.ts`. */
  price: number;
};

/**
 * A table, read down its columns — see the note on TRANSFORMS in recipes.ts.
 *
 * The `price` column is the ledger, and it is written in four tiers on
 * purpose: **staples** are felt on day one or two, **capacity** costs a good
 * day's profit, **throughput** is two or three days of it — a thing to save
 * for rather than a thing to buy — and an **upgrade** is a week of them.
 * Prices are the only balancing dial the shop has, and they are here rather
 * than in the shop so that one appliance means one row.
 *
 * An **upgrade** is the first purchase that changes how a kitchen works rather
 * than how much of it there is: a second board means two people can chop, a
 * steel one means one person chops faster. They are deliberately built out of
 * columns that already existed — `speed` and now `patience` — so a better
 * appliance is a row here and nothing anywhere else.
 */
/**
 * Columns every row would otherwise repeat. Spread first, so a row that has an
 * opinion still wins — and so "this one is plain" stays the thing you do not
 * have to write down.
 */
const PLAIN = { patience: 1, upgrades: null, mounted: false } as const;

// prettier-ignore
const DEFS = {
  // A square of paving with something for sale standing on it. There is no
  // shop: what a player walks up to is the *goods*, drawn full size, and this
  // is only the level saying where the morning's delivery lands. Immovable,
  // holds nothing, and does its whole job through `Grab`.
  stall: { ...PLAIN, stations: [], speed: 1, label: "Stall", color: 0x9c5f4a, height: 0.1, acceptsItems: false, movable: false, price: 0 },
  // A poster on the outside wall, and the stall's twin in every structural way:
  // level furniture, immovable, never saved, doing its whole job through
  // `Grab`. What it sells is days rather than money — see `sim/cards.ts`.
  // Mounted, like the sign: it hangs on the wall rather than standing on the
  // square, so the paving in front of it is still paving anybody may cross.
  cards: { ...PLAIN, stations: [], speed: 1, label: "Recipe card", color: 0xd9c9a8, height: 1.1, acceptsItems: false, movable: false, mounted: true, price: 0 },
  // The sign in the door: the third piece of level furniture, and the one that
  // decides when the day happens. Opening used to be a keypress with no object
  // in the room behind it — see `sim/systems/sign.ts`.
  sign: { ...PLAIN, stations: [], speed: 1, label: "Sign", color: 0x7d5b3a, height: 1.15, acceptsItems: false, movable: false, mounted: true, price: 0 },
  counter: { ...PLAIN, stations: ["prep"], speed: 1, label: "Counter", color: 0x9a7b58, height: 0.62, acceptsItems: true, movable: true, price: 20 },
  board: { ...PLAIN, stations: ["prep"], speed: 1.75, label: "Chopping board", color: 0xc9a06a, height: 0.66, acceptsItems: true, movable: true, price: 40 },
  // The upgrades. A steel board is the cheap one on purpose: prep is what a
  // kitchen does most of, so it is the upgrade a room can first imagine
  // wanting, and the one whose effect is felt within a minute of buying it.
  steel_board: { ...PLAIN, stations: ["prep"], speed: 2.75, label: "Steel board", color: 0xb8b2a6, height: 0.66, acceptsItems: true, movable: true, price: 110, upgrades: "board" },
  fryer: { ...PLAIN, stations: ["fry"], speed: 1, label: "Fryer", color: 0x8e8e99, height: 0.72, acceptsItems: true, movable: true, price: 120 },
  oven: { ...PLAIN, stations: ["bake"], speed: 1, label: "Oven", color: 0x6f7076, height: 0.9, acceptsItems: true, movable: true, price: 160 },
  // The bell oven buys *time*, not speed: a pizza left in it lasts three times
  // as long before it burns. Heat is the one appliance a chef has to come back
  // to at a particular moment, so the thing worth selling is a later moment.
  bell_oven: { ...PLAIN, stations: ["bake"], speed: 1.15, patience: 3, label: "Bell oven", color: 0x585b66, height: 0.9, acceptsItems: true, movable: true, price: 320, upgrades: "oven" },
  crate: { ...PLAIN, stations: [], speed: 1, label: "Crate", color: 0x7a5c3c, height: 0.7, acceptsItems: false, movable: true, price: 15 },
  plates: { ...PLAIN, stations: [], speed: 1, label: "Plate stack", color: 0xbfc7cf, height: 0.7, acceptsItems: false, movable: true, price: 60 },
  // The one station that never burns, never overflows and never punishes: the
  // pressure around a sink is that plates are finite, not that scrubbing is
  // dangerous. Somewhere to catch your breath is worth having in a game like
  // this, and the sink is it.
  sink: { ...PLAIN, stations: ["wash"], speed: 1, label: "Sink", color: 0xa9b4bc, height: 0.7, acceptsItems: true, movable: true, price: 50 },
  // A table is an appliance like any other: it accepts a plate, so delivery is
  // the place verb players already know. Its price is what the build phase
  // charges for order capacity.
  table: { ...PLAIN, stations: [], speed: 1, label: "Table", color: 0xb08d63, height: 0.55, acceptsItems: true, movable: true, price: 40 },
  // The serving hatch of a drive-through, standing in a gap in the outside
  // wall: level furniture like the stall and the sign, and the fourth thing
  // that is furniture of a *place*. It accepts items because it is a sill —
  // a dish left on it is handed to the car that pulls up next.
  hatch: { ...PLAIN, stations: [], speed: 1, label: "Hatch", color: 0xa9b4bc, height: 0.62, acceptsItems: true, movable: false, price: 0 },
  bin: { ...PLAIN, stations: [], speed: 1, label: "Bin", color: 0x35363c, height: 0.7, acceptsItems: true, movable: true, price: 10 },
} as const satisfies Record<string, ApplianceDef>;

/**
 * Every kind of appliance there is, derived from the table above.
 *
 * The union used to be hand-written in `sim/types.ts`, with this record
 * annotated `Record<ApplianceKind, ApplianceDef>` to match — so adding a sink,
 * which is pure content, meant editing the simulation's type layer. Deriving it
 * the other way round makes a new appliance one row, and keeps `applianceDef`
 * exhaustive for free.
 *
 * `satisfies` rather than an annotation: it checks every row against
 * `ApplianceDef` *without* widening the keys back to `string`, which is the
 * whole trick.
 */
export type ApplianceKind = keyof typeof DEFS;

export const APPLIANCES: Record<ApplianceKind, ApplianceDef> = DEFS;

export function applianceDef(kind: ApplianceKind): ApplianceDef {
  return APPLIANCES[kind];
}

export function isApplianceKind(value: string): value is ApplianceKind {
  return Object.hasOwn(APPLIANCES, value);
}

/**
 * Every kind, as a list.
 *
 * `Object.keys` gives `string[]`, so anything wanting to walk the appliances
 * reached for a cast. Narrowing it once, here, through the same guard the wire
 * uses means no caller has to assert anything about a table it did not write.
 */
export const APPLIANCE_KINDS: ApplianceKind[] = Object.keys(APPLIANCES).filter(isApplianceKind);

/**
 * The two appliances a kitchen is not allowed to be without.
 *
 * Deliberately two entries rather than "everything a level ships". A kitchen
 * with no oven is a player who moved their oven, or sold it, and that is their
 * business — the build phase's whole promise is that you may wreck your own
 * restaurant. These two are not that, and they are on the list for **two
 * different reasons**, which is worth saying because the obvious next question
 * is "why not the bin as well":
 *
 * - **`plates`** — selling the last plate stack *destroys something conserved*.
 *   The kitchen's crockery rides on it while it is held, so the sale takes the
 *   plates with it, and a replacement stack arrives empty. Nothing else in the
 *   game can do this. It is the only entry that is here on principle rather
 *   than on judgement.
 * - **`sink`** — a kitchen without one caps its day at however many plates it
 *   owns and then earns nothing more: four covers, roughly $32, and the same $32
 *   again tomorrow. Not a lock — nothing is ever deducted, so the room can save
 *   its way out — but a ceiling low enough to sit under for days without seeing
 *   what is holding it there.
 *
 * A **bin** is the case that looks like it belongs and does not: losing it costs
 * one plate per ruined dish *until closing time*, because `clearService` wipes
 * every item and counts the plates back clean. If that ever stops being true —
 * if burnt food or dirty plates survive a day boundary — the bin becomes
 * structural and belongs here immediately. Same for anything else that starts
 * carrying state across the night.
 *
 * Everything else a kitchen can ruin — no tables, no crates, nothing that can
 * chop — is **warned about, not prevented** (see `kitchenWarnings`). That is the
 * house rule for this whole class of mistake, and it is the right one: the
 * honest criterion admits most of the kitchen, and a list of kinds long enough
 * to be safe is a list that has banned selling.
 *
 * **One list, two consumers.** `save.ts` gives a restored kitchen back any of
 * these its file never mentioned (every save written before the sink existed
 * looks exactly like that); the stall refuses to buy the last one. It lives
 * here because it is content — a fact about appliances, not about storage or
 * about shops.
 *
 * This used to be justified as "appliances a kitchen cannot get back on its
 * own", which was true when it was written and which **the stall made false**.
 * A rationale that has quietly stopped applying is worse than none: it is the
 * sentence the next person reasons from.
 */
export const ESSENTIAL: ApplianceKind[] = ["plates", "sink"];
