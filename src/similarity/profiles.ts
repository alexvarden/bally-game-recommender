/**
 * Aspect profiles: the text we embed for each game.
 *
 * Each game gets three short templated profiles, built only from enriched descriptive fields, so every supplier's
 * game reads the same way to the embedding model regardless of how its copy was written. Names, numbers and brands
 * are left out: they say nothing about what a game is like, and numbers embed badly.
 */
import type { DescriptiveOverrides, EnrichedGame } from "../catalogue/schema.ts";
import type { Aspect } from "../contracts/storage.ts";

type Fields = EnrichedGame["fields"];
type FieldKey = keyof Fields;

/** Phrases that carry more meaning for an embedding model than the bare enum id. */
const PHRASES: Record<string, string> = {
  ancient_egypt: "Ancient Egypt, pharaohs and pyramids",
  irish_luck: "Irish luck, leprechauns and rainbows",
  norse_myth: "Norse mythology, Vikings and runes",
  greek_myth: "Greek mythology, gods of Olympus",
  fruit_classic: "classic fruit machine",
  fishing: "fishing and the sea",
  animals_wildlife: "animals and wildlife",
  gems_treasure: "gems, jewels and treasure",
  horror_halloween: "horror and Halloween",
  asian_fortune: "Asian fortune and prosperity",
  wild_west: "the Wild West and cowboys",
  tv_gameshow: "TV game show",
  adventure_exploration: "adventure and exploration",
  fantasy_magic: "fantasy and magic",
  space_scifi: "space and science fiction",
  food_sweets: "food and sweets",
  music_party: "music and party",
  seasonal_festive: "seasonal festivities",
  luxury_vegas: "Vegas luxury and glamour",
  sport: "sport",
  video_slot: "video slot",
  classic_slot: "classic three-reel slot",
  slingo: "Slingo, a slots and bingo hybrid",
  bingo: "bingo",
  live_dealer: "live dealer casino game",
  table: "casino table game",
  instant_win: "instant win scratchcard",
  crash: "crash multiplier game",
  game_show: "live game show",
  paylines: "fixed paylines",
  ways: "all-ways pays",
  megaways: "Megaways reels",
  cluster_pays: "cluster pays",
  pay_anywhere: "pays anywhere",
  hold_and_win: "hold and win respins",
  cash_collect: "cash collect",
  pick_me_bonus: "pick-me bonus",
  bingo_ball_draw: "bingo ball draw",
  card_table: "card table play",
  scratch_reveal: "scratch and reveal",
  crash_multiplier: "cash out before the crash",
  frequent_small: "frequent small bonuses",
  balanced: "balanced bonus frequency",
  rare_big: "rare big bonuses",
  none: "no",
  local_progressive: "local progressive jackpot",
  network_progressive: "network progressive jackpot",
  fixed: "fixed jackpots",
  steady_trickle: "a steady trickle of wins",
  slow_build: "a slow build of tension",
  bursty_chase: "bursty chase for big moments",
  shared_room: "a shared room with other players",
  live_host: "a live host",
  community_jackpot: "a community jackpot",
  feature_heavy: "feature-heavy",
  realistic_3d: "realistic 3D",
  retro_pixel: "retro pixel art",
  fruit_machine: "fruit machine styling",
  live_video: "live video",
};

export const phrase = (id: string) => PHRASES[id] ?? id.replace(/_/g, " ");

/** The effective value of a descriptive field: operator overrides win over enrichment. */
export function valueOf<K extends FieldKey>(game: EnrichedGame, key: K, overrides: DescriptiveOverrides = {}): Fields[K]["value"] {
  const override = (overrides as Record<string, unknown>)[key];
  return (override !== undefined ? override : game.fields[key]?.value ?? null) as Fields[K]["value"];
}

/** Removes the game's own name so a narrative hook doesn't leak it into the vector. */
export function withoutName(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "gi"), "the game").replace(/\s+/g, " ").trim();
}

