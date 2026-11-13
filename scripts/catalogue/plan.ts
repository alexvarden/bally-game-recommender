/**
 * Step 1 of catalogue generation: decide the shape of the catalogue in code.
 *
 * Fixes everything that should be controlled rather than left to an LLM: the format mix, theme spread,
 * families, regulated numbers (RTP, max win, stakes), availability, document coverage and planted defects.
 * The LLM (generate.ts) only writes the creative content around these facts.
 *
 * Usage: node scripts/catalogue/plan.ts [--seed 20261113]
 * Output: data/catalogue/plan.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { argValue, countBy, isMain } from "../../src/lib/cli.ts";
import { between, chance, intBetween, mulberry32, pick, sample, shuffle, type Rng } from "../../src/lib/random.ts";
import {
  Brand,
  CoreMechanic,
  DefectKind,
  DocumentKind,
  Format,
  JackpotType,
  Jurisdiction,
  PayStructure,
  RgFlag,
  Status,
  SupplyChannel,
  Theme,
  Volatility,
} from "../../src/catalogue/schema.ts";

export const PLAN_PATH = "data/catalogue/plan.json";
export const DEFAULT_SEED = 20261113;

const VariantKind = z.enum(["megaways", "jackpot", "deluxe"]);

export const PlannedGame = z.object({
  id: z.string(),
  supplierGameCode: z.string(),
  studio: z.string(),
  supplyChannel: SupplyChannel,
  aggregator: z.string().nullable(),
  familyId: z.string().nullable(),
  familyRole: z.enum(["base", "variant"]).nullable(),
  variantKind: VariantKind.nullable(),
  format: Format,
  primaryTheme: Theme,
  coreMechanic: CoreMechanic,
  payStructure: PayStructure,
  grid: z.object({ reels: z.number(), rows: z.number() }).nullable(),
  paylines: z.number().nullable(),
  jackpotType: JackpotType,
  volatility: Volatility,
  rtp: z.number(),
  maxWinMultiplier: z.number(),
  minStake: z.number(),
  maxStake: z.number(),
  hitFrequency: z.number().nullable(),
  currency: z.enum(["GBP", "USD"]),
  brands: z.array(Brand),
  jurisdictions: z.array(Jurisdiction),
  status: Status,
  releaseDate: z.string(),
  rgFlags: z.array(RgFlag),
  hasLicensedIp: z.boolean(),
  bonusBuyAllowed: z.boolean(),
  documents: z.array(DocumentKind),
  defects: z.array(DefectKind),
  /** For wrong_game_rules / duplicate_listing: the other game involved. */
  relatedGameId: z.string().nullable(),
});
export type PlannedGame = z.infer<typeof PlannedGame>;

export const Plan = z.object({ seed: z.number(), createdAt: z.string(), games: z.array(PlannedGame) });
export type Plan = z.infer<typeof Plan>;

// ---------- Catalogue shape ----------

const FORMAT_MIX: [z.infer<typeof Format>, number][] = [
  ["video_slot", 58],
  ["classic_slot", 7],
  ["slingo", 10],
  ["bingo", 6],
  ["live_dealer", 6],
  ["table", 5],
  ["instant_win", 4],
  ["crash", 2],
  ["game_show", 2],
];

/** Fictional studios. In-house mirrors an operator-owned studio; the rest arrive via aggregators. */
const IN_HOUSE_STUDIOS = ["Northlight Studios", "Harbour Lane Games"];
const AGGREGATOR_STUDIOS = [
  "Sandstone Studios",
  "Red Kite Gaming",
  "Lucky Lantern",
  "Fjord Games",
  "Neon Arcade",
  "Copperline",
  "Bluefin Interactive",
  "Wildgrove",
  "Paragon Play",
  "Starling Reels",
];
const AGGREGATORS = ["Spinlane Hub", "ReelBridge"];

