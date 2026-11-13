/**
 * Merges the feed, operator overrides and verified LLM output into an EnrichedGame with per-field provenance.
 *
 * Precedence: operator override > feed > extracted (verified quote) > inferred (no quote) > unknown.
 * Regulated fields are never inferred. A regulated value that the feed and a verified document disagree on is a
 * conflict: the feed value stands, and the game is flagged for quarantine until a human resolves it.
 */
import type { z } from "zod";
import { LlmEnrichment, type DescriptiveOverrides, type EnrichedGame, type Evidence, type RejectedEvidence, type SourceGame } from "../catalogue/schema.ts";
import type { NormalisedDocument } from "../contracts/storage.ts";
import { isRegulatedField, rejectionFor, type DocView, type RejectionReason } from "./evidence.ts";

type Fields = EnrichedGame["fields"];
type FieldName = keyof Fields;
type Resolved = Fields[FieldName];
type LlmClaim = { value: unknown; evidence: z.infer<typeof Evidence> | null; confidence: number } | null;
type Rejection = z.infer<typeof RejectedEvidence>;

const DESCRIPTIVE = Object.keys(LlmEnrichment.shape.descriptive.shape) as FieldName[];
const STRUCTURAL = Object.keys(LlmEnrichment.shape.structural.shape) as FieldName[];
const REGULATED = Object.keys(LlmEnrichment.shape.regulated.shape) as FieldName[];
export const ALL_FIELDS: FieldName[] = [...DESCRIPTIVE, ...STRUCTURAL, ...REGULATED];

const UNKNOWN: Resolved = { value: null, provenance: "unknown", evidence: null, confidence: 0 };

/** What happens to an LLM claim whose evidence fails, by reason. Paraphrased descriptive quotes keep half credit. */
const ON_REJECTION: Record<RejectionReason, "drop" | "demote"> = {
  suspect_doc: "drop",
  quote_not_found: "demote",
  value_not_in_quote: "drop",
  regulated_without_evidence: "drop",
};

export function llmClaims(llm: LlmEnrichment): Record<FieldName, LlmClaim> {
  return { ...llm.descriptive, ...llm.structural, ...llm.regulated } as Record<FieldName, LlmClaim>;
}

const isPresent = (v: unknown) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);

interface ResolveContext {
  docs: ReadonlyMap<string, DocView>;
  suspect: ReadonlySet<string>;
  rejected: Rejection[];
}

/** The verified form of one LLM claim: extracted, inferred, or nothing (with the rejection recorded). */
function fromClaim(field: FieldName, claim: LlmClaim, ctx: ResolveContext): Resolved | null {
  if (!claim || !isPresent(claim.value)) return null;
  const regulated = isRegulatedField(field);
  if (!claim.evidence) {
    if (!regulated) return { value: claim.value, provenance: "inferred", evidence: null, confidence: claim.confidence } as Resolved;
    ctx.rejected.push({ field, docId: "", quote: "", reason: "regulated_without_evidence" });
    return null;
  }
  const reason = rejectionFor(field, claim.value, claim.evidence, ctx.docs, ctx.suspect);
  if (!reason) return { value: claim.value, provenance: "extracted", evidence: claim.evidence, confidence: claim.confidence } as Resolved;
  ctx.rejected.push({ field, docId: claim.evidence.docId, quote: claim.evidence.quote, reason });
  if (regulated || ON_REJECTION[reason] === "drop") return null;
  return { value: claim.value, provenance: "inferred", evidence: null, confidence: claim.confidence * 0.5 } as Resolved;
}

export function resolveField(field: FieldName, source: SourceGame, overrides: DescriptiveOverrides, claim: LlmClaim, ctx: ResolveContext): Resolved {
  const override = (overrides as Record<string, unknown>)[field];
  if (isPresent(override)) return { value: override, provenance: "operator", evidence: null, confidence: 1 } as Resolved;
  const verified = fromClaim(field, claim, ctx);
  const feed = (source.feedValues as Record<string, unknown>)[field];
  if (isPresent(feed)) return { value: feed, provenance: "feed", evidence: null, confidence: 1 } as Resolved;
  return verified ?? UNKNOWN;
}

// ---------- Regulated conflicts ----------

const sameValue = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-4 : a === b);

export interface RegulatedConflict {
  field: FieldName;
  feed: unknown;
  document: unknown;
  docId: string;
}

/** Regulated fields where the feed and a verified document quote disagree. Unverified claims never count. */
export function regulatedConflicts(source: SourceGame, claims: Record<FieldName, LlmClaim>, ctx: Omit<ResolveContext, "rejected">): RegulatedConflict[] {
  return REGULATED.flatMap((field) => {
    const feed = (source.feedValues as Record<string, unknown>)[field];
    const claim = claims[field];
    if (!isPresent(feed) || !claim?.evidence || sameValue(feed, claim.value)) return [];
    if (rejectionFor(field, claim.value, claim.evidence, ctx.docs, ctx.suspect)) return [];
    return [{ field, feed, document: claim.value, docId: claim.evidence.docId }];
  });
}

export const quarantineReason = (conflicts: RegulatedConflict[]) =>
  conflicts.length === 0 ? null : conflicts.map((c) => `${c.field}: feed ${c.feed} vs ${c.docId} ${c.document}`).join("; ");

// ---------- Assembly ----------

export interface MergeInput {
  source: SourceGame;
  documents: NormalisedDocument[];
  llm: LlmEnrichment;
  overrides: DescriptiveOverrides;
  meta: EnrichedGame["meta"];
}

export interface MergeResult {
  game: EnrichedGame;
  /** Non-null when a regulated conflict means the game must be quarantined. */
  quarantine: string | null;
}

export function mergeEnrichment({ source, documents, llm, overrides, meta }: MergeInput): MergeResult {
  const docs = new Map(documents.map((d) => [d.docId, { docId: d.docId, text: d.text }]));
  const suspect = new Set(llm.suspectDocs.map((s) => s.docId));
  const ctx: ResolveContext = { docs, suspect, rejected: [] };
  const claims = llmClaims(llm);
  const fields = Object.fromEntries(ALL_FIELDS.map((f) => [f, resolveField(f, source, overrides, claims[f], ctx)])) as Fields;
  const conflicts = regulatedConflicts(source, claims, ctx);

  const { feedValues: _feedValues, ...identity } = source;
  const game: EnrichedGame = {
    ...identity,
    description: llm.cleanDescription,
    fields,
    suggestedRgFlags: llm.suggestedRgFlags,
    conflicts: [...llm.conflicts, ...conflicts.map((c) => ({ field: c.field, docIds: [c.docId], detail: `feed ${c.feed} vs document ${c.document}` }))],
    rejected: ctx.rejected,
    meta,
  };
  return { game, quarantine: quarantineReason(conflicts) };
}
