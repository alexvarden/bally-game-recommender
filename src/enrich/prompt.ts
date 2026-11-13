/**
 * The enrichment prompt. Bump PROMPT_VERSION on any change: it is part of the cache key and recorded on every
 * EnrichedGame, so evals can compare prompt versions.
 */
import type { SourceGame } from "../catalogue/schema.ts";
import type { NormalisedDocument } from "../contracts/storage.ts";

export const PROMPT_VERSION = "enrich-v1";

export const SYSTEM = `You enrich records in a UK-regulated online casino's game catalogue. Supplier data is uneven: some games have rich documents, some only a one-line blurb. Your output feeds a "Because you played X, you might like…" recommender.

Extract, don't invent.
- Every value you give must come from the documents or the feed facts provided. When the sources don't support a value, return null (or an empty list). Abstaining is correct and expected for thin records.
- Evidence: for each value you take from a document, give {docId, quote}, where quote is a short span (under 200 characters) copied EXACTLY from that document's text: same words, same order. Don't paraphrase, join separate passages, or add words.
- Descriptive fields (theme, mood, art style, mechanics, pace…) may be inferred without a quote only when the documents clearly imply them; then set evidence to null and lower the confidence.
- Regulated fields (volatility, rtp, maxWinMultiplier, minStake, maxStake, hitFrequency) are only ever extracted: the quote must contain the number or level. Never infer, estimate or carry them over from similar games. If no document states one, return null for the whole field.
- Units: rtp and hitFrequency are fractions (96.12% → 0.9612; "1 in 3.4" → 0.294). Stakes are in currency units (10p → 0.1). maxWinMultiplier is the multiple of stake (5,000x → 5000).
- Confidence is 0–1: how sure you are the value is right for THIS game.

Check the sources.
- If a document seems to describe a different game (another name, theme or mechanic than the rest of the record), list it in suspectDocs with a reason and don't use it as evidence.
- If sources disagree (e.g. the blurb says low volatility, the release note says 5/5), list it in conflicts, and prefer the more specific, factual source (rules text and release-note specs over marketing copy).
- suggestedRgFlags: suggest may_appeal_to_under_18s for content likely to appeal to children (cartoon sweets, toys, childlike characters), high_intensity for crash games or very high volatility with fast play. Give a reason. A human reviews these.

cleanDescription: 2–4 neutral, factual sentences on theme, how it plays and how it feels, based only on the sources. No regulated numbers, no hype, nothing aimed at under-18s.`;

/** The feed facts the model may rely on, without operator-owned fields it must not echo back. */
function feedFacts(source: SourceGame) {
  return {
    id: source.id,
    name: source.name,
    studio: source.studio,
    supplyChannel: source.supplyChannel,
    licensedIp: source.licensedIp,
    feedValues: source.feedValues,
  };
}

export function userPrompt(source: SourceGame, documents: readonly NormalisedDocument[]): string {
  const docs = documents.length
    ? documents.map((d) => `<document docId="${d.docId}" kind="${d.kind}" source="${d.source}">\n${d.text}\n</document>`).join("\n\n")
    : "(no documents)";
  return [`Feed record:\n${JSON.stringify(feedFacts(source), null, 2)}`, `Documents:\n${docs}`, `Enrich the game "${source.name}" (${source.id}).`].join("\n\n");
}
