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
import { render, type CleanDoc, type Damage, type Format as WireFormat } from "../../.claude/skills/messy-docs/scripts/render.ts";
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

function feedRecord(g: GroundTruthGame, p: PlannedGame, rng: Rng): RawFeedRecord {
  const inHouse = g.supplyChannel === "in_house";
  const thin = p.defects.includes("thin_record") || p.defects.includes("rg_sensitive_thin");
  const has = (inHouseP: number, aggP: number) => !thin && chance(rng, inHouse ? inHouseP : aggP);
  const label = (map: Record<string, string[]>, k: string) => pick(rng, map[k] ?? [k]);

  let name = g.name;
  if (!inHouse) {
    if (chance(rng, 0.1)) name = name.toUpperCase();
    else if (chance(rng, 0.1)) name = `${name}™`;
    else if (chance(rng, 0.05)) name = `${name} (UKGC)`;
  }

  const mechanics = [g.coreMechanic, ...g.secondaryFeatures].filter(
    (m) => !(m === g.coreMechanic && p.defects.includes("feed_omits_feature")),
  );

  const r: RawFeedRecord = { id: g.id, name };
  if (chance(rng, 0.9)) r.supplier_code = g.supplierGameCode;
  if (thin || chance(rng, 0.95)) r.studio = !inHouse && chance(rng, 0.2) ? `${g.studio} Ltd` : g.studio;
  if (has(1, 0.8)) r.channel = inHouse ? pick(rng, ["in-house", "INTERNAL"]) : p.aggregator!;
  if (g.familyId && has(1, 0.4)) r.family = g.familyId;
  if (has(1, 0.85)) r.type = label(FORMAT_LABELS, g.format);
  if (!p.defects.includes("theme_only_in_prose") && has(0.9, 0.4)) r.theme = label(THEME_LABELS, g.primaryTheme);
  if (has(0.85, 0.5) && mechanics.length) {
    const labels = mechanics.map((m) => label(MECHANIC_LABELS, m));
    r.features = inHouse ? labels.join(", ") : joinList(rng, labels);
  }
  if (g.licensedIp && has(0.9, 0.7)) r.licensed_ip = g.licensedIp;
  if (g.grid && has(0.9, 0.7)) r.reels = pick(rng, [`${g.grid.reels}x${g.grid.rows}`, `${g.grid.reels} x ${g.grid.rows}`, `${g.grid.reels}-${g.grid.rows}`]);
  if (g.paylines && has(0.9, 0.6)) r.lines = g.payStructure === "paylines" ? g.paylines : pick(rng, [`${g.paylines} ways`, String(g.paylines)]);
  if (has(0.9, 0.6)) r.jackpot = label(JACKPOT_LABELS, g.jackpotType);
  if (!p.defects.includes("volatility_conflict") && has(0.9, 0.5)) r.volatility = inHouse ? VOL_LABELS[g.volatility]![0]! : label(VOL_LABELS, g.volatility);
  if (has(0.95, 0.7)) r.rtp = inHouse ? Number((g.rtp * 100).toFixed(2)) : rtpVariant(rng, g.rtp);
  if (has(0.8, 0.4)) r.max_win = pick(rng, [`${g.maxWinMultiplier}x`, g.maxWinMultiplier, `x${g.maxWinMultiplier.toLocaleString("en-GB")}`, `${g.maxWinMultiplier.toLocaleString("en-GB")} x stake`]);
  if (has(0.9, 0.6)) r.stake_range = stakeRange(rng, p);
  if (g.hitFrequency !== null && has(0.6, 0.2)) r.hit_freq = pick(rng, [`${(g.hitFrequency * 100).toFixed(1)}%`, g.hitFrequency, `1:${(1 / g.hitFrequency).toFixed(1)}`]);

  // Operator-owned fields are always present: the operator controls them.
  r.brands = joinList(rng, g.brands.map((b) => label(BRAND_CODES, b)));
  r.markets = joinList(rng, g.jurisdictions.map((j) => label(MARKET_CODES, j)));
  r.status = label(STATUS_LABELS, g.status);
  if (chance(rng, 0.9)) r.release_date = dateVariant(rng, g.releaseDate, g.jurisdictions.every((j) => j.startsWith("US")));
  // The feed misses the RG flag on rg-sensitive games: enrichment should suggest it back.
  if (g.rgFlags.length && !p.defects.includes("rg_sensitive_thin") && chance(rng, inHouse ? 1 : 0.5)) r.rg_flags = g.rgFlags.join(",");

  return RawFeedRecord.parse(r);
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

function buildDocuments(truth: GroundTruth, plan: Plan, rng: Rng, seed: number) {
  const games = new Map(truth.games.map((g) => [g.id, g]));
  const plans = new Map(plan.games.map((p) => [p.id, p]));
  const docs: GameDocument[] = [];
  const docTruth: DocumentTruth[] = [];

  for (const doc of truth.documents) {
    const g = games.get(doc.gameId)!;
    const p = plans.get(doc.gameId)!;
    let clean = toClean(doc, g.name, doc.source);
    let describesGameId: string | null = null;
    const misleadingFacts: z.infer<typeof ExtractableField>[] = [];

    if (doc.kind === "rules_text" && p.defects.includes("wrong_game_rules")) {
      // Copy-paste error: the page is titled for this game but the body is another game's rules.
      const other = truth.documents.find((d) => d.gameId === p.relatedGameId && d.kind === "rules_text")!;
      clean = { ...toClean(other, g.name, doc.source), docId: doc.docId };
      describesGameId = other.gameId;
    }

    if (p.defects.includes("volatility_conflict")) {
      if (doc.kind === "marketing_blurb") {
        clean.sections = [...clean.sections, { text: VOL_CONFLICT_SENTENCE[g.volatility]!, tags: [] }];
        misleadingFacts.push("volatility");
      }
      if (doc.kind === "release_note" && !clean.sections.some((s) => s.tags.includes("volatility"))) {
        clean.sections = [{ heading: "Key facts", text: `Volatility: ${displayFacts(p).volatility}`, tags: ["volatility"] }, ...clean.sections];
      }
    }

    const channel = g.supplyChannel;
    const format = pick(rng, FORMATS_BY_KIND[doc.kind]![channel]);
    const damage: Damage[] = [];
    if (doc.kind === "rules_text" && p.defects.includes("truncated_rules")) damage.push("truncate");
    if (channel === "aggregator") {
      if (chance(rng, 0.15)) damage.push("mojibake");
      if (chance(rng, 0.35)) damage.push("boilerplate");
      if (chance(rng, 0.3)) damage.push("whitespace");
    } else if (chance(rng, 0.2)) damage.push("whitespace");

    const rendered = render(clean, { format, seed, damage });
    const received = receivedAt(rng, g.releaseDate);

    docs.push(
      GameDocument.parse({
        docId: doc.docId,
        gameId: doc.gameId,
        kind: doc.kind,
        format: rendered.format,
        contentType: rendered.contentType,
        source: doc.source,
        receivedAt: received,
        text: rendered.text,
      }),
    );
    docTruth.push({
      docId: doc.docId,
      gameId: doc.gameId,
      kind: doc.kind,
      format: rendered.format,
      // A doc describing another game contains no true facts about this one.
      survivingFacts: describesGameId ? [] : (rendered.survivingTags as DocumentTruth["survivingFacts"]),
      partialFacts: describesGameId ? [] : (rendered.partialTags as DocumentTruth["partialFacts"]),
      damage: rendered.appliedDamage,
      describesGameId,
      misleadingFacts,
    });
  }
  return { docs, docTruth };
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

// ---------- Main ----------

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function main() {
  const seedArg = process.argv.indexOf("--seed");
  const seed = seedArg > -1 ? Number(process.argv[seedArg + 1]) : 7;
  const rng = mulberry32(seed);

  const truth = GroundTruth.parse(JSON.parse(readFileSync(GROUND_TRUTH_PATH, "utf8")));
  const plan = Plan.parse(JSON.parse(readFileSync(PLAN_PATH, "utf8")));
  const plans = new Map(plan.games.map((p) => [p.id, p]));

  const feed = truth.games.map((g) => feedRecord(g, plans.get(g.id)!, rng));
  const { docs, docTruth } = buildDocuments(truth, plan, rng, seed);
  const duplicates = duplicateListings(truth, plan, feed, docs, docTruth, rng);

  const files = {
    "catalogue.raw.json": JSON.stringify(feed, null, 2),
    "documents.json": JSON.stringify(docs, null, 2),
    "documents.truth.json": JSON.stringify(docTruth, null, 2),
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(`${OUT}/${name}`, content);

  const countBy = <T>(xs: T[], f: (x: T) => string) =>
    Object.fromEntries(Object.entries(xs.reduce<Record<string, number>>((a, x) => ((a[f(x)] = (a[f(x)] ?? 0) + 1), a), {})));
  const manifest = Manifest.parse({
    degradeSeed: seed,
    planSeed: plan.seed,
    generation: truth.meta,
    counts: {
      feedRecords: feed.length,
      documents: docs.length,
      ...Object.fromEntries(Object.entries(countBy(docs, (d) => `format:${d.format}`))),
      ...Object.fromEntries(Object.entries(countBy(docs, (d) => `kind:${d.kind}`))),
    },
    duplicates,
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)])),
  });
  writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(`wrote ${feed.length} feed records and ${docs.length} documents to ${OUT}/`);
  console.log(manifest.counts);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