const SLOT_MECHANICS: z.infer<typeof CoreMechanic>[] = [
  "hold_and_win",
  "cascades",
  "expanding_wilds",
  "sticky_wilds",
  "multipliers",
  "cash_collect",
  "pick_me_bonus",
  "wheel_bonus",
  "free_spins",
];

const GB_BRANDS: z.infer<typeof Brand>[] = ["jackpotjoy", "virgin_games", "monopoly_casino", "rainbow_riches_casino"];

const FAMILY_COUNT = 8;

// ---------- Per-format rules ----------

function mechanicFor(format: z.infer<typeof Format>, rng: Rng, slotMechanic: z.infer<typeof CoreMechanic>) {
  switch (format) {
    case "video_slot":
      return slotMechanic;
    case "classic_slot":
      return pick(rng, ["free_spins", "multipliers", "wheel_bonus"] as const);
    case "slingo":
      return "slingo_grid";
    case "bingo":
      return "bingo_ball_draw";
    case "live_dealer":
      return pick(rng, ["live_wheel", "card_table"] as const);
    case "table":
      return "card_table";
    case "instant_win":
      return "scratch_reveal";
    case "crash":
      return "crash_multiplier";
    case "game_show":
      return "live_wheel";
  }
}

function volatilityFor(format: z.infer<typeof Format>, rng: Rng): z.infer<typeof Volatility> {
  if (format === "table" || format === "live_dealer") return pick(rng, ["low", "medium"] as const);
  if (format === "crash") return "very_high";
  if (format === "bingo" || format === "instant_win") return pick(rng, ["low", "medium", "medium", "high"] as const);
  return pick(rng, ["low", "medium", "medium", "high", "high", "very_high"] as const);
}

function structureFor(format: z.infer<typeof Format>, mechanic: string, rng: Rng) {
  if (format === "classic_slot") {
    return { payStructure: "paylines" as const, grid: { reels: 3, rows: 3 }, paylines: pick(rng, [1, 5, 9]) };
  }
  if (format === "video_slot") {
    if (mechanic === "cascades" && chance(rng, 0.5)) {
      return { payStructure: "cluster_pays" as const, grid: { reels: 7, rows: 7 }, paylines: null };
    }
    const r = rng();
    if (r < 0.15) return { payStructure: "megaways" as const, grid: { reels: 6, rows: 7 }, paylines: 117649 };
    if (r < 0.4) return { payStructure: "ways" as const, grid: { reels: 5, rows: 3 }, paylines: 243 };
    if (r < 0.5) return { payStructure: "ways" as const, grid: { reels: 5, rows: 4 }, paylines: 1024 };
    return {
      payStructure: "paylines" as const,
      grid: { reels: 5, rows: pick(rng, [3, 3, 4]) },
      paylines: pick(rng, [10, 20, 20, 25, 40]),
    };
  }
  if (format === "slingo") return { payStructure: "not_applicable" as const, grid: { reels: 5, rows: 5 }, paylines: null };
  return { payStructure: "not_applicable" as const, grid: null, paylines: null };
}

function rtpFor(format: z.infer<typeof Format>, channel: z.infer<typeof SupplyChannel>, rng: Rng) {
  const ranges: Record<z.infer<typeof Format>, [number, number]> = {
    video_slot: [0.94, 0.968],
    classic_slot: [0.945, 0.965],
    slingo: [0.95, 0.96],
    bingo: [0.85, 0.92],
    live_dealer: [0.955, 0.973],
    table: [0.985, 0.995],
    instant_win: [0.9, 0.95],
    crash: [0.96, 0.97],
    game_show: [0.955, 0.965],
  };
  const [lo, hi] = ranges[format];
  // In-house games sit at the lower end: the operator keeps more margin on its own content.
  const rtp = channel === "in_house" ? between(rng, lo, lo + (hi - lo) * 0.6) : between(rng, lo, hi);
  return Math.round(rtp * 10000) / 10000;
}

