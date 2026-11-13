/**
 * Step 3 of catalogue generation: turn the clean ground truth into what a real ingestion pipeline receives.
 *
 * - The structured feed gets thinner and noisier depending on where the game came from: in-house records are
 *   mostly complete, aggregator records are sparse, with inconsistent units, labels and codes.
 * - Documents are rendered into messy wire formats by the messy-docs skill's renderer.
 * - Semantic defects from the plan (wrong game's rules, conflicting volatility, duplicate listings…) are applied here.
 *
 * No LLM calls: re-run freely to change the mess without paying for generation again.
 *
 * Usage: node scripts/catalogue/degrade.ts [--seed 7]
 * Output: data/catalogue/{catalogue.raw.json, documents.json, documents.truth.json, manifest.json}
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { render, type CleanDoc, type Damage, type Format as WireFormat, type RenderedDoc } from "../../.claude/skills/messy-docs/scripts/render.ts";
import { argValue, countBy, isMain } from "../../src/lib/cli.ts";
import { chance, mulberry32, pick, type Rng } from "../../src/lib/random.ts";
import {
  DocumentKind,
  ExtractableField,
  GameDocument,
  RawFeedRecord,
  type GroundTruthDocument,
  type GroundTruthGame,
} from "../../src/catalogue/schema.ts";
import { GroundTruth, GROUND_TRUTH_PATH, displayFacts } from "./generate.ts";
import { Plan, PLAN_PATH, type PlannedGame } from "./plan.ts";

const OUT = "data/catalogue";

/** Eval-only: which facts each ingested document really contains after rendering and damage. */
export const DocumentTruth = z.object({
  docId: z.string(),
  gameId: z.string(),
  kind: DocumentKind,
  format: z.string(),
  survivingFacts: z.array(ExtractableField),
  partialFacts: z.array(ExtractableField),
  damage: z.array(z.string()),
  /** Set when the doc's body actually describes a different game (wrong_game_rules). */
  describesGameId: z.string().nullable(),
  /** Facts this doc states falsely on purpose (volatility_conflict). Extraction should flag, not trust. */
  misleadingFacts: z.array(ExtractableField),
});
export type DocumentTruth = z.infer<typeof DocumentTruth>;

export const Manifest = z.object({
  degradeSeed: z.number(),
  planSeed: z.number(),
  generation: GroundTruth.shape.meta,
  counts: z.record(z.string(), z.number()),
  /** Duplicate listing id → the original game it duplicates. */
  duplicates: z.record(z.string(), z.string()),
  files: z.record(z.string(), z.string()),
});

// ---------- Label vocabularies: how real feeds spell things ----------

const FORMAT_LABELS: Record<string, string[]> = {
  video_slot: ["Video Slots", "slot", "Slots", "VIDEO_SLOT", "Video Slot"],
  classic_slot: ["Classic Slots", "Fruit Machine", "slot", "3-Reel"],
  slingo: ["Slingo", "SLINGO", "Slingo/Slots"],
  bingo: ["Bingo", "90 Ball", "bingo-room"],
  live_dealer: ["Live Casino", "Live Dealer", "LIVE"],
  table: ["Table Games", "Table", "RNG Table"],
  instant_win: ["Instant Win", "Scratchcard", "instants"],
  crash: ["Crash", "Instant/Crash", "Arcade"],
  game_show: ["Game Show", "Live Game Show", "LIVE - Shows"],
};

