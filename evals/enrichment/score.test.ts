import { describe, expect, it } from "vitest";
import type { EnrichedGame } from "../../src/catalogue/schema.ts";
import { releasable } from "../gates.ts";
import { availableFacts, loadReference } from "../lib/data.ts";
import { jaccard, matches, regulatedViolations, scoreEnrichment } from "./score.ts";
import { corruptEnrichment, idealEnrichment } from "./synthetic.ts";

const ref = loadReference();
const ideal = idealEnrichment(ref);
type Resolved = EnrichedGame["fields"]["rtp"];

describe("matches", () => {
  it("compares numbers with tolerance, sets by Jaccard, objects by value", () => {
    expect(matches(0.96120001, 0.9612)).toBe(true);
    expect(matches(0.96, 0.9612)).toBe(false);
    expect(matches(["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(matches(["a"], ["b", "c"])).toBe(false);
    expect(matches({ reels: 5, rows: 3 }, { reels: 5, rows: 3 })).toBe(true);
    expect(matches(null, null)).toBe(true);
    expect(matches(null, "x")).toBe(false);
    expect(jaccard([], [])).toBe(1);
  });
});

describe("regulatedViolations", () => {
  const truth = ref.truth.get("BLY-SLT-0001")!;
  const base = ideal.find((g) => g.id === truth.id)!;
  const withRtp = (r: Resolved) => ({ ...base, fields: { ...base.fields, rtp: r } });
  const all = availableFacts(truth.id, ref).available;
  const noRtp = new Set([...all].filter((f) => f !== "rtp"));
  const rtpOnly = (v: ReturnType<typeof regulatedViolations>) => v.filter((x) => x.detail.startsWith("rtp"));

  it.each([
    ["a wrong value", { value: 0.9, provenance: "extracted", evidence: { docId: "d", quote: "90%" }, confidence: 1 }, "regulated_wrong"],
    ["an inferred value", { value: truth.rtp, provenance: "inferred", evidence: null, confidence: 1 }, "regulated_unevidenced"],
    ["an extraction with no quote", { value: truth.rtp, provenance: "extracted", evidence: null, confidence: 1 }, "regulated_unevidenced"],
  ])("flags %s", (_, r, kind) => {
    expect(rtpOnly(regulatedViolations(withRtp(r as Resolved), truth, all))[0]!.kind).toBe(kind);
  });

  it("flags a correct value that no source states, unless an operator set it", () => {
    const fromFeed = { value: truth.rtp, provenance: "feed", evidence: null, confidence: 1 } as Resolved;
    expect(rtpOnly(regulatedViolations(withRtp(fromFeed), truth, noRtp))[0]!.kind).toBe("regulated_invented");
    expect(rtpOnly(regulatedViolations(withRtp({ ...fromFeed, provenance: "operator" }), truth, noRtp))).toEqual([]);
  });
});

describe("availableFacts", () => {
  it("drops the core mechanic from the feed when the feed omits it, and excludes truncated facts", () => {
    const omitted = [...ref.plans.values()].find((p) => p.defects.includes("feed_omits_feature"))!;
    const feedOnly = { ...ref, docTruth: [] };
    expect(availableFacts(omitted.id, feedOnly).available.has("coreMechanic")).toBe(false);
    const truncated = ref.docTruth.find((d) => d.partialFacts.length > 0)!;
    const avail = availableFacts(truncated.gameId, ref);
    for (const f of truncated.partialFacts) expect(avail.available.has(f) || avail.partial.has(f)).toBe(true);
  });
});

describe("scoreEnrichment", () => {
  it("scores the ideal output perfectly and passes every gate (calibration)", () => {
    const s = scoreEnrichment(ideal, ref);
    expect(s.accuracy).toBe(1);
    expect(s.abstentionRate).toBe(1);
    expect(s.regulatedViolations).toEqual([]);
    expect(Object.values(s.defects).every((d) => d.recall === 1)).toBe(true);
    expect(s.gates.every((g) => g.pass)).toBe(true);
  });

  it("catches injected mistakes and blocks release", () => {
    const s = scoreEnrichment(corruptEnrichment(ideal, ref), ref);
    expect(s.regulatedViolations.length).toBeGreaterThan(0);
    expect(s.defects.volatility_conflict!.recall).toBe(0);
    expect(s.defects.wrong_game_rules!.recall).toBe(0);
    expect(s.failures.some((f) => f.kind === "field_wrong")).toBe(true);
    expect(releasable(s.gates)).toBe(false);
  });

  it("reports games missing from the output and doesn't count them", () => {
    const s = scoreEnrichment(ideal.slice(1), ref);
    expect(s.missingGames).toEqual([ideal[0]!.id]);
    expect(s.games).toBe(99);
  });

  it("counts a wrong-game rules doc as missed if its evidence was used anyway", () => {
    const id = [...ref.plans.values()].find((p) => p.defects.includes("wrong_game_rules"))!.id;
    const misused = ideal.map((g) =>
      g.id === id ? { ...g, fields: { ...g.fields, rtp: { value: g.fields.rtp.value, provenance: "extracted" as const, evidence: { docId: `${id}-rules_text`, quote: "x" }, confidence: 1 } } } : g,
    );
    expect(scoreEnrichment(misused, ref).defects.wrong_game_rules!.misses).toContain(id);
  });

  it("counts volatility conflicts flagged on games without one as false flags", () => {
    const flagged = ideal.map((g, i) => (i === 0 ? { ...g, conflicts: [{ field: "volatility" as const, docIds: [], detail: "" }] } : g));
    expect(scoreEnrichment(flagged, ref).volatilityFalseFlags).toBe(1);
  });
});
