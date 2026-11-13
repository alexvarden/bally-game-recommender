/**
 * Raw feed record → SourceGame. Deterministic code, no LLM.
 *
 * Every field parser returns a value or null. A value that is present but can't be parsed with confidence is never
 * guessed: it stays null and is reported in `unparsed`, which is a feed-quality metric per supplier. Enrichment may
 * later fill descriptive gaps from documents, but regulated facts only come from here or from a verified quote.
 */
import type { z } from "zod";
import { CoreMechanic, RawFeedRecord, RgFlag, SecondaryFeature, SourceGame, type PayStructure } from "../catalogue/schema.ts";
import {
  BRAND_VOCAB,
  CORE_MECHANIC_VOCAB,
  FORMAT_VOCAB,
  IN_HOUSE_CHANNELS,
  JACKPOT_VOCAB,
  lookupFor,
  MARKET_VOCAB,
  SECONDARY_FEATURE_VOCAB,
  STATUS_VOCAB,
  THEME_VOCAB,
  VOLATILITY_VOCAB,
  type Lookup,
} from "./vocabulary.ts";

export interface NormalisedFeed {
  game: SourceGame;
  /** "field: raw value" for every present value that couldn't be parsed. */
  unparsed: string[];
}

const formats = lookupFor(FORMAT_VOCAB);
const themes = lookupFor(THEME_VOCAB);
const coreMechanics = lookupFor(CORE_MECHANIC_VOCAB);
const secondaryFeatures = lookupFor(SECONDARY_FEATURE_VOCAB);
const volatilities = lookupFor(VOLATILITY_VOCAB);
const jackpots = lookupFor(JACKPOT_VOCAB);
const brands = lookupFor(BRAND_VOCAB);
const markets = lookupFor(MARKET_VOCAB);
const statuses = lookupFor(STATUS_VOCAB);

// ---------- Field parsers ----------

const LIST_SEPARATOR = /\s*[,;|]\s*/;

const splitList = (s: string) => s.split(LIST_SEPARATOR).filter(Boolean);

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

/** 96.12, "96.12%", 0.9612, "96,12", "96.12 %" → 0.9612. */
export function parseRtp(raw: string | number): number | null {
  const n = typeof raw === "number" ? raw : Number(raw.replace("%", "").replace(",", ".").trim());
  if (!Number.isFinite(n)) return null;
  const rtp = n > 1 ? n / 100 : n;
  return rtp >= 0.8 && rtp <= 0.995 ? round(rtp, 4) : null;
}

/** "5000x", 5000, "x5,000", "5,000 x stake" → 5000. */
export function parseMultiplier(raw: string | number): number | null {
  const n = typeof raw === "number" ? raw : Number(raw.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "£0.10 - £5.00", "0.1-5", "10p–£5", "$0.1 to $100", "min 0.1 / max 5 GBP" → { minStake, maxStake }. */
export function parseStakeRange(raw: string): { minStake: number; maxStake: number } | null {
  const amounts = [...raw.matchAll(/(\d+(?:\.\d+)?)(p)?/gi)].map((m) => (m[2] ? Number(m[1]) / 100 : Number(m[1])));
  if (amounts.length !== 2) return null;
  const [minStake, maxStake] = amounts as [number, number];
  return minStake > 0 && minStake <= maxStake ? { minStake: round(minStake, 2), maxStake: round(maxStake, 2) } : null;
}

/** "29.4%", 0.294, "1:3.4" → 0.294 (share of spins that win). */
export function parseHitFrequency(raw: string | number): number | null {
  if (typeof raw === "number") return raw > 0 && raw < 1 ? raw : null;
  const ratio = raw.match(/^\s*1\s*:\s*(\d+(?:\.\d+)?)\s*$/);
  if (ratio) return round(1 / Number(ratio[1]), 3);
  const pct = raw.match(/^\s*(\d+(?:\.\d+)?)\s*%\s*$/);
  return pct ? round(Number(pct[1]) / 100, 3) : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const isoDate = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  const valid = date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  return valid ? date.toISOString().slice(0, 10) : null;
};

/** Slash dates are only accepted when unambiguous: 12/03/2024 could be 12 March or 3 December. */
function parseSlashDate(a: number, b: number, y: number) {
  if (a > 12 && b <= 12) return isoDate(y, b, a);
  if (b > 12 && a <= 12) return isoDate(y, a, b);
  return a === b ? isoDate(y, a, b) : null;
}

/** "2024-03-12", "2024-03-12T00:00:00Z", "12 Mar 2024", unambiguous dd/mm or mm/dd → "2024-03-12". */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+Z?)?$/);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const named = s.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/);
  if (named) {
    const month = MONTHS.indexOf(named[2]!.toLowerCase()) + 1;
    return month ? isoDate(Number(named[3]), month, Number(named[1])) : null;
  }
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return slash ? parseSlashDate(Number(slash[1]), Number(slash[2]), Number(slash[3])) : null;
}

