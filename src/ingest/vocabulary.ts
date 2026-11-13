/**
 * What feed labels mean. Written against the labels suppliers actually send, independently of the generator: a
 * test checks every label the degrade step can emit is understood or deliberately left ambiguous.
 *
 * Keys are matched case-insensitively after trimming. A label listed under more than one value is ambiguous and is
 * never guessed: the field stays null and is reported as unparsed.
 */
import type { z } from "zod";
import type { Brand, CoreMechanic, Format, JackpotType, Jurisdiction, SecondaryFeature, Status, Theme, Volatility } from "../catalogue/schema.ts";

type Vocabulary<V extends string> = Record<V, readonly string[]>;

export const FORMAT_VOCAB: Vocabulary<z.infer<typeof Format>> = {
  video_slot: ["video slots", "video slot", "video_slot", "slot", "slots"],
  classic_slot: ["classic slots", "fruit machine", "3-reel", "slot"],
  slingo: ["slingo", "slingo/slots"],
  bingo: ["bingo", "90 ball", "bingo-room"],
  live_dealer: ["live casino", "live dealer", "live"],
  table: ["table games", "table", "rng table"],
  instant_win: ["instant win", "scratchcard", "instants"],
  crash: ["crash", "instant/crash", "arcade"],
  game_show: ["game show", "live game show", "live - shows"],
};

export const THEME_VOCAB: Vocabulary<z.infer<typeof Theme>> = {
  ancient_egypt: ["egyptian", "egypt / pyramids", "ancient egypt", "egypt"],
  irish_luck: ["irish", "luck of the irish", "celtic", "leprechaun"],
  norse_myth: ["norse", "vikings", "mythology - norse"],
  greek_myth: ["greek mythology", "greek gods", "olympus"],
  fruit_classic: ["fruits", "classic", "retro fruit", "fruit machine"],
  fishing: ["fishing", "fish", "ocean / fishing"],
  animals_wildlife: ["animals", "wildlife", "safari", "nature"],
  gems_treasure: ["gems", "jewels", "treasure"],
  horror_halloween: ["horror", "halloween", "spooky"],
  asian_fortune: ["asian", "oriental", "chinese new year", "fortune"],
  wild_west: ["western", "wild west", "cowboys"],
  tv_gameshow: ["tv", "game show", "entertainment"],
  adventure_exploration: ["adventure", "explorer", "jungle"],
  fantasy_magic: ["fantasy", "magic", "fairytale"],
  space_scifi: ["space", "sci-fi", "cosmic"],
  food_sweets: ["sweets", "candy", "food"],
  music_party: ["music", "party", "disco"],
  seasonal_festive: ["christmas", "seasonal", "holiday"],
  luxury_vegas: ["vegas", "luxury", "glamour", "casino"],
  sport: ["sport", "football", "sports"],
};

/** Mechanics that only ever define a game (never a side feature). */
export const CORE_MECHANIC_VOCAB: Partial<Vocabulary<z.infer<typeof CoreMechanic>>> = {
  hold_and_win: ["hold & win", "hold n win", "hold and win", "lock & respin"],
  cascades: ["cascading reels", "tumble", "avalanche", "cascades"],
  expanding_wilds: ["expanding wilds", "expanding wild", "exp wilds"],
  sticky_wilds: ["sticky wilds", "sticky wild", "locked wilds"],
  multipliers: ["multipliers", "multiplier", "win multiplier"],
  cash_collect: ["cash collect", "collect feature", "cash-on-reels"],
  pick_me_bonus: ["pick bonus", "pick'em", "pick-me"],
  wheel_bonus: ["wheel bonus", "bonus wheel", "wheel of fortune feature"],
  slingo_grid: ["slingo", "slingo grid"],
  bingo_ball_draw: ["bingo", "90-ball"],
  live_wheel: ["money wheel", "live wheel"],
  card_table: ["cards", "table"],
  scratch_reveal: ["scratch", "reveal"],
  crash_multiplier: ["crash multiplier", "cash out"],
};

export const SECONDARY_FEATURE_VOCAB: Vocabulary<z.infer<typeof SecondaryFeature>> = {
  free_spins: ["free spins", "fs", "free games"],
  retriggers: ["retriggers", "retrigger"],
  mystery_symbols: ["mystery symbols", "mystery"],
  respins: ["respins", "re-spin"],
  random_wilds: ["random wilds", "wild drop"],
  symbol_upgrades: ["symbol upgrade", "upgrades"],
  gamble_feature: ["gamble", "double or nothing"],
  bonus_buy: ["bonus buy", "feature buy"],
  side_bets: ["side bets", "side bet"],
  progressive_reels: ["progressive reels"],
};

/** "Med-High" is deliberately absent: it could mean medium or high, so it is never guessed. */
export const VOLATILITY_VOCAB: Vocabulary<z.infer<typeof Volatility>> = {
  low: ["low", "l", "1/5", "2/5"],
  medium: ["medium", "med", "m", "3/5"],
  high: ["high", "h", "4/5"],
  very_high: ["very high", "v.high", "extreme", "5/5"],
};

export const JACKPOT_VOCAB: Vocabulary<z.infer<typeof JackpotType>> = {
  none: ["none", "n/a", "no", ""],
  fixed: ["fixed", "fixed jackpots", "mini/minor/major/grand"],
  local_progressive: ["progressive (local)", "local prog", "site progressive"],
  network_progressive: ["progressive (network)", "network jackpot", "prog-net"],
};

export const BRAND_VOCAB: Vocabulary<z.infer<typeof Brand>> = {
  jackpotjoy: ["jpj", "jackpotjoy"],
  virgin_games: ["vg", "virgin games", "virgin"],
  monopoly_casino: ["mon", "monopoly casino", "monopoly"],
  rainbow_riches_casino: ["rrc", "rainbow riches", "rainbowriches"],
  double_bubble_bingo: ["dbb", "double bubble", "doublebubble"],
  bally_casino_us: ["bally-us", "bally casino (us)", "ballyus"],
};

export const MARKET_VOCAB: Vocabulary<z.infer<typeof Jurisdiction>> = {
  GB: ["gb", "uk", "ukgc"],
  ES: ["es", "spain", "dgoj"],
  "US-NJ": ["nj", "us-nj"],
  "US-PA": ["pa", "us-pa"],
};

export const STATUS_VOCAB: Vocabulary<z.infer<typeof Status>> = {
  live: ["live", "active", "1"],
  coming_soon: ["coming soon", "pre-release", "scheduled"],
  suspended: ["suspended", "disabled", "off"],
  retired: ["retired", "eol", "archived"],
};

export const IN_HOUSE_CHANNELS = ["in-house", "internal"];

export type Lookup<V extends string> = (label: string) => { value: V | null; ambiguous: boolean };

/** Builds a case-insensitive label → value lookup that reports labels mapping to more than one value. */
export function lookupFor<V extends string>(vocab: Partial<Vocabulary<V>>): Lookup<V> {
  const index = new Map<string, Set<V>>();
  for (const [value, labels] of Object.entries(vocab) as [V, readonly string[]][]) {
    for (const label of labels) index.set(label, (index.get(label) ?? new Set<V>()).add(value));
  }
  return (label) => {
    const hits = index.get(label.trim().toLowerCase());
    if (!hits) return { value: null, ambiguous: false };
    return hits.size === 1 ? { value: [...hits][0]!, ambiguous: false } : { value: null, ambiguous: true };
  };
}