const THEME_LABELS: Record<string, string[]> = {
  ancient_egypt: ["Egyptian", "Egypt / Pyramids", "ANCIENT EGYPT", "egypt"],
  irish_luck: ["Irish", "Luck of the Irish", "Celtic", "leprechaun"],
  norse_myth: ["Norse", "Vikings", "Mythology - Norse"],
  greek_myth: ["Greek Mythology", "Greek Gods", "Olympus"],
  fruit_classic: ["Fruits", "Classic", "Retro Fruit", "fruit machine"],
  fishing: ["Fishing", "Fish", "Ocean / Fishing"],
  animals_wildlife: ["Animals", "Wildlife", "Safari", "nature"],
  gems_treasure: ["Gems", "Jewels", "Treasure"],
  horror_halloween: ["Horror", "Halloween", "Spooky"],
  asian_fortune: ["Asian", "Oriental", "Chinese New Year", "Fortune"],
  wild_west: ["Western", "Wild West", "Cowboys"],
  tv_gameshow: ["TV", "Game Show", "Entertainment"],
  adventure_exploration: ["Adventure", "Explorer", "Jungle"],
  fantasy_magic: ["Fantasy", "Magic", "Fairytale"],
  space_scifi: ["Space", "Sci-Fi", "Cosmic"],
  food_sweets: ["Sweets", "Candy", "Food"],
  music_party: ["Music", "Party", "Disco"],
  seasonal_festive: ["Christmas", "Seasonal", "Holiday"],
  luxury_vegas: ["Vegas", "Luxury", "Glamour", "Casino"],
  sport: ["Sport", "Football", "Sports"],
};

const MECHANIC_LABELS: Record<string, string[]> = {
  hold_and_win: ["Hold & Win", "hold n win", "HOLD AND WIN", "Lock & Respin"],
  cascades: ["Cascading Reels", "Tumble", "avalanche", "Cascades"],
  expanding_wilds: ["Expanding Wilds", "expanding wild", "EXP WILDS"],
  sticky_wilds: ["Sticky Wilds", "sticky wild", "Locked Wilds"],
  multipliers: ["Multipliers", "MULTIPLIER", "Win Multiplier"],
  cash_collect: ["Cash Collect", "Collect Feature", "cash-on-reels"],
  pick_me_bonus: ["Pick Bonus", "Pick'em", "pick-me"],
  wheel_bonus: ["Wheel Bonus", "Bonus Wheel", "wheel of fortune feature"],
  free_spins: ["Free Spins", "FS", "free games"],
  slingo_grid: ["Slingo", "slingo grid"],
  bingo_ball_draw: ["Bingo", "90-ball"],
  live_wheel: ["Money Wheel", "Live Wheel"],
  card_table: ["Cards", "Table"],
  scratch_reveal: ["Scratch", "Reveal"],
  crash_multiplier: ["Crash Multiplier", "Cash Out"],
  retriggers: ["Retriggers", "retrigger"],
  mystery_symbols: ["Mystery Symbols", "MYSTERY"],
  respins: ["Respins", "Re-spin"],
  random_wilds: ["Random Wilds", "wild drop"],
  symbol_upgrades: ["Symbol Upgrade", "upgrades"],
  gamble_feature: ["Gamble", "Double or Nothing"],
  bonus_buy: ["Bonus Buy", "Feature Buy"],
  side_bets: ["Side Bets", "side bet"],
  progressive_reels: ["Progressive Reels"],
};

const VOL_LABELS: Record<string, string[]> = {
  low: ["Low", "low", "1/5", "2/5", "L"],
  medium: ["Medium", "Med", "3/5", "MEDIUM", "M"],
  high: ["High", "4/5", "HIGH", "Med-High", "H"],
  very_high: ["Very High", "5/5", "V.High", "Extreme", "very high"],
};

const BRAND_CODES: Record<string, string[]> = {
  jackpotjoy: ["JPJ", "Jackpotjoy", "jackpotjoy"],
  virgin_games: ["VG", "Virgin Games", "virgin"],
  monopoly_casino: ["MON", "Monopoly Casino", "monopoly"],
  rainbow_riches_casino: ["RRC", "Rainbow Riches", "rainbowriches"],
  double_bubble_bingo: ["DBB", "Double Bubble", "doublebubble"],
  bally_casino_us: ["BALLY-US", "Bally Casino (US)", "ballyus"],
};

const MARKET_CODES: Record<string, string[]> = {
  GB: ["GB", "UK", "UKGC"],
  ES: ["ES", "Spain", "DGOJ"],
  "US-NJ": ["NJ", "US-NJ"],
  "US-PA": ["PA", "US-PA"],
};