function maxWinFor(format: z.infer<typeof Format>, vol: z.infer<typeof Volatility>, rng: Rng) {
  if (format === "table") return pick(rng, [35, 150, 500]);
  if (format === "live_dealer") return pick(rng, [35, 500, 2000]);
  const bands: Record<z.infer<typeof Volatility>, [number, number]> = {
    low: [500, 2000],
    medium: [2000, 5000],
    high: [5000, 15000],
    very_high: [15000, 50000],
  };
  const [lo, hi] = bands[vol];
  return Math.round(between(rng, lo, hi) / 100) * 100;
}

function hitFrequencyFor(format: z.infer<typeof Format>, vol: z.infer<typeof Volatility>, rng: Rng) {
  if (format !== "video_slot" && format !== "classic_slot") return null;
  if (chance(rng, 0.3)) return null; // many suppliers don't publish it
  const base = { low: 0.36, medium: 0.29, high: 0.23, very_high: 0.18 }[vol];
  return Math.round((base + between(rng, -0.03, 0.03)) * 1000) / 1000;
}

function stakesFor(format: z.infer<typeof Format>, isGb: boolean, rng: Rng) {
  const isSlot = format === "video_slot" || format === "classic_slot" || format === "slingo";
  const minStake = pick(rng, [0.1, 0.1, 0.2, 0.25]);
  // UK online slot stake limit is £5 per spin.
  if (isSlot && isGb) return { minStake, maxStake: 5 };
  if (isSlot) return { minStake, maxStake: pick(rng, [50, 100, 200]) };
  if (format === "bingo") return { minStake: pick(rng, [0.05, 0.1]), maxStake: pick(rng, [2, 5]) };
  if (format === "instant_win") return { minStake: pick(rng, [0.5, 1]), maxStake: pick(rng, [5, 10]) };
  return { minStake: pick(rng, [0.1, 0.5, 1]), maxStake: pick(rng, [500, 1000, 2500]) };
}

function releaseDateFor(status: z.infer<typeof Status>, rng: Rng) {
  const start = status === "coming_soon" ? Date.UTC(2026, 11, 1) : Date.UTC(2019, 0, 1);
  const end = status === "coming_soon" ? Date.UTC(2027, 2, 31) : Date.UTC(2026, 9, 31);
  return new Date(between(rng, start, end)).toISOString().slice(0, 10);
}

// ---------- Build ----------
//
// Random draws happen in a fixed order, so a given seed always yields the same plan. If you change the order of
// draws, the committed catalogue no longer matches its plan: plan.test.ts catches that.

type Market = "gb" | "both" | "us";

/** Hands out values from a shuffled list, reshuffling when it runs out, so values spread evenly. */
export function cycler<T>(rng: Rng, values: readonly T[]): () => T {
  const queue: T[] = [];
  return () => {
    if (queue.length === 0) queue.push(...shuffle(rng, values));
    return queue.pop()!;
  };
}

function orderedFormats(rng: Rng) {
  const formats = shuffle(
    rng,
    FORMAT_MIX.flatMap(([f, n]) => Array.from({ length: n }, () => f)),
  );
  // Families are video slots; pull them to the front so their members get contiguous ids.
  return formats.sort((a, b) => Number(b === "video_slot") - Number(a === "video_slot"));
}

export function gameId(format: z.infer<typeof Format>, index: number) {
  const prefix = format === "video_slot" || format === "classic_slot" ? "SLT" : format.slice(0, 3).toUpperCase();
  return `BLY-${prefix}-${String(index + 1).padStart(4, "0")}`;
}

/** Most games are GB-only, some are shared with the US site, a few are US-only. */
function marketFor(rng: Rng): Market {
  const r = rng();
  if (r < 0.08) return "us";
  return r < 0.23 ? "both" : "gb";
}

