/**
 * The weather: what the day looks like, and whether the terrace is open.
 *
 * A biome is *where* a kitchen is and the daylight curve is *when* — this is
 * the third of those, and the only one that changes from day to day. It exists
 * because the paving outside was dead space during service, and a table
 * standing on it is the cheapest capacity in the game: no wall to build and no
 * room to extend. The weather is what that bargain costs. See
 * [weather.md](../../docs/weather.md).
 *
 * Two dials, and no more:
 *
 * - **`outdoor`** — may anybody sit down outside? This is the one that matters,
 *   and it works through the seats rather than around them: arrivals already
 *   scale with free tables (`arrivalInterval`), so shutting the terrace makes a
 *   room smaller *and* quieter through the mechanism that was already there.
 * - **`trade`** — how much slower the door is, whatever the seating. It carries
 *   the days when nobody is out walking, and it is the only thing weather can
 *   say to the [drive-through](../../docs/drive-through.md), which has no
 *   tables to close.
 *
 * There is deliberately no dial for burning, walking speed or patience. Weather
 * that reached into the kitchen would be a rule the player cannot see coming
 * from the morning card, and the morning is where the decision it exists to
 * create actually gets made.
 *
 * This is content: plain data, expect to iterate on every number in it.
 */

/**
 * What this weather does to the biome's light.
 *
 * A **shift**, not a sky: the biome still owns the day and its keyframes, and
 * this bends the sampled result. Written that way because the alternative —
 * a set of keys per biome per weather — is nine days to keep in step, and the
 * thing "overcast" means is the same subtraction wherever you are standing.
 *
 * Applied by `render/daylight.ts`; multipliers where the field is an intensity
 * and additions where it is already a small signed amount.
 *
 * ## Weather takes contrast, not colour
 *
 * The rule every number below is tuned against, and it was arrived at by
 * getting it wrong first. The obvious way to draw a wet day is the way a
 * photograph of one looks: desaturate hard, pull the warmth out, drop the sun,
 * bring the fog in. Do all four and the result is *miserable* — and misery is
 * the one thing this game must not say about a rainy morning, because the
 * mechanics are already charging for it. The terrace shuts and the door slows
 * down; that is the cost, and it is enough. A picture that piles on makes a
 * rainy day something to sit out rather than something to play.
 *
 * So what a shift takes is **contrast**: the hard sun goes, the shadows fill
 * in, the distance softens. What it keeps is **colour** — the grass stays
 * green, the tomatoes stay red, and the kitchen stays warm against a wet world.
 * A rainy day should read as cosy rather than as bleak.
 *
 * The practical version, for anybody turning these: `sun` down and `fill` and
 * `ambient` up in the same edit, `saturation` barely moved, and `lift` raised
 * so the shadows stay soft rather than crushing. If a change makes the frame
 * greyer *and* darker, it has gone the wrong way.
 */
export type SkyShift = {
  /** Multiplier on the sun's intensity. Cloud takes the hard light away. */
  sun: number;
  /** Multipliers on the fill and the hemisphere wrap, which take over from it. */
  fill: number;
  ambient: number;
  /** Multiplier on the fog distances. Below 1 brings the far side of the park in. */
  fog: number;
  /** The colour the sky, the fog and every light are pulled toward. */
  tint: number;
  /** How far toward `tint`, 0..1. */
  haze: number;
  /** Multiplier on the grade's saturation, and additions to its warmth and lift. */
  saturation: number;
  warmth: number;
  lift: number;
  exposure: number;
};

/** A shift that changes nothing — what a clear day does to a clear sky. */
const UNCHANGED: SkyShift = {
  sun: 1,
  fill: 1,
  ambient: 1,
  fog: 1,
  tint: 0xffffff,
  haze: 0,
  saturation: 1,
  warmth: 0,
  lift: 0,
  exposure: 1,
};