const STATUS_LABELS: Record<string, string[]> = {
  live: ["live", "Live", "ACTIVE", "1"],
  coming_soon: ["coming soon", "PRE-RELEASE", "scheduled"],
  suspended: ["suspended", "Disabled", "OFF"],
  retired: ["retired", "EOL", "Archived"],
};

const JACKPOT_LABELS: Record<string, string[]> = {
  none: ["None", "N/A", "no", ""],
  fixed: ["Fixed", "fixed jackpots", "Mini/Minor/Major/Grand"],
  local_progressive: ["Progressive (Local)", "local prog", "Site Progressive"],
  network_progressive: ["Progressive (Network)", "Network Jackpot", "PROG-NET"],
};

/** Plausible wire formats per document kind; in-house content comes from the operator's own CMS. */
const FORMATS_BY_KIND: Record<string, { in_house: WireFormat[]; aggregator: WireFormat[] }> = {
  rules_text: { in_house: ["cms_html", "pdf_text"], aggregator: ["cms_html", "pdf_text", "aggregator_xml"] },
  marketing_blurb: { in_house: ["cms_html"], aggregator: ["aggregator_xml", "cms_html"] },
  release_note: { in_house: ["markdown"], aggregator: ["email", "markdown"] },
  editorial: { in_house: ["markdown", "cms_html"], aggregator: ["markdown", "cms_html"] },
};

// ---------- Feed ----------

function rtpVariant(rng: Rng, rtp: number): string | number {
  const pct = (rtp * 100).toFixed(2);
  return pick(rng, [Number(pct), `${pct}%`, Number(rtp.toFixed(4)), pct.replace(".", ","), `${pct} %`]);
}

function stakeRange(rng: Rng, p: PlannedGame) {
  const sym = p.currency === "GBP" ? "£" : "$";
  const lo = p.minStake;
  const hi = p.maxStake;
  return pick(rng, [
    `${sym}${lo.toFixed(2)} - ${sym}${hi.toFixed(2)}`,
    `${lo}-${hi}`,
    p.currency === "GBP" && lo < 1 ? `${Math.round(lo * 100)}p–£${hi}` : `${sym}${lo} to ${sym}${hi}`,
    `min ${lo} / max ${hi} ${p.currency}`,
  ]);
}

function dateVariant(rng: Rng, iso: string, us: boolean) {
  const [y, m, d] = iso.split("-");
  const mon = new Date(iso).toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return pick(rng, [iso, `${d}/${m}/${y}`, `${Number(d)} ${mon} ${y}`, `${iso}T00:00:00Z`, ...(us ? [`${m}/${d}/${y}`] : [])]);
}

function joinList(rng: Rng, items: string[]) {
  return items.join(pick(rng, [", ", ";", " | ", ","]));
}

interface FeedContext {
  g: GroundTruthGame;
  p: PlannedGame;
  rng: Rng;
  inHouse: boolean;
  thin: boolean;
  mechanics: string[];
}

/** Presence check for optional feed fields: thin records have none; in-house feeds are fuller than aggregators'. */
const present = (ctx: FeedContext, inHouseP: number, aggregatorP: number) => !ctx.thin && chance(ctx.rng, ctx.inHouse ? inHouseP : aggregatorP);

const label = (ctx: FeedContext, map: Record<string, string[]>, key: string) => pick(ctx.rng, map[key] ?? [key]);

const hasDefect = (ctx: FeedContext, defect: string) => ctx.p.defects.includes(defect as never);

interface FieldRule {
  field: keyof RawFeedRecord;
  /** Decides whether the field appears; may draw from the RNG. */
  include: (ctx: FeedContext) => boolean;
  value: (ctx: FeedContext) => RawFeedRecord[keyof RawFeedRecord];
}

/**
 * How each feed field degrades. Order matters: rules draw from the seeded RNG in this order.
 * Operator-owned fields (brands, markets, status) are always present because the operator controls them.
 */
