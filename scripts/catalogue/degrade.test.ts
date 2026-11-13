import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mulberry32 } from "../../src/lib/random.ts";
import { RawFeedRecord } from "../../src/catalogue/schema.ts";
import { applyDocumentDefects, buildManifest, chooseRendering, degradeCatalogue, DocumentTruth, feedRecord, Manifest, noisyName, run, serialise } from "./degrade.ts";
import { GroundTruth, GROUND_TRUTH_PATH } from "./generate.ts";
import { Plan, PLAN_PATH } from "./plan.ts";

const truth = GroundTruth.parse(JSON.parse(readFileSync(GROUND_TRUTH_PATH, "utf8")));
const plan = Plan.parse(JSON.parse(readFileSync(PLAN_PATH, "utf8")));
const manifest = Manifest.parse(JSON.parse(readFileSync("data/catalogue/manifest.json", "utf8")));
const out = degradeCatalogue(truth, plan, manifest.degradeSeed);

const planOf = (id: string) => plan.games.find((p) => p.id === id)!;
const truthOf = (id: string) => truth.games.find((g) => g.id === id)!;
const withDefect = (d: string) => plan.games.filter((p) => p.defects.includes(d as never));

describe("degradeCatalogue", () => {
  it("reproduces the committed files byte for byte (golden)", () => {
    // If this fails, the order of random draws changed and the committed data no longer matches its seed.
    expect(buildManifest(out, serialise(out), truth, plan, manifest.degradeSeed).files).toEqual(manifest.files);
  });

  it("adds a duplicate listing per planned duplicate, mapped back to the original", () => {
    expect(out.feed).toHaveLength(truth.games.length + withDefect("duplicate_listing").length);
    for (const [dupId, originalId] of Object.entries(out.duplicates)) {
      expect(out.feed.find((r) => r.id === dupId)!.supplier_code).toBe(out.feed.find((r) => r.id === originalId)!.supplier_code);
    }
  });

  it("produces a truth record for every document", () => {
    expect(out.docTruth.map((t) => t.docId)).toEqual(out.docs.map((d) => d.docId));
    out.docTruth.forEach((t) => DocumentTruth.parse(t));
  });
});

describe("feedRecord", () => {
  it("gives thin records only identity and operator fields", () => {
    for (const p of withDefect("thin_record")) {
      const keys = Object.keys(feedRecord(truthOf(p.id), p, mulberry32(1)));
      expect(keys.every((k) => ["id", "name", "supplier_code", "studio", "brands", "markets", "status", "release_date"].includes(k))).toBe(true);
    }
  });

  it("always includes operator-owned fields", () => {
    for (const r of out.feed) expect(r).toMatchObject({ brands: expect.any(String), markets: expect.any(String), status: expect.any(String) });
  });

  it("applies feed-level defects", () => {
    const record = (id: string, seed = 1) => feedRecord(truthOf(id), planOf(id), mulberry32(seed));
    for (const p of withDefect("theme_only_in_prose")) expect(record(p.id).theme).toBeUndefined();
    for (const p of withDefect("volatility_conflict")) expect(record(p.id).volatility).toBeUndefined();
    for (const p of withDefect("rg_sensitive_thin")) expect(record(p.id).rg_flags).toBeUndefined();
  });

  it("drops the core mechanic from the feature list when the feed omits it", () => {
    const p = withDefect("feed_omits_feature")[0]!;
    const g = truthOf(p.id);
    for (let seed = 0; seed < 30; seed++) {
      const features = feedRecord(g, p, mulberry32(seed)).features;
      if (features) expect(features.toLowerCase()).not.toContain(g.coreMechanic.replace(/_/g, " "));
    }
  });

  it("varies RTP formats across aggregator records", () => {
    const rtps = new Set(out.feed.map((r) => typeof r.rtp + (String(r.rtp).includes("%") ? "%" : String(r.rtp).includes(",") ? "," : "")));
    expect(rtps.size).toBeGreaterThanOrEqual(3);
    out.feed.forEach((r) => RawFeedRecord.parse(r));
  });

  it("mangles aggregator names but never in-house ones", () => {
    expect(noisyName("Pharaoh", true, () => 0)).toBe("Pharaoh");
    expect(noisyName("Pharaoh", false, () => 0)).toBe("PHARAOH");
  });
});

describe("document defects", () => {
  it("swaps in another game's rules for wrong_game_rules and records which game they describe", () => {
    const p = withDefect("wrong_game_rules")[0]!;
    const doc = truth.documents.find((d) => d.gameId === p.id && d.kind === "rules_text")!;
    const result = applyDocumentDefects(doc, truthOf(p.id), p, truth.documents);
    expect(result.describesGameId).toBe(p.relatedGameId);
    expect(result.clean.title).toBe(truthOf(p.id).name);
    expect(out.docTruth.find((t) => t.docId === doc.docId)!.survivingFacts).toEqual([]);
  });

  it("adds a misleading volatility claim to the blurb and the true value to the release note", () => {
    const p = withDefect("volatility_conflict")[0]!;
    const blurb = truth.documents.find((d) => d.gameId === p.id && d.kind === "marketing_blurb")!;
    const note = truth.documents.find((d) => d.gameId === p.id && d.kind === "release_note")!;
    expect(applyDocumentDefects(blurb, truthOf(p.id), p, truth.documents).misleadingFacts).toEqual(["volatility"]);
    expect(applyDocumentDefects(note, truthOf(p.id), p, truth.documents).clean.sections.some((s) => s.tags.includes("volatility"))).toBe(true);
  });

  it("chooses plausible formats and truncates only planned rules", () => {
    const r = chooseRendering(mulberry32(1), "release_note", "aggregator", []);
    expect(["email", "markdown"]).toContain(r.format);
    expect(chooseRendering(mulberry32(1), "rules_text", "in_house", ["truncated_rules"]).damage).toContain("truncate");
    expect(chooseRendering(mulberry32(1), "marketing_blurb", "in_house", ["truncated_rules"]).damage).not.toContain("truncate");
  });
});

describe("run", () => {
  it("writes all four files and a matching manifest", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const outDir = mkdtempSync(join(tmpdir(), "degrade-"));
    const written = run(["--seed", String(manifest.degradeSeed)], { truth: GROUND_TRUTH_PATH, plan: PLAN_PATH, outDir });
    expect(written.files).toEqual(manifest.files);
    expect(Manifest.parse(JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"))).counts).toEqual(manifest.counts);
  });
});