/** "5x3", "5 x 3", "5-3" → { reels: 5, rows: 3 }. */
export function parseGrid(raw: string): { reels: number; rows: number } | null {
  const m = raw.match(/^\s*(\d+)\s*[x×-]\s*(\d+)\s*$/i);
  return m ? { reels: Number(m[1]), rows: Number(m[2]) } : null;
}

const MEGAWAYS = 117649;

/** 20 → paylines; "243 ways" → ways; 117649 → megaways; a bare numeric string has an unknown pay structure. */
export function parseLines(raw: string | number): { paylines: number; payStructure: z.infer<typeof PayStructure> | null } | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 ? { paylines: raw, payStructure: raw === MEGAWAYS ? "megaways" : "paylines" } : null;
  const m = raw.match(/^\s*([\d,]+)\s*(ways)?\s*$/i);
  if (!m) return null;
  const paylines = Number(m[1]!.replace(/,/g, ""));
  if (paylines === MEGAWAYS) return { paylines, payStructure: "megaways" };
  return { paylines, payStructure: m[2] ? "ways" : null };
}

/** Maps every list item through a lookup; returns the values and the items it couldn't map. */
export function parseList<V extends string>(raw: string, lookup: Lookup<V>): { values: V[]; unknown: string[] } {
  const values: V[] = [];
  const unknown: string[] = [];
  for (const item of splitList(raw)) {
    const { value } = lookup(item);
    if (value) values.push(value);
    else unknown.push(item);
  }
  return { values: [...new Set(values)], unknown };
}

const isSecondaryFeature = (v: string): v is z.infer<typeof SecondaryFeature> => SecondaryFeature.safeParse(v).success;

/**
 * Feature list → core mechanic and secondary features. The core mechanic is only set when exactly one listed
 * feature is a defining mechanic; a list of only side features (free spins, respins) says nothing reliable
 * about what defines the game.
 */
export function parseFeatures(raw: string) {
  const core: z.infer<typeof CoreMechanic>[] = [];
  const secondary: z.infer<typeof SecondaryFeature>[] = [];
  const unknown: string[] = [];
  for (const item of splitList(raw)) {
    const coreHit = coreMechanics(item).value;
    const secondaryHit = secondaryFeatures(item).value;
    if (coreHit) core.push(coreHit);
    else if (secondaryHit && isSecondaryFeature(secondaryHit)) secondary.push(secondaryHit);
    else unknown.push(item);
  }
  const uniqueCore = [...new Set(core)];
  return { coreMechanic: uniqueCore.length === 1 ? uniqueCore[0]! : null, secondaryFeatures: [...new Set(secondary)], unknown };
}

/** Removes feed decoration (™, regulator suffixes) and restores case on SHOUTED names. */
export function cleanName(raw: string): string {
  const stripped = raw.replace(/™/g, "").replace(/\s*\((?:UKGC|GB|UK)\)\s*$/i, "").trim();
  if (stripped !== stripped.toUpperCase() || !/[A-Z]/.test(stripped)) return stripped;
  return stripped.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}

/** A matching key for duplicate detection: case, punctuation and decoration don't count. */
export const nameKey = (raw: string) => cleanName(raw).toLowerCase().replace(/[^a-z0-9]/g, "");

const cleanStudio = (raw: string) => raw.replace(/\s+Ltd\.?$/i, "").trim();