const FIELD_RULES: FieldRule[] = [
  { field: "supplier_code", include: (c) => chance(c.rng, 0.9), value: (c) => c.g.supplierGameCode },
  { field: "studio", include: (c) => c.thin || chance(c.rng, 0.95), value: (c) => (!c.inHouse && chance(c.rng, 0.2) ? `${c.g.studio} Ltd` : c.g.studio) },
  { field: "channel", include: (c) => present(c, 1, 0.8), value: (c) => (c.inHouse ? pick(c.rng, ["in-house", "INTERNAL"]) : c.p.aggregator!) },
  { field: "family", include: (c) => !!c.g.familyId && present(c, 1, 0.4), value: (c) => c.g.familyId! },
  { field: "type", include: (c) => present(c, 1, 0.85), value: (c) => label(c, FORMAT_LABELS, c.g.format) },
  { field: "theme", include: (c) => !hasDefect(c, "theme_only_in_prose") && present(c, 0.9, 0.4), value: (c) => label(c, THEME_LABELS, c.g.primaryTheme) },
  { field: "features", include: (c) => present(c, 0.85, 0.5) && c.mechanics.length > 0, value: featuresValue },
  { field: "licensed_ip", include: (c) => !!c.g.licensedIp && present(c, 0.9, 0.7), value: (c) => c.g.licensedIp! },
  { field: "reels", include: (c) => !!c.g.grid && present(c, 0.9, 0.7), value: (c) => pick(c.rng, gridLabels(c.g.grid!)) },
  { field: "lines", include: (c) => !!c.g.paylines && present(c, 0.9, 0.6), value: linesValue },
  { field: "jackpot", include: (c) => present(c, 0.9, 0.6), value: (c) => label(c, JACKPOT_LABELS, c.g.jackpotType) },
  { field: "volatility", include: (c) => !hasDefect(c, "volatility_conflict") && present(c, 0.9, 0.5), value: (c) => (c.inHouse ? VOL_LABELS[c.g.volatility]![0]! : label(c, VOL_LABELS, c.g.volatility)) },
  { field: "rtp", include: (c) => present(c, 0.95, 0.7), value: (c) => (c.inHouse ? Number((c.g.rtp * 100).toFixed(2)) : rtpVariant(c.rng, c.g.rtp)) },
  { field: "max_win", include: (c) => present(c, 0.8, 0.4), value: (c) => pick(c.rng, maxWinLabels(c.g.maxWinMultiplier)) },
  { field: "stake_range", include: (c) => present(c, 0.9, 0.6), value: (c) => stakeRange(c.rng, c.p) },
  { field: "hit_freq", include: (c) => c.g.hitFrequency !== null && present(c, 0.6, 0.2), value: (c) => pick(c.rng, hitFrequencyLabels(c.g.hitFrequency!)) },
  { field: "brands", include: () => true, value: (c) => joinList(c.rng, c.g.brands.map((b) => label(c, BRAND_CODES, b))) },
  { field: "markets", include: () => true, value: (c) => joinList(c.rng, c.g.jurisdictions.map((j) => label(c, MARKET_CODES, j))) },
  { field: "status", include: () => true, value: (c) => label(c, STATUS_LABELS, c.g.status) },
  { field: "release_date", include: (c) => chance(c.rng, 0.9), value: (c) => dateVariant(c.rng, c.g.releaseDate, c.g.jurisdictions.every((j) => j.startsWith("US"))) },
  // The feed misses the RG flag on rg-sensitive games: enrichment should suggest it back.
  { field: "rg_flags", include: (c) => c.g.rgFlags.length > 0 && !hasDefect(c, "rg_sensitive_thin") && chance(c.rng, c.inHouse ? 1 : 0.5), value: (c) => c.g.rgFlags.join(",") },
];

function featuresValue(c: FeedContext) {
  const labels = c.mechanics.map((m) => label(c, MECHANIC_LABELS, m));
  return c.inHouse ? labels.join(", ") : joinList(c.rng, labels);
}

