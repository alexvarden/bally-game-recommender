/**
 * Evidence verification: the code-side check on every claim the enrichment LLM makes.
 *
 * A quote must appear in the cited document's normalised text. For regulated facts the quote must also state the
 * claimed value, in any of the forms suppliers write it ("96.12%", "5,000x", "£0.10", "10p", "1 in 3.4", "4/5").
 */
import type { z } from "zod";
import type { Evidence, RejectedEvidence, Volatility } from "../catalogue/schema.ts";
import { matchKey } from "../text/normalise.ts";

export type RejectionReason = z.infer<typeof RejectedEvidence>["reason"];

export function quoteFound(quote: string, docText: string): boolean {
  const q = matchKey(quote);
  return q.length >= 3 && matchKey(docText).includes(q);
}

// ---------- Numbers in quotes ----------

const toNumber = (s: string) => Number(s.replace(/,(?=\d{3}\b)/g, "").replace(",", "."));

/** Percentages, e.g. "96.12%", "96,12 %". */
export const percentagesIn = (quote: string) => [...quote.matchAll(/(\d{1,3}(?:[.,]\d+)?)\s?%/g)].map((m) => toNumber(m[1]!) / 100);

/** Multipliers, e.g. "5,000x", "x5000", "5000 x stake", "5,000×". */
export function multipliersIn(quote: string): number[] {
  const after = [...quote.matchAll(/(\d[\d,]*(?:\.\d+)?)\s?[x×]/gi)].map((m) => toNumber(m[1]!));
  const before = [...quote.matchAll(/[x×]\s?(\d[\d,]*(?:\.\d+)?)/gi)].map((m) => toNumber(m[1]!));
  return [...after, ...before];
}

/** Money amounts, e.g. "£0.10", "$5", "10p", "0.10 GBP". */
export function amountsIn(quote: string): number[] {
  const symbol = [...quote.matchAll(/[£$€]\s?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => toNumber(m[1]!));
  const pence = [...quote.matchAll(/\b(\d{1,2})p\b/g)].map((m) => Number(m[1]) / 100);
  const coded = [...quote.matchAll(/(\d[\d,]*(?:\.\d+)?)\s?(?:GBP|USD|EUR)\b/g)].map((m) => toNumber(m[1]!));
  return [...symbol, ...pence, ...coded];
}

/** Hit frequencies as fractions, from "1 in 3.4", "1:3.4" or "29.4%". */
export function frequenciesIn(quote: string): number[] {
  const ratios = [...quote.matchAll(/1\s?(?:in|:)\s?(\d+(?:\.\d+)?)/gi)].map((m) => 1 / Number(m[1]));
  return [...ratios, ...percentagesIn(quote)];
}

// ---------- Volatility words ----------

/** Checked in order, so "very high" wins over "high" and "5/5" over nothing. */
const VOLATILITY_PATTERNS: [z.infer<typeof Volatility>, RegExp][] = [
  ["very_high", /\b(very[\s-]?high|v\.\s?high|extreme|5\/5)\b/i],
  ["medium", /\b(med(ium)?|3\/5)\b(?![\s-]*high)/i],
  ["high", /\b(high|4\/5)\b/i],
  ["low", /\b(low|[12]\/5)\b/i],
];

/** The single volatility level a quote states, or null when it states none or is ambiguous ("med-high"). */
export function volatilityIn(quote: string): z.infer<typeof Volatility> | null {
  if (/med(ium)?[\s-]+high/i.test(quote)) return null;
  return VOLATILITY_PATTERNS.find(([, p]) => p.test(quote))?.[0] ?? null;
}

// ---------- Value-in-quote table ----------

const near = (tolerance: number) => (claimed: number) => (found: number) => Math.abs(found - claimed) <= tolerance;

type RegulatedField = "volatility" | "rtp" | "maxWinMultiplier" | "minStake" | "maxStake" | "hitFrequency";

/** For each regulated field: does the quote state this value? */
const VALUE_CHECKS: Record<RegulatedField, (value: unknown, quote: string) => boolean> = {
  volatility: (v, q) => volatilityIn(q) === v,
  rtp: (v, q) => percentagesIn(q).some(near(0.00005)(v as number)),
  maxWinMultiplier: (v, q) => multipliersIn(q).some(near(0.5)(v as number)),
  minStake: (v, q) => amountsIn(q).some(near(0.001)(v as number)),
  maxStake: (v, q) => amountsIn(q).some(near(0.001)(v as number)),
  hitFrequency: (v, q) => frequenciesIn(q).some(near(0.005)(v as number)),
};

export const isRegulatedField = (field: string): field is RegulatedField => field in VALUE_CHECKS;

export interface DocView {
  docId: string;
  text: string;
}

/**
 * Why a piece of evidence must be rejected, or null if it holds up. Checks run cheapest first: the doc exists and
 * isn't suspect, the quote is really in it, and (for regulated fields) the quote states the claimed value.
 */
export function rejectionFor(field: string, value: unknown, evidence: z.infer<typeof Evidence>, docs: ReadonlyMap<string, DocView>, suspect: ReadonlySet<string>): RejectionReason | null {
  if (suspect.has(evidence.docId)) return "suspect_doc";
  const doc = docs.get(evidence.docId);
  if (!doc || !quoteFound(evidence.quote, doc.text)) return "quote_not_found";
  if (isRegulatedField(field) && !VALUE_CHECKS[field](value, evidence.quote)) return "value_not_in_quote";
  return null;
}
