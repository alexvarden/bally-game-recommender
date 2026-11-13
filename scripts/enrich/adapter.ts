/**
 * TEMPORARY adapter from the committed files to the enrichment inputs, until the ingestion workstream's SQLite
 * store and feed normaliser land. It parses only what enrichment needs: identity, operator-owned fields and the
 * regulated facts (so feed-vs-document conflicts can be detected). Descriptive feed labels are left to the LLM.
 */
import { SourceGame, type GameDocument, type RawFeedRecord } from "../../src/catalogue/schema.ts";
import type { NormalisedDocument } from "../../src/contracts/storage.ts";
import { amountsIn, frequenciesIn, volatilityIn } from "../../src/enrich/evidence.ts";
import { normaliseDocument } from "../../src/text/normalise.ts";

const lookup = <T extends string>(table: Record<T, string[]>) => (label: string): T | null =>
  (Object.entries(table) as [T, string[]][]).find(([, labels]) => labels.includes(label.trim().toLowerCase()))?.[0] ?? null;

const brandOf = lookup({
  jackpotjoy: ["jpj", "jackpotjoy"],
  virgin_games: ["vg", "virgin games", "virgin"],
  monopoly_casino: ["mon", "monopoly casino", "monopoly"],
  rainbow_riches_casino: ["rrc", "rainbow riches", "rainbowriches"],
  double_bubble_bingo: ["dbb", "double bubble", "doublebubble"],
  bally_casino_us: ["bally-us", "bally casino (us)", "ballyus"],
});

const marketOf = lookup({ GB: ["gb", "uk", "ukgc"], ES: ["es", "spain", "dgoj"], "US-NJ": ["nj", "us-nj"], "US-PA": ["pa", "us-pa"] });

const statusOf = lookup({
  live: ["live", "active", "1"],
  coming_soon: ["coming soon", "pre-release", "scheduled"],
  suspended: ["suspended", "disabled", "off"],
  retired: ["retired", "eol", "archived"],
});

const listOf = <T>(raw: string | undefined, parse: (s: string) => T | null): T[] =>
  (raw ?? "").split(/[,;|]/).map(parse).filter((x): x is T => x !== null);

const asNumber = (s: string) => Number(s.replace(/[^\d.]/g, ""));

export function parseRtp(raw: string | number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = typeof raw === "number" ? raw : Number(raw.replace("%", "").replace(",", ".").trim());
  if (!Number.isFinite(n)) return undefined;
  return Math.round((n > 1 ? n / 100 : n) * 10000) / 10000;
}

const VOLATILITY_LETTERS: Record<string, "low" | "medium" | "high"> = { l: "low", m: "medium", h: "high" };

export function parseVolatility(raw: string | undefined) {
  if (!raw) return undefined;
  return VOLATILITY_LETTERS[raw.trim().toLowerCase()] ?? volatilityIn(raw) ?? undefined;
}

export function parseMaxWin(raw: string | number | undefined) {
  if (raw === undefined) return undefined;
  const n = typeof raw === "number" ? raw : asNumber(raw);
  return n > 0 ? n : undefined;
}

export function parseStakes(raw: string | undefined): { minStake?: number; maxStake?: number } {
  if (!raw) return {};
  const symbolised = amountsIn(raw);
  const values = symbolised.length >= 2 ? symbolised : [...raw.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  return values.length >= 2 ? { minStake: Math.min(...values), maxStake: Math.max(...values) } : {};
}

export function parseHitFrequency(raw: string | number | undefined) {
  if (raw === undefined) return undefined;
  if (typeof raw === "number") return raw;
  return frequenciesIn(raw)[0];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const pad = (s: string) => s.padStart(2, "0");

/**
 * Slash dates are read day-first (UK feeds) unless the middle number can't be a month, which means a US feed.
 * Ambiguous dates such as 03/04/2025 stay day-first; the README notes this as a known feed-quality limit.
 */
function slashDate(a: string, b: string, year: string) {
  return Number(b) > 12 ? `${year}-${pad(a)}-${pad(b)}` : `${year}-${pad(b)}-${pad(a)}`;
}

/** ISO, dd/mm/yyyy, mm/dd/yyyy, "1 Apr 2026" or an ISO timestamp → yyyy-mm-dd. */
export function parseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return slashDate(slash[1]!, slash[2]!, slash[3]!);
  const words = raw.match(/^(\d{1,2}) ([a-z]{3,4})\.? (\d{4})$/i);
  const month = words ? MONTHS.indexOf(words[2]!.slice(0, 3).toLowerCase()) + 1 : 0;
  return words && month ? `${words[3]}-${String(month).padStart(2, "0")}-${words[1]!.padStart(2, "0")}` : null;
}

const cleanName = (name: string) => name.replace(/™/g, "").replace(/\s*\(UKGC\)\s*$/, "").trim();

const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export function sourceGameFrom(r: RawFeedRecord): SourceGame {
  return SourceGame.parse({
    id: r.id,
    name: cleanName(r.name),
    supplierGameCode: r.supplier_code ?? null,
    studio: r.studio?.replace(/ Ltd$/, "") ?? null,
    supplyChannel: r.channel ? (/in-house|internal/i.test(r.channel) ? "in_house" : "aggregator") : null,
    familyId: r.family ?? null,
    familyRole: null,
    licensedIp: r.licensed_ip ?? null,
    brands: listOf(r.brands, brandOf),
    jurisdictions: listOf(r.markets, marketOf),
    status: r.status ? statusOf(r.status) : null,
    releaseDate: parseDate(r.release_date),
    rgFlags: listOf(r.rg_flags, (s) => (["may_appeal_to_under_18s", "do_not_promote", "high_intensity"].includes(s.trim()) ? s.trim() : null)),
    feedValues: defined({
      rtp: parseRtp(r.rtp),
      volatility: parseVolatility(r.volatility),
      maxWinMultiplier: parseMaxWin(r.max_win),
      ...parseStakes(r.stake_range),
      hitFrequency: parseHitFrequency(r.hit_freq),
    }),
  });
}

export function normalisedDocumentFrom(d: GameDocument): NormalisedDocument {
  const { text, ...meta } = d;
  return { ...meta, rawKey: `documents.json#${d.docId}`, text: normaliseDocument(text, d.format) };
}