function linesValue(c: FeedContext) {
  return c.g.payStructure === "paylines" ? c.g.paylines! : pick(c.rng, [`${c.g.paylines} ways`, String(c.g.paylines)]);
}

const gridLabels = (grid: { reels: number; rows: number }) => [`${grid.reels}x${grid.rows}`, `${grid.reels} x ${grid.rows}`, `${grid.reels}-${grid.rows}`];

const maxWinLabels = (m: number) => [`${m}x`, m, `x${m.toLocaleString("en-GB")}`, `${m.toLocaleString("en-GB")} x stake`];

const hitFrequencyLabels = (h: number) => [`${(h * 100).toFixed(1)}%`, h, `1:${(1 / h).toFixed(1)}`];

/** Aggregator feeds mangle names: shouting, trademark symbols, regulator suffixes. */
export function noisyName(name: string, inHouse: boolean, rng: Rng) {
  if (inHouse) return name;
  if (chance(rng, 0.1)) return name.toUpperCase();
  if (chance(rng, 0.1)) return `${name}™`;
  return chance(rng, 0.05) ? `${name} (UKGC)` : name;
}

export function feedRecord(g: GroundTruthGame, p: PlannedGame, rng: Rng): RawFeedRecord {
  const inHouse = g.supplyChannel === "in_house";
  const ctx: FeedContext = {
    g,
    p,
    rng,
    inHouse,
    thin: p.defects.includes("thin_record") || p.defects.includes("rg_sensitive_thin"),
    // The feed's feature list leaves out the core mechanic when that defect is planted.
    mechanics: [g.coreMechanic, ...g.secondaryFeatures].filter((m) => !(m === g.coreMechanic && p.defects.includes("feed_omits_feature"))),
  };
  const record: Record<string, unknown> = { id: g.id, name: noisyName(g.name, inHouse, rng) };
  for (const rule of FIELD_RULES) {
    if (rule.include(ctx)) record[rule.field] = rule.value(ctx);
  }
  return RawFeedRecord.parse(record);
}

// ---------- Documents ----------

const VOL_CONFLICT_SENTENCE: Record<string, string> = {
  low: "Big, swingy action for players chasing huge wins.",
  medium: "A relaxed, low volatility game made for long, easy-going sessions.",
  high: "A relaxed, low volatility game made for long, easy-going sessions.",
  very_high: "Gentle low-volatility play with frequent small wins.",
};

function toClean(doc: GroundTruthDocument, title: string, source: string): CleanDoc {
  return {
    docId: doc.docId,
    title,
    source,
    sections: doc.sections.map((s) => ({ ...(s.heading ? { heading: s.heading } : {}), text: s.text, tags: s.facts })),
  };
}

function receivedAt(rng: Rng, release: string) {
  const d = new Date(Date.parse(release) - Math.floor(rng() * 60) * 86400000);
  return d.toISOString().slice(0, 10);
}

interface DocumentDefects {
  clean: CleanDoc;
  describesGameId: string | null;
  misleadingFacts: z.infer<typeof ExtractableField>[];
}

/** Applies the plan's semantic defects to one document before it is rendered. */
export function applyDocumentDefects(doc: GroundTruthDocument, g: GroundTruthGame, p: PlannedGame, all: GroundTruthDocument[]): DocumentDefects {
  let clean = toClean(doc, g.name, doc.source);
  let describesGameId: string | null = null;
  const misleadingFacts: z.infer<typeof ExtractableField>[] = [];

  if (doc.kind === "rules_text" && p.defects.includes("wrong_game_rules")) {
    // Copy-paste error: the page is titled for this game but the body is another game's rules.
    const other = all.find((d) => d.gameId === p.relatedGameId && d.kind === "rules_text")!;
    clean = { ...toClean(other, g.name, doc.source), docId: doc.docId };
    describesGameId = other.gameId;
  }
  if (p.defects.includes("volatility_conflict")) {
    clean = withVolatilityConflict(clean, doc.kind, g, p);
    if (doc.kind === "marketing_blurb") misleadingFacts.push("volatility");
  }
  return { clean, describesGameId, misleadingFacts };
}