export type Weather = {
  id: string;
  label: string;
  /** Relative likelihood in the morning's roll. */
  weight: number;
  /** May a table standing outside the walls be sat at? */
  outdoor: boolean;
  /** Multiplier on the gap between arrivals. Above 1 is a quiet day. */
  trade: number;
  /**
   * How hard it is actually raining, 0..1.
   *
   * Beside `sky` rather than inside it, because it is not a property of the
   * light: `SkyShift` is what the weather does to a biome's *lamps*, and this
   * is water. Keeping them apart is also what leaves room for a drizzle — a day
   * that is barely wet and fully overcast is two numbers, not a fourth row.
   *
   * The simulation never reads it. Whether the terrace is open is `outdoor`,
   * and a rule that depended on how many drops the renderer happened to be
   * drawing would be a rule the sim could not answer on the server.
   */
  rain: number;
  /**
   * What the morning card says about it.
   *
   * Here rather than in the HUD because it is the only place the terrace is
   * ever explained: a player who has not bought an outdoor table yet should
   * still be able to read what the weather is *for*.
   */
  note: string;
  sky: SkyShift;
};

/**
 * Every kind of day there is, in the order the roll walks them.
 *
 * Three, and the middle one is the argument for having a table at all: a room
 * that only ever swung between "sit outside" and "do not" would make the
 * terrace a coin flip. Overcast is the ordinary day that costs a little and
 * takes nothing away, so the terrace pays for itself across a week rather than
 * on one morning in two.
 */
export const WEATHERS: Weather[] = [
  {
    id: "fair",
    label: "Fair",
    weight: 5,
    outdoor: true,
    trade: 1,
    rain: 0,
    note: "Fair \u2014 a good day to be sitting outside",
    sky: UNCHANGED,
  },
  {
    id: "overcast",
    label: "Overcast",
    weight: 3,
    outdoor: true,
    trade: 1.08,
    // Grey, and dry. The middle row is the one that has to *look* different
    // from rain at a glance, because it is the one that leaves the terrace
    // open: a player reading the sky rather than the card should never mistake
    // the two.
    rain: 0,
    note: "Overcast \u2014 the terrace is still open",
    sky: {
      sun: 0.44,
      fill: 1.24,
      ambient: 1.26,
      fog: 0.82,
      tint: 0xc4cbd2,
      haze: 0.38,
      // Barely moved. Cloud flattens a scene; it does not drain it, and the
      // day this said 0.82 the park read as a photograph somebody had left in
      // a drawer.
      saturation: 0.94,
      warmth: -0.1,
      lift: 0.016,
      exposure: 1.04,
    },
  },
  {
    id: "rain",
    label: "Rain",
    weight: 2,
    outdoor: false,
    trade: 1.15,
    rain: 1,
    note: "Rain \u2014 nobody is sitting outside today",
    sky: {
      // Still some sun, and that is deliberate rather than a compromise: it is
      // what keeps shadows under things. A scene with no directional light at
      // all loses every contact shadow at once, and the kitchen stops looking
      // like objects standing on a floor — which reads as *broken* long before
      // it reads as weather.
      sun: 0.36,
      // Up as far as the sun comes down. The light that is lost from one
      // direction arrives from everywhere instead, which is both what an
      // overcast sky actually does and what stops a rainy kitchen going murky.
      fill: 1.34,
      ambient: 1.38,
      // Softened, not closed in. At 0.54 the far side of the park vanished and
      // the room felt small; weather should not crop the map.
      fog: 0.74,
      // A pale pearl rather than the cold steel this used to be. The old tint
      // was doing half the desaturation on its own — everything it touched came
      // out blue, including the food.
      tint: 0xaeb6bc,
      haze: 0.46,
      // The whole of the difference. This was 0.66, which took a third of the
      // colour out of a game whose subject is coloured food on white plates.
      saturation: 0.88,
      // Cooler, not cold. The biomes run 0.3–0.6 warm, so this leaves most of
      // it: a wet afternoon is greyer than a dry one and it is not January.
      warmth: -0.15,
      // Raised further than anything else here. Lifting the blacks is what
      // makes shadow soft instead of heavy, and heavy shadow is most of what
      // "depressing" actually is.
      lift: 0.034,
      exposure: 1.1,
    },
  },
];

/** The day a kitchen gets when nothing has decided otherwise. */
export const FAIR: Weather = WEATHERS[0]!;

/**
 * The weather with this id, or a fair day.
 *
 * Unknown ids are tolerated rather than refused, for the reason a customer's
 * `kind` is: the id travels on the wire, and a client on yesterday's deploy
 * meeting a weather it has never heard of should get a playable kitchen with
 * the wrong sky rather than no kitchen at all.
 */
export function weatherById(id: string): Weather {
  return WEATHERS.find((entry) => entry.id === id) ?? FAIR;
}