/** "Label: value." for a known value; nothing for an unknown one. */
function line(label: string, value: string | null | undefined) {
  const clean = value?.replace(/[.\s]+$/, "");
  return clean ? `${label}: ${clean}.` : null;
}

const list = (xs: readonly string[] | null | undefined) => (xs && xs.length ? xs.map(phrase).join(", ") : null);

function contentProfile(g: EnrichedGame, o: DescriptiveOverrides) {
  const theme = valueOf(g, "primaryTheme", o);
  const hook = valueOf(g, "narrativeHook", o);
  const art = valueOf(g, "artStyle", o);
  return [
    line("Theme", theme && phrase(theme)),
    line("Motifs", list(valueOf(g, "subThemes", o))),
    line("Setting", hook && withoutName(hook, g.name)),
    line("Art style", art && phrase(art)),
    line("Licensed from", g.licensedIp),
  ];
}

function gameplayProfile(g: EnrichedGame, o: DescriptiveOverrides) {
  const format = valueOf(g, "format", o);
  const pays = valueOf(g, "payStructure", o);
  const mechanic = valueOf(g, "coreMechanic", o);
  const bonus = valueOf(g, "bonusStyle", o);
  const jackpot = valueOf(g, "jackpotType", o);
  const complexity = valueOf(g, "complexity", o);
  return [
    line("Format", format && phrase(format)),
    line("Pays", pays && pays !== "not_applicable" ? phrase(pays) : null),
    line("Core mechanic", mechanic && phrase(mechanic)),
    line("Features", list(valueOf(g, "secondaryFeatures", o))),
    line("Bonuses", bonus && phrase(bonus)),
    line("Jackpot", jackpot && (jackpot === "none" ? "no jackpot" : phrase(jackpot))),
    line("Complexity", complexity && phrase(complexity)),
  ];
}

function experienceProfile(g: EnrichedGame, o: DescriptiveOverrides) {
  const mood = valueOf(g, "mood", o);
  const pace = valueOf(g, "pace", o);
  const curve = valueOf(g, "excitementCurve", o);
  const social = valueOf(g, "socialElement", o);
  const nostalgia = valueOf(g, "nostalgia", o);
  return [
    line("Mood", mood && phrase(mood)),
    line("Pace", pace && phrase(pace)),
    line("Excitement", curve && phrase(curve)),
    line("Social", social && (social === "none" ? "played alone" : phrase(social))),
    line("Feel", nostalgia === null ? null : nostalgia ? "nostalgic, retro" : "modern"),
  ];
}

const BUILDERS: Record<Aspect, (g: EnrichedGame, o: DescriptiveOverrides) => (string | null)[]> = {
  content: contentProfile,
  gameplay: gameplayProfile,
  experience: experienceProfile,
};

export function aspectProfile(game: EnrichedGame, aspect: Aspect, overrides: DescriptiveOverrides = {}): string {
  return BUILDERS[aspect](game, overrides).filter(Boolean).join(" ");
}

export function profiles(game: EnrichedGame, overrides: DescriptiveOverrides = {}): Record<Aspect, string> {
  return { content: aspectProfile(game, "content", overrides), gameplay: aspectProfile(game, "gameplay", overrides), experience: aspectProfile(game, "experience", overrides) };
}

/** The descriptive fields that matter most for matching; a game knowing fewer than MIN_KNOWN is too thin. */
const CORE_FIELDS = ["primaryTheme", "coreMechanic", "mood", "pace", "artStyle", "subThemes"] as const;
export const MIN_KNOWN = 3;

export function knownCoreFields(game: EnrichedGame, overrides: DescriptiveOverrides = {}) {
  return CORE_FIELDS.filter((k) => {
    const v = valueOf(game, k, overrides);
    return Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined;
  }).length;
}

/** Too little is known about the game to say what it is similar to. */
export const isThin = (game: EnrichedGame, overrides: DescriptiveOverrides = {}) => knownCoreFields(game, overrides) < MIN_KNOWN;