/** The blurb claims the wrong volatility; the release note states the right one. */
function withVolatilityConflict(clean: CleanDoc, kind: string, g: GroundTruthGame, p: PlannedGame): CleanDoc {
  if (kind === "marketing_blurb") {
    return { ...clean, sections: [...clean.sections, { text: VOL_CONFLICT_SENTENCE[g.volatility]!, tags: [] }] };
  }
  if (kind === "release_note" && !clean.sections.some((s) => s.tags.includes("volatility"))) {
    const keyFacts = { heading: "Key facts", text: `Volatility: ${displayFacts(p).volatility}`, tags: ["volatility"] };
    return { ...clean, sections: [keyFacts, ...clean.sections] };
  }
  return clean;
}

/** Picks a wire format and damage: aggregator content arrives in worse shape than in-house content. */
export function chooseRendering(rng: Rng, kind: string, channel: "in_house" | "aggregator", defects: readonly string[]) {
  const format = pick(rng, FORMATS_BY_KIND[kind]![channel]);
  const damage: Damage[] = [];
  if (kind === "rules_text" && defects.includes("truncated_rules")) damage.push("truncate");
  if (channel === "in_house") {
    if (chance(rng, 0.2)) damage.push("whitespace");
    return { format, damage };
  }
  if (chance(rng, 0.15)) damage.push("mojibake");
  if (chance(rng, 0.35)) damage.push("boilerplate");
  if (chance(rng, 0.3)) damage.push("whitespace");
  return { format, damage };
}

function buildDocuments(truth: GroundTruth, plan: Plan, rng: Rng, seed: number) {
  const games = new Map(truth.games.map((g) => [g.id, g]));
  const plans = new Map(plan.games.map((p) => [p.id, p]));
  const docs: GameDocument[] = [];
  const docTruth: DocumentTruth[] = [];

  for (const doc of truth.documents) {
    const g = games.get(doc.gameId)!;
    const defects = applyDocumentDefects(doc, g, plans.get(doc.gameId)!, truth.documents);
    const { format, damage } = chooseRendering(rng, doc.kind, g.supplyChannel, plans.get(doc.gameId)!.defects);
    const rendered = render(defects.clean, { format, seed, damage });
    docs.push(toGameDocument(doc, rendered, receivedAt(rng, g.releaseDate)));
    docTruth.push(toDocumentTruth(doc, rendered, defects));
  }
  return { docs, docTruth };
}

function toGameDocument(doc: GroundTruthDocument, rendered: RenderedDoc, received: string): GameDocument {
  return GameDocument.parse({
    docId: doc.docId,
    gameId: doc.gameId,
    kind: doc.kind,
    format: rendered.format,
    contentType: rendered.contentType,
    source: doc.source,
    receivedAt: received,
    text: rendered.text,
  });
}

function toDocumentTruth(doc: GroundTruthDocument, rendered: RenderedDoc, defects: DocumentDefects): DocumentTruth {
  // A doc describing another game contains no true facts about this one.
  const describesOther = defects.describesGameId !== null;
  return {
    docId: doc.docId,
    gameId: doc.gameId,
    kind: doc.kind,
    format: rendered.format,
    survivingFacts: describesOther ? [] : (rendered.survivingTags as DocumentTruth["survivingFacts"]),
    partialFacts: describesOther ? [] : (rendered.partialTags as DocumentTruth["partialFacts"]),
    damage: rendered.appliedDamage,
    describesGameId: defects.describesGameId,
    misleadingFacts: defects.misleadingFacts,
  };
}

// ---------- Duplicates ----------