function gbBrandsFor(format: z.infer<typeof Format>, rng: Rng): z.infer<typeof Brand>[] {
  if (format === "bingo") return ["double_bubble_bingo", ...sample(rng, ["jackpotjoy", "virgin_games"] as const, intBetween(rng, 0, 2))];
  if (format === "slingo") return ["monopoly_casino", ...sample(rng, ["jackpotjoy", "virgin_games", "double_bubble_bingo"] as const, intBetween(rng, 0, 2))];
  return sample(rng, GB_BRANDS, chance(rng, 0.15) ? 1 : intBetween(rng, 2, 4));
}

export function brandsFor(format: z.infer<typeof Format>, market: Market, rng: Rng): z.infer<typeof Brand>[] {
  // Drawn even for US-only games, to keep the seeded sequence stable.
  const gb = gbBrandsFor(format, rng);
  if (market === "us") return ["bally_casino_us"];
  return market === "both" ? [...gb, "bally_casino_us"] : gb;
}

export function jurisdictionsFor(market: Market, rng: Rng): z.infer<typeof Jurisdiction>[] {
  const isGb = market !== "us";
  return [
    ...(isGb ? (["GB"] as const) : []),
    ...(isGb && chance(rng, 0.15) ? (["ES"] as const) : []),
    ...(market !== "gb" ? (["US-NJ", "US-PA"] as const) : []),
  ];
}

function jackpotFor(mechanic: z.infer<typeof CoreMechanic>, rng: Rng): z.infer<typeof JackpotType> {
  if (mechanic === "hold_and_win" && chance(rng, 0.6)) return "fixed";
  return chance(rng, 0.08) ? "local_progressive" : "none";
}

function rgFlagsFor(format: z.infer<typeof Format>, volatility: z.infer<typeof Volatility>, rng: Rng): z.infer<typeof RgFlag>[] {
  return format === "crash" || (volatility === "very_high" && chance(rng, 0.4)) ? ["high_intensity"] : [];
}

/** In-house games always have rules; aggregator games mostly arrive with a blurb and sometimes more. */
export function documentsFor(channel: z.infer<typeof SupplyChannel>, rng: Rng): z.infer<typeof DocumentKind>[] {
  const docs: z.infer<typeof DocumentKind>[] =
    channel === "in_house"
      ? ["rules_text", ...(chance(rng, 0.7) ? (["editorial"] as const) : []), ...(chance(rng, 0.5) ? (["marketing_blurb"] as const) : [])]
      : [
          ...(chance(rng, 0.9) ? (["marketing_blurb"] as const) : []),
          ...(chance(rng, 0.65) ? (["rules_text"] as const) : []),
          ...(chance(rng, 0.5) ? (["release_note"] as const) : []),
        ];
  return docs.length ? docs : ["marketing_blurb"];
}

function themeFor(format: z.infer<typeof Format>, rng: Rng, nextTheme: () => z.infer<typeof Theme>) {
  if (format === "live_dealer" || format === "table") return pick(rng, ["luxury_vegas", "tv_gameshow", "fruit_classic"] as const);
  return nextTheme();
}

function startsFamily(rng: Rng, format: z.infer<typeof Format>, index: number, familiesMade: number) {
  return familiesMade < FAMILY_COUNT && format === "video_slot" && index < 40 && chance(rng, 0.5);
}

interface Cyclers {
  theme: () => z.infer<typeof Theme>;
  mechanic: () => z.infer<typeof CoreMechanic>;
}

