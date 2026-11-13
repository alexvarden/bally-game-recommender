import { describe, expect, it } from "vitest";
import { EnrichedGame, ExtractableField, LlmEnrichment, REGULATED_FIELDS } from "./schema.ts";

/** These tests pin the trust rules: they fail if someone widens what the LLM is allowed to write. */
describe("trust tiers", () => {
  it("the LLM output schema has no operator-owned fields", () => {
    const keys = JSON.stringify(Object.keys(LlmEnrichment.shape)) + JSON.stringify(Object.keys(LlmEnrichment.shape.descriptive.shape));
    for (const operatorField of ["brands", "jurisdictions", "status", "rgFlags", "releaseDate"]) expect(keys).not.toContain(`"${operatorField}"`);
  });

  it("regulated facts can only be returned with evidence", () => {
    const rtp = LlmEnrichment.shape.regulated.shape.rtp;
    expect(rtp.safeParse({ value: 0.96, evidence: null, confidence: 1 }).success).toBe(false);
    expect(rtp.safeParse({ value: 0.96, evidence: { docId: "d", quote: "RTP is 96.00%" }, confidence: 1 }).success).toBe(true);
    expect(rtp.safeParse(null).success).toBe(true);
  });

  it("every regulated field is extractable and resolved with provenance", () => {
    for (const f of REGULATED_FIELDS) {
      expect(ExtractableField.options).toContain(f);
      expect(Object.keys(EnrichedGame.shape.fields.shape)).toContain(f);
    }
  });
});