function parseChannel(raw: string) {
  if (IN_HOUSE_CHANNELS.includes(raw.trim().toLowerCase())) return "in_house" as const;
  return raw.trim() ? ("aggregator" as const) : null;
}

const parseRgFlags = (raw: string) => {
  const items = splitList(raw);
  return { values: items.filter((f) => RgFlag.safeParse(f).success) as z.infer<typeof RgFlag>[], unknown: items.filter((f) => !RgFlag.safeParse(f).success) };
};

// ---------- Record ----------

class Notes {
  readonly unparsed: string[] = [];

  /** Parses a present value; records it as unparsed if the parser returns null. */
  scalar<R, T>(field: string, raw: R | undefined, parse: (raw: R) => T | null): T | null {
    if (raw === undefined) return null;
    const value = parse(raw);
    if (value === null) this.unparsed.push(`${field}: ${String(raw)}`);
    return value;
  }

  list<V>(field: string, parsed: { values: V[]; unknown: string[] }): V[] {
    for (const u of parsed.unknown) this.unparsed.push(`${field}: ${u}`);
    return parsed.values;
  }
}

const label = <V extends string>(lookup: Lookup<V>) => (raw: string) => lookup(raw).value;

function structuralValues(raw: RawFeedRecord, notes: Notes) {
  const lines = notes.scalar("lines", raw.lines, parseLines);
  return {
    format: notes.scalar("type", raw.type, label(formats)),
    grid: notes.scalar("reels", raw.reels, parseGrid),
    paylines: lines?.paylines ?? null,
    payStructure: lines?.payStructure ?? null,
    jackpotType: notes.scalar("jackpot", raw.jackpot, label(jackpots)),
  };
}

function regulatedValues(raw: RawFeedRecord, notes: Notes) {
  const stakes = notes.scalar("stake_range", raw.stake_range, parseStakeRange);
  return {
    volatility: notes.scalar("volatility", raw.volatility, label(volatilities)),
    rtp: notes.scalar("rtp", raw.rtp, parseRtp),
    maxWinMultiplier: notes.scalar("max_win", raw.max_win, parseMultiplier),
    minStake: stakes?.minStake ?? null,
    maxStake: stakes?.maxStake ?? null,
    hitFrequency: notes.scalar("hit_freq", raw.hit_freq, parseHitFrequency),
  };
}

function descriptiveValues(raw: RawFeedRecord, notes: Notes) {
  const features = raw.features === undefined ? null : parseFeatures(raw.features);
  if (features) notes.list("features", { values: [], unknown: features.unknown });
  return {
    primaryTheme: notes.scalar("theme", raw.theme, label(themes)),
    coreMechanic: features?.coreMechanic ?? null,
    secondaryFeatures: features?.secondaryFeatures.length ? features.secondaryFeatures : null,
  };
}

/** Drops null entries: `feedValues` only holds what the feed actually supplied and we could parse. */
const present = <T extends Record<string, unknown>>(values: T) =>
  Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null)) as { [K in keyof T]?: Exclude<T[K], null> };

export function normaliseFeedRecord(input: unknown): NormalisedFeed {
  const raw = RawFeedRecord.parse(input);
  const notes = new Notes();
  const game = SourceGame.parse({
    id: raw.id,
    name: cleanName(raw.name),
    supplierGameCode: raw.supplier_code ?? null,
    studio: raw.studio === undefined ? null : cleanStudio(raw.studio),
    supplyChannel: notes.scalar("channel", raw.channel, parseChannel),
    familyId: raw.family ?? null,
    familyRole: null,
    licensedIp: raw.licensed_ip ?? null,
    brands: raw.brands === undefined ? [] : notes.list("brands", parseList(raw.brands, brands)),
    jurisdictions: raw.markets === undefined ? [] : notes.list("markets", parseList(raw.markets, markets)),
    status: notes.scalar("status", raw.status, label(statuses)),
    releaseDate: notes.scalar("release_date", raw.release_date, parseDate),
    rgFlags: raw.rg_flags === undefined ? [] : notes.list("rg_flags", parseRgFlags(raw.rg_flags)),
    feedValues: present({ ...structuralValues(raw, notes), ...regulatedValues(raw, notes), ...descriptiveValues(raw, notes) }),
  });
  return { game, unparsed: notes.unparsed };
}
