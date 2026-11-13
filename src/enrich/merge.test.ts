import { describe, expect, it } from "vitest";
import { EnrichedGame } from "../catalogue/schema.ts";
import { mergeEnrichment } from "./merge.ts";
import { documents, llmResponse, quote, source } from "./testing.ts";

const meta = { sourceHash: "h", promptVersion: "p", model: "m", enrichedAt: "2026-11-13T00:00:00.000Z" };
const merge = (llm = llmResponse(), feed = {}, overrides = {}) => mergeEnrichment({ source: source(feed), documents, llm, overrides, meta });

describe("provenance precedence", () => {
  const llm = llmResponse({ descriptive: { mood: { value: "epic", evidence: quote("rules", "A Norse winter slot"), confidence: 0.8 } } });

  it("operator override beats feed beats extracted beats inferred beats unknown", () => {
    expect(merge(llm, { mood: "cosy" }, { mood: "spooky" }).game.fields.mood).toMatchObject({ value: "spooky", provenance: "operator", confidence: 1 });
    expect(merge(llm, { mood: "cosy" }).game.fields.mood).toMatchObject({ value: "cosy", provenance: "feed" });
    expect(merge(llm).game.fields.mood).toMatchObject({ value: "epic", provenance: "extracted", evidence: { docId: "rules" } });
    const inferred = llmResponse({ descriptive: { pace: { value: "steady", evidence: null, confidence: 0.6 } } });
    expect(merge(inferred).game.fields.pace).toMatchObject({ value: "steady", provenance: "inferred", confidence: 0.6 });
    expect(merge().game.fields.pace).toEqual({ value: null, provenance: "unknown", evidence: null, confidence: 0 });
  });

  it("treats empty lists as absent, so an empty feed list doesn't hide an extraction", () => {
    const features = llmResponse({ descriptive: { secondaryFeatures: { value: ["free_spins"], evidence: null, confidence: 0.5 } } });
    expect(merge(features, { secondaryFeatures: [] }).game.fields.secondaryFeatures.provenance).toBe("inferred");
  });

  it("produces a schema-valid EnrichedGame that drops feedValues", () => {
    const { game } = merge(llm);
    expect(EnrichedGame.parse(game)).toBeTruthy();
    expect(game).not.toHaveProperty("feedValues");
    expect(game.description).toContain("Norse");
  });
});

describe("evidence verification", () => {
  it("accepts a regulated value only when the quote is in the doc and states it", () => {
    const ok = llmResponse({ regulated: { rtp: { value: 0.9612, evidence: quote("rules", "The theoretical RTP of this game is 96.12%."), confidence: 1 } } });
    expect(merge(ok).game.fields.rtp).toMatchObject({ value: 0.9612, provenance: "extracted" });
    expect(merge(ok).game.rejected).toEqual([]);
  });

  it("rejects a regulated value whose quote doesn't state it, and leaves the field unknown", () => {
    const wrong = llmResponse({ regulated: { rtp: { value: 0.97, evidence: quote("rules", "The theoretical RTP of this game is 96.12%."), confidence: 1 } } });
    const { game } = merge(wrong);
    expect(game.fields.rtp.provenance).toBe("unknown");
    expect(game.rejected).toEqual([{ field: "rtp", docId: "rules", quote: "The theoretical RTP of this game is 96.12%.", reason: "value_not_in_quote" }]);
  });

  it("rejects an invented quote: regulated fields drop, descriptive fields are demoted to inferred at half confidence", () => {
    const invented = llmResponse({
      regulated: { maxWinMultiplier: { value: 5000, evidence: quote("rules", "Win up to 5,000x your stake"), confidence: 0.9 } },
      descriptive: { mood: { value: "epic", evidence: quote("rules", "an epic adventure"), confidence: 0.8 } },
    });
    const { game } = merge(invented);
    expect(game.fields.maxWinMultiplier.provenance).toBe("unknown");
    expect(game.fields.mood).toMatchObject({ value: "epic", provenance: "inferred", confidence: 0.4 });
    expect(game.rejected.map((r) => r.reason)).toEqual(["quote_not_found", "quote_not_found"]);
  });

  it("ignores evidence from documents the model marked as describing another game", () => {
    const suspect = llmResponse({
      suspectDocs: [{ docId: "blurb", reason: "describes a pirate game" }],
      descriptive: { primaryTheme: { value: "adventure_exploration", evidence: quote("blurb", "Big pirate wins on the high seas!"), confidence: 0.7 } },
    });
    const { game } = merge(suspect);
    expect(game.fields.primaryTheme.provenance).toBe("unknown");
    expect(game.rejected[0]!.reason).toBe("suspect_doc");
  });
});

describe("regulated conflicts and quarantine", () => {
  const extractedRtp = llmResponse({ regulated: { rtp: { value: 0.9612, evidence: quote("rules", "RTP of this game is 96.12%"), confidence: 1 } } });

  it("keeps the feed value and signals quarantine when a verified document disagrees", () => {
    const { game, quarantine } = merge(extractedRtp, { rtp: 0.955 });
    expect(game.fields.rtp).toMatchObject({ value: 0.955, provenance: "feed" });
    expect(quarantine).toBe("rtp: feed 0.955 vs rules 0.9612");
    expect(game.conflicts).toContainEqual({ field: "rtp", docIds: ["rules"], detail: "feed 0.955 vs document 0.9612" });
  });

  it("doesn't quarantine when they agree, or when the disagreeing claim fails verification", () => {
    expect(merge(extractedRtp, { rtp: 0.9612 }).quarantine).toBeNull();
    const unverified = llmResponse({ regulated: { rtp: { value: 0.975, evidence: quote("blurb", "RTP 97.50%"), confidence: 1 } }, suspectDocs: [{ docId: "blurb", reason: "x" }] });
    expect(merge(unverified, { rtp: 0.9612 }).quarantine).toBeNull();
  });

  it("passes the model's own conflicts and RG suggestions through for review", () => {
    const llm = llmResponse({
      conflicts: [{ field: "volatility", docIds: ["blurb", "rules"], detail: "blurb says low" }],
      suggestedRgFlags: [{ flag: "high_intensity", reason: "very high volatility" }],
    });
    const { game } = merge(llm);
    expect(game.conflicts[0]!.detail).toBe("blurb says low");
    expect(game.suggestedRgFlags[0]!.flag).toBe("high_intensity");
  });
});