function planStandalone(rng: Rng, format: z.infer<typeof Format>, index: number, familiesMade: number, next: Cyclers): PlannedGame {
  const supplyChannel: z.infer<typeof SupplyChannel> = chance(rng, 0.25) ? "in_house" : "aggregator";
  const studio = pick(rng, supplyChannel === "in_house" ? IN_HOUSE_STUDIOS : AGGREGATOR_STUDIOS);
  const coreMechanic = mechanicFor(format, rng, next.mechanic());
  const volatility = volatilityFor(format, rng);
  const market = marketFor(rng);
  const brands = brandsFor(format, market, rng);
  const jurisdictions = jurisdictionsFor(market, rng);
  const familyId = startsFamily(rng, format, index, familiesMade) ? `FAM-${String(familiesMade + 1).padStart(2, "0")}` : null;
  const structure = structureFor(format, coreMechanic, rng);
  const isGb = market !== "us";

  const game: PlannedGame = {
    id: gameId(format, index),
    supplierGameCode: `${studio.split(" ")[0]!.slice(0, 3).toUpperCase()}${intBetween(rng, 1000, 9999)}`,
    studio,
    supplyChannel,
    aggregator: supplyChannel === "aggregator" ? pick(rng, AGGREGATORS) : null,
    familyId,
    familyRole: familyId ? "base" : null,
    variantKind: null,
    format,
    primaryTheme: themeFor(format, rng, next.theme),
    coreMechanic,
    ...structure,
    jackpotType: jackpotFor(coreMechanic, rng),
    volatility,
    rtp: rtpFor(format, supplyChannel, rng),
    maxWinMultiplier: maxWinFor(format, volatility, rng),
    ...stakesFor(format, isGb, rng),
    hitFrequency: hitFrequencyFor(format, volatility, rng),
    currency: isGb ? "GBP" : "USD",
    brands,
    jurisdictions,
    status: "live",
    releaseDate: "",
    rgFlags: rgFlagsFor(format, volatility, rng),
    hasLicensedIp: format === "video_slot" && chance(rng, 0.08),
    // Bonus buy is restricted in GB: only US-only games may have it.
    bonusBuyAllowed: market === "us",
    documents: documentsFor(supplyChannel, rng),
    defects: [],
    relatedGameId: null,
  };
  game.releaseDate = releaseDateFor(game.status, rng);
  return game;
}

/** How each kind of variant differs from its base game. */
const VARIANT_CHANGES: Record<z.infer<typeof VariantKind>, (base: PlannedGame, rng: Rng) => Partial<PlannedGame>> = {
  megaways: (b, rng) => ({ payStructure: "megaways", grid: { reels: 6, rows: 7 }, paylines: 117649, volatility: "very_high", maxWinMultiplier: maxWinFor(b.format, "very_high", rng) }),
  jackpot: (b) => ({ jackpotType: "network_progressive", rtp: Math.round((b.rtp - 0.02) * 10000) / 10000 }),
  deluxe: (b) => ({ volatility: b.volatility === "low" ? "medium" : b.volatility, maxWinMultiplier: Math.round(b.maxWinMultiplier * 1.5) }),
};

/** Variants copy the family's identity and differ in one dimension. */
export function planVariant(base: PlannedGame, variantKind: z.infer<typeof VariantKind>, id: string, rng: Rng): PlannedGame {
  const game: PlannedGame = {
    ...base,
    id,
    supplierGameCode: `${base.supplierGameCode}-${variantKind.slice(0, 2).toUpperCase()}`,
    familyRole: "variant",
    variantKind,
    status: "live",
    releaseDate: releaseDateFor("live", rng),
    documents: [...base.documents],
    defects: [],
    relatedGameId: null,
  };
  return { ...game, ...VARIANT_CHANGES[variantKind](base, rng) };
}

export function buildPlan(seed: number): Plan {
  const rng = mulberry32(seed);
  const formats = orderedFormats(rng);
  // Spread themes and slot mechanics so every value has neighbours to be recommended.
  const next: Cyclers = { theme: cycler(rng, Theme.options), mechanic: cycler(rng, SLOT_MECHANICS) };

  const games: PlannedGame[] = [];
  let family: { base: PlannedGame; remaining: z.infer<typeof VariantKind>[] } | null = null;
  let familiesMade = 0;

  formats.forEach((format, index) => {
    if (family) {
      games.push(planVariant(family.base, family.remaining.shift()!, gameId(format, index), rng));
      if (family.remaining.length === 0) family = null;
      return;
    }
    const game = planStandalone(rng, format, index, familiesMade, next);
    games.push(game);
    if (game.familyId) {
      familiesMade++;
      family = { base: game, remaining: sample(rng, VariantKind.options, chance(rng, 0.4) ? 2 : 1) };
    }
  });

  assignStatuses(games, rng);
  assignDefects(games, rng);
  return { seed, createdAt: new Date().toISOString(), games };
}

