/**
 * Synthetic enrichment outputs for calibrating the scorer, not for reporting quality.
 *
 *   idealEnrichment  what a perfect pipeline would produce: truth where a source states it, abstention where none
 *                    does, every planted defect detected. Should pass every gate.
 *   corruptEnrichment  the ideal output with realistic mistakes injected. Should fail the right gates.
 */
import type { z } from "zod";
import { REGULATED_FIELDS, type EnrichedGame, type ExtractableField, type Volatility } from "../../src/catalogue/schema.ts";
import { enrichedFromTruth } from "../../src/testing/fixtures.ts";
import { mulberry32, pick } from "../../src/lib/random.ts";
import { availableFacts, type ReferenceData } from "../lib/data.ts";
import { INFERABLE_FIELDS, STRUCTURAL_FIELDS } from "./score.ts";

type Resolved = EnrichedGame["fields"][keyof EnrichedGame["fields"]];
type Fields = Record<string, Resolved>;

const sourceDocFor = (gameId: string, field: ExtractableField, ref: ReferenceData) =>
  ref.docTruth.find((d) => d.gameId === gameId && d.survivingFacts.includes(field))?.docId ?? null;

function idealField(gameId: string, field: ExtractableField, value: unknown, ref: ReferenceData, avail: Set<ExtractableField>): Resolved {
  const docId = sourceDocFor(gameId, field, ref);
  if (docId) return { value, provenance: "extracted", evidence: { docId, quote: `(quote for ${field})` }, confidence: 0.9 } as Resolved;
  if (avail.has(field)) return { value, provenance: "feed", evidence: null, confidence: 1 } as Resolved;
  if ((INFERABLE_FIELDS as readonly string[]).includes(field)) return { value, provenance: "inferred", evidence: null, confidence: 0.6 } as Resolved;
  return { value: null, provenance: "unknown", evidence: null, confidence: 0 } as Resolved;
}

function idealGame(base: EnrichedGame, ref: ReferenceData): EnrichedGame {
  const { available } = availableFacts(base.id, ref);
  const fields: Fields = {};
  for (const [k, r] of Object.entries(base.fields as Fields)) fields[k] = idealField(base.id, k as ExtractableField, r.value, ref, available);
  const defects = ref.plans.get(base.id)?.defects ?? [];
  const rulesDoc = `${base.id}-rules_text`;
  // Operator-owned flags come from the feed, which omits them on rg-sensitive games; enrichment must suggest them.
  const feedFlags = ref.feed.get(base.id)?.rg_flags?.split(",").filter(Boolean) ?? [];
  return {
    ...base,
    rgFlags: feedFlags as EnrichedGame["rgFlags"],
    fields: fields as EnrichedGame["fields"],
    conflicts: defects.includes("volatility_conflict") ? [{ field: "volatility", docIds: [`${base.id}-marketing_blurb`, `${base.id}-release_note`], detail: "blurb claims low volatility" }] : [],
    rejected: defects.includes("wrong_game_rules") ? [{ field: "coreMechanic", docId: rulesDoc, quote: "(rules for another game)", reason: "suspect_doc" }] : [],
    suggestedRgFlags: defects.includes("rg_sensitive_thin") ? [{ flag: "may_appeal_to_under_18s", reason: "cartoon animals theme" }] : [],
  };
}

export function idealEnrichment(ref: ReferenceData): EnrichedGame[] {
  return [...ref.truth.values()].map((t) => idealGame(enrichedFromTruth(t), ref));
}

const VOLATILITIES: z.infer<typeof Volatility>[] = ["low", "medium", "high", "very_high"];

/** Injects the mistakes we expect from a weak model: wrong labels, an inferred RTP, trusting the misleading blurb. */
export function corruptEnrichment(ideal: EnrichedGame[], ref: ReferenceData, seed = 1): EnrichedGame[] {
  const rng = mulberry32(seed);
  return ideal.map((g, i) => {
    const fields = structuredClone(g.fields) as Fields;
    if (i % 4 === 0) fields.mood = { ...fields.mood!, value: pick(rng, ["cosy", "epic", "spooky", "retro"]) };
    if (i % 5 === 0) fields.primaryTheme = { ...fields.primaryTheme!, value: "fruit_classic" };
    if (i % 10 === 0) fields.rtp = { value: 0.96, provenance: "inferred", evidence: null, confidence: 0.4 };
    if (i % 7 === 0) fields.paylines = { value: 20, provenance: "inferred", evidence: null, confidence: 0.3 };
    const conflict = ref.plans.get(g.id)?.defects.includes("volatility_conflict");
    if (conflict) fields.volatility = { value: pick(rng, VOLATILITIES.filter((v) => v !== g.fields.volatility.value)), provenance: "extracted", evidence: { docId: `${g.id}-marketing_blurb`, quote: "low volatility" }, confidence: 0.7 };
    return { ...g, fields: fields as EnrichedGame["fields"], conflicts: [], rejected: g.rejected.slice(0, 0), suggestedRgFlags: i % 2 ? g.suggestedRgFlags : [] };
  });
}

export const EVIDENCE_REQUIRED = [...REGULATED_FIELDS, ...STRUCTURAL_FIELDS];
