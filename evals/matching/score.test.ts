import { describe, expect, it } from "vitest";
import type { Ranker } from "../../src/contracts/ranking.ts";
import { groundTruthAsEnriched, operatorStateFrom } from "../../src/testing/fixtures.ts";
import { releasable } from "../gates.ts";
import { loadReference } from "../lib/data.ts";
import { candidatesFor, metadataRanker, metadataScore, randomRanker, silverOracle } from "./baselines.ts";
import { labelProblems, loadLabels } from "./labels.ts";
import { eligibleFor, ndcg, precisionAtK, requestsFor, scoreRanker, violationsFor, type MatchingContext } from "./score.ts";
import { affinity, silverGrade } from "./silver.ts";

const ref = loadReference();
const labels = loadLabels();
const key = groundTruthAsEnriched();
const operator = new Map([...ref.truth.values()].map((g) => [g.id, operatorStateFrom(g)]));
const ctx: MatchingContext = { truth: ref.truth, operator, duplicates: ref.duplicates, labels, k: 5, maxVolatilityStepUp: 1 };
const t = (id: string) => ref.truth.get(id)!;

/** A ranker that returns fixed ids, for checking the scorer. */
const fixed = (ids: string[], reason: "below_floor" | null = null): Ranker => ({ rank: () => ({ items: ids.map((gameId) => ({ gameId, score: 1 })), reason }) });

describe("metrics", () => {
  it("nDCG is 1 for the ideal order, lower otherwise, and 1 when nothing is relevant", () => {
    expect(ndcg([3, 2, 1], [1, 2, 3], 5)).toBe(1);
    expect(ndcg([1, 2, 3], [3, 2, 1], 5)).toBeLessThan(1);
    expect(ndcg([], [0, 0], 5)).toBe(1);
  });

  it("precision@k counts grade ≥ 2 and treats empty slots as misses", () => {
    expect(precisionAtK([3, 2, 1], 5)).toBe(0.4);
  });
});

describe("silver labels", () => {
  it("grade a sibling highly, an unrelated game low, and the seed itself 0", () => {
    expect(silverGrade(t("BLY-SLT-0013"), t("BLY-SLT-0014"))).toBe(3);
    expect(silverGrade(t("BLY-SLT-0013"), t("BLY-BIN-0068"))).toBe(0);
    expect(silverGrade(t("BLY-SLT-0013"), t("BLY-SLT-0013"))).toBe(0);
    expect(affinity(t("BLY-SLT-0013"), t("BLY-SLT-0056"))).toBeGreaterThan(affinity(t("BLY-SLT-0013"), t("BLY-SLT-0003")));
  });
});

describe("hand labels", () => {
  it("reference real games and don't contradict themselves", () => {
    expect(labelProblems(labels, new Set([...ref.truth.keys(), ...Object.keys(ref.duplicates)]))).toEqual([]);
    expect(labels.seeds).toHaveLength(10);
  });

  it("flag unknown ids, contradictions and self-relevance", () => {
    const bad = { about: "", seeds: [{ seedId: "A", why: "", relevant: [{ gameId: "A", grade: 1, rationale: "itself" }, { gameId: "X", grade: 1, rationale: "unknown" }], mustNot: [{ gameId: "X", rationale: "contradiction" }] }] };
    expect(labelProblems(bad, new Set(["A"]))).toHaveLength(4);
  });
});

describe("violationsFor", () => {
  const req = { brand: "virgin_games" as const, seedId: "BLY-SLT-0035" };

  it.each([
    ["BLY-SLT-0035", "seed_itself"],
    ["BLY-SLT-0029", "not_live_on_brand"],
    ["BLY-SLT-0048", "volatility_step_up"],
    ["NOPE", "unknown_game"],
  ])("flags %s as %s", (gameId, kind) => {
    expect(violationsFor(req, gameId, ctx).map((v) => v.kind)).toContain(kind);
  });

  it("flags duplicate listings and quarantined games", () => {
    const dup = Object.keys(ref.duplicates)[0]!;
    expect(violationsFor({ brand: "virgin_games", seedId: "BLY-SLT-0047" }, dup, ctx).map((v) => v.kind)).toContain("duplicate_listing");
    const quarantined = new Map(operator);
    quarantined.set("BLY-SLT-0026", { ...operator.get("BLY-SLT-0026")!, quarantined: true, quarantineReason: "RTP conflict" });
    expect(violationsFor({ brand: "jackpotjoy", seedId: "BLY-SLT-0047" }, "BLY-SLT-0026", { ...ctx, operator: quarantined })[0]!.kind).toBe("quarantined");
  });

  it("finds no violations among eligible candidates", () => {
    for (const g of eligibleFor(req, ctx)) expect(violationsFor(req, g.id, ctx)).toEqual([]);
  });
});

describe("scoreRanker", () => {
  it("only issues requests for games live on each brand", () => {
    for (const r of requestsFor(ctx)) expect(operator.get(r.seedId)!.brands).toContain(r.brand);
  });

  it("blocks release when a ranker recommends a retired game, and counts must-not hits and fallbacks", () => {
    const s = scoreRanker("bad", fixed(["BLY-SLT-0058", "BLY-SLT-0003"], "below_floor"), ctx);
    expect(s.hardViolations.some((v) => v.gameId === "BLY-SLT-0058")).toBe(true);
    expect(s.mustNotHits.some((m) => m.seedId === "BLY-SLT-0013" && m.gameId === "BLY-SLT-0003")).toBe(true);
    expect(s.fallbackRate).toBe(1);
    expect(releasable(s.gates)).toBe(false);
  });

  it("ranks the oracle above the metadata baseline above random on silver labels", () => {
    const oracle = scoreRanker("oracle", silverOracle(key, ref.truth), ctx);
    const meta = scoreRanker("meta", metadataRanker(key), ctx);
    const random = scoreRanker("random", randomRanker(key), ctx);
    expect(oracle.silverNdcg).toBeCloseTo(1, 5);
    expect(meta.silverNdcg).toBeGreaterThan(random.silverNdcg);
    expect(oracle.hardViolations).toEqual([]);
  });

  it("reports family-sibling share", () => {
    const s = scoreRanker("siblings", fixed(["BLY-SLT-0014", "BLY-SLT-0015"]), { ...ctx, labels: { ...labels, seeds: [] } });
    expect(s.siblingShare).toBeGreaterThan(0);
    expect(s.handNdcg).toBe(0);
  });
});

describe("baselines", () => {
  it("filter by brand, status and the volatility guardrail", () => {
    const seed = key.find((g) => g.id === "BLY-SLT-0035")!;
    const pool = candidatesFor(seed, "virgin_games", key, operator);
    expect(pool.some((g) => g.id === "BLY-SLT-0048")).toBe(false);
    expect(pool.every((g) => operator.get(g.id)!.brands.includes("virgin_games"))).toBe(true);
    const unknownVol = { ...seed, fields: { ...seed.fields, volatility: { ...seed.fields.volatility, value: null } } };
    expect(candidatesFor(unknownVol, "virgin_games", key, operator)).toEqual([]);
  });

  it("score shared attributes and report unknown seeds", () => {
    const a = key.find((g) => g.id === "BLY-SLT-0013")!;
    expect(metadataScore(a, key.find((g) => g.id === "BLY-SLT-0056")!)).toBeGreaterThan(metadataScore(a, key.find((g) => g.id === "BLY-SLT-0003")!));
    expect(metadataRanker(key).rank("NOPE", "jackpotjoy", 5, operator).reason).toBe("unknown_game");
  });
});