function assignStatuses(games: PlannedGame[], rng: Rng) {
  const standalone = games.filter((g) => !g.familyId);
  const picks = sample(rng, standalone, 7);
  const statuses: z.infer<typeof Status>[] = ["retired", "retired", "retired", "suspended", "suspended", "coming_soon", "coming_soon"];
  picks.forEach((g, i) => {
    g.status = statuses[i]!;
    g.releaseDate = releaseDateFor(g.status, rng);
  });
}

/** Plants the defects that become eval cases. Each game gets at most one so failures are attributable. */
function assignDefects(games: PlannedGame[], rng: Rng) {
  const free = () => shuffle(rng, games.filter((g) => g.defects.length === 0 && g.status === "live"));
  const take = (n: number, pred: (g: PlannedGame) => boolean) => free().filter(pred).slice(0, n);
  const isSlot = (g: PlannedGame) => g.format === "video_slot" || g.format === "classic_slot";

  for (const g of take(6, (g) => g.supplyChannel === "aggregator" && !g.familyId)) {
    g.defects.push("thin_record");
    g.documents = ["marketing_blurb"];
  }
  for (const g of take(2, (g) => g.format === "video_slot" && g.supplyChannel === "aggregator" && !g.familyId)) {
    g.defects.push("rg_sensitive_thin");
    g.primaryTheme = pick(rng, ["food_sweets", "animals_wildlife"] as const);
    g.rgFlags = ["may_appeal_to_under_18s"];
    g.documents = ["marketing_blurb"];
  }
  for (const g of take(6, (g) => g.documents.includes("rules_text") && isSlot(g))) g.defects.push("truncated_rules");
  for (const g of take(3, (g) => g.documents.includes("rules_text") && isSlot(g))) {
    g.defects.push("wrong_game_rules");
    const other = pick(rng, games.filter((o) => o.id !== g.id && isSlot(o) && o.primaryTheme !== g.primaryTheme && o.documents.includes("rules_text")));
    g.relatedGameId = other.id;
  }
  for (const g of take(4, (g) => g.documents.includes("marketing_blurb") && g.volatility !== "low" && isSlot(g))) {
    g.defects.push("volatility_conflict");
    if (!g.documents.includes("release_note")) g.documents.push("release_note");
  }
  for (const g of take(6, (g) => g.documents.includes("rules_text") && isSlot(g))) g.defects.push("feed_omits_feature");
  for (const g of take(8, (g) => g.documents.length >= 2)) g.defects.push("theme_only_in_prose");
  for (const g of take(2, (g) => g.supplyChannel === "aggregator")) g.defects.push("duplicate_listing");
}

// ---------- Entry point ----------

export function summarise(plan: Plan) {
  const games = plan.games;
  return {
    formats: countBy(games, (g) => g.format),
    channel: countBy(games, (g) => g.supplyChannel),
    status: countBy(games, (g) => g.status),
    families: countBy(games, (g) => g.familyRole ?? "none"),
    defects: countBy(games, (g) => g.defects),
    docs: countBy(games, (g) => g.documents),
    themes: countBy(games, (g) => g.primaryTheme),
  };
}

export function run(argv: readonly string[], outPath = PLAN_PATH): Plan {
  const plan = Plan.parse(buildPlan(Number(argValue(argv, "--seed", String(DEFAULT_SEED)))));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(plan, null, 2));
  console.log(`wrote ${plan.games.length} planned games to ${outPath}`, summarise(plan));
  return plan;
}

if (isMain(import.meta.url)) run(process.argv);