function duplicateListings(truth: GroundTruth, plan: Plan, feed: RawFeedRecord[], docs: GameDocument[], docTruth: DocumentTruth[], rng: Rng) {
  const duplicates: Record<string, string> = {};
  const dupGames = plan.games.filter((p) => p.defects.includes("duplicate_listing"));
  dupGames.forEach((p, i) => {
    const original = feed.find((r) => r.id === p.id)!;
    const prefix = p.id.split("-")[1];
    const dupId = `BLY-${prefix}-${String(9001 + i)}`;
    const otherAggregator = p.aggregator === "Spinlane Hub" ? "ReelBridge" : "Spinlane Hub";
    const g = truth.games.find((x) => x.id === p.id)!;
    // Same game from a second aggregator: different id, slightly different name, sparser fields.
    feed.push(
      RawFeedRecord.parse({
        id: dupId,
        name: chance(rng, 0.5) ? g.name.toUpperCase().replace(/'/g, "") : `${g.name}™`,
        supplier_code: original.supplier_code,
        studio: g.studio,
        channel: otherAggregator,
        type: original.type,
        rtp: original.rtp !== undefined ? rtpVariant(rng, g.rtp) : undefined,
        brands: original.brands,
        markets: original.markets,
        status: original.status,
        release_date: original.release_date,
      }),
    );
    const blurb = docs.find((d) => d.gameId === p.id && d.kind === "marketing_blurb");
    if (blurb) {
      docs.push({ ...blurb, docId: `${dupId}-marketing_blurb`, gameId: dupId, source: `${otherAggregator} / ${g.studio}` });
      const t = docTruth.find((d) => d.docId === blurb.docId)!;
      docTruth.push({ ...t, docId: `${dupId}-marketing_blurb`, gameId: dupId });
    }
    duplicates[dupId] = p.id;
  });
  return duplicates;
}

// ---------- Entry point ----------

export const DEFAULT_DEGRADE_SEED = 7;

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** The whole degrade step as a pure function: same truth, plan and seed in, same bytes out. */
export function degradeCatalogue(truth: GroundTruth, plan: Plan, seed: number) {
  const rng = mulberry32(seed);
  const plans = new Map(plan.games.map((p) => [p.id, p]));
  const feed = truth.games.map((g) => feedRecord(g, plans.get(g.id)!, rng));
  const { docs, docTruth } = buildDocuments(truth, plan, rng, seed);
  const duplicates = duplicateListings(truth, plan, feed, docs, docTruth, rng);
  return { feed, docs, docTruth, duplicates };
}

/** The files the degrade step writes, serialised exactly as committed. */
export function serialise(out: ReturnType<typeof degradeCatalogue>): Record<string, string> {
  return {
    "catalogue.raw.json": JSON.stringify(out.feed, null, 2),
    "documents.json": JSON.stringify(out.docs, null, 2),
    "documents.truth.json": JSON.stringify(out.docTruth, null, 2),
  };
}

export function buildManifest(out: ReturnType<typeof degradeCatalogue>, files: Record<string, string>, truth: GroundTruth, plan: Plan, seed: number) {
  return Manifest.parse({
    degradeSeed: seed,
    planSeed: plan.seed,
    generation: truth.meta,
    counts: {
      feedRecords: out.feed.length,
      documents: out.docs.length,
      ...countBy(out.docs, (d) => `format:${d.format}`),
      ...countBy(out.docs, (d) => `kind:${d.kind}`),
    },
    duplicates: out.duplicates,
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)])),
  });
}

export function run(argv: readonly string[], paths = { truth: GROUND_TRUTH_PATH, plan: PLAN_PATH, outDir: OUT }) {
  const seed = Number(argValue(argv, "--seed", String(DEFAULT_DEGRADE_SEED)));
  const truth = GroundTruth.parse(JSON.parse(readFileSync(paths.truth, "utf8")));
  const plan = Plan.parse(JSON.parse(readFileSync(paths.plan, "utf8")));

  const out = degradeCatalogue(truth, plan, seed);
  const files = serialise(out);
  for (const [name, content] of Object.entries(files)) writeFileSync(`${paths.outDir}/${name}`, content);
  const manifest = buildManifest(out, files, truth, plan, seed);
  writeFileSync(`${paths.outDir}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(`wrote ${out.feed.length} feed records and ${out.docs.length} documents to ${paths.outDir}/`, manifest.counts);
  return manifest;
}

if (isMain(import.meta.url)) run(process.argv);
