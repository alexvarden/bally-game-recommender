import { describe, expect, it } from "vitest";
import type { EnrichedGame } from "../catalogue/schema.ts";
import { DEFAULT_RANKER_CONFIG, type RankableGame, type RankerConfig } from "../contracts/ranking.ts";
import type { OperatorState } from "../contracts/storage.ts";
import { enrichedFromTruth, loadGroundTruth, operatorStateFrom } from "../testing/fixtures.ts";
import {
  aspectScore,
  createRanker,
  isServable,
  pairNoise,
  passesVolatility,
  randomRanker,
  rawTextEmbeddingRanker,
  sparseCosine,
  tfidfRanker,
  tfidfVectors,
} from "./ranker.ts";

const truth = loadGroundTruth();
const template = enrichedFromTruth(truth.games.find((g) => g.status === "live" && g.brands.includes("jackpotjoy"))!);

/** A synthetic game: same template, chosen id/volatility, and hand-made vectors so scores are predictable. */
function game(id: string, vector: number[], volatility: EnrichedGame["fields"]["volatility"]["value"] = "medium"): RankableGame {
  const g: EnrichedGame = { ...template, id, name: id, fields: { ...template.fields, volatility: { ...template.fields.volatility, value: volatility } } };
  return { game: g, vectors: { content: vector, gameplay: vector, experience: vector } };
}

const state = (id: string, over: Partial<OperatorState> = {}): OperatorState => ({ ...operatorStateFrom({ id, status: "live", brands: ["jackpotjoy"], rgFlags: [] }), ...over });
const operatorFor = (games: RankableGame[], over: Record<string, Partial<OperatorState>> = {}) => new Map(games.map((g) => [g.game.id, state(g.game.id, over[g.game.id])]));

const config: RankerConfig = { ...DEFAULT_RANKER_CONFIG, similarityFloor: 0.5 };

const catalogue = [
  game("seed", [1, 0, 0]),
  game("close", [0.9, 0.1, 0]),
  game("medium", [0.7, 0.7, 0]),
  game("far", [0, 0, 1]),
  game("jumpy", [0.95, 0.05, 0], "very_high"),
];

describe("createRanker", () => {
  const ranker = createRanker(catalogue, config);

  it("ranks by weighted similarity, drops the seed, the floor and guardrail breaches", () => {
    const r = ranker.rank("seed", "jackpotjoy", 5, operatorFor(catalogue));
    expect(r.items.map((i) => i.gameId)).toEqual(["close", "medium"]);
    expect(r.items[0]!.score).toBeGreaterThan(r.items[1]!.score);
    expect(r.reason).toBe("below_floor");
  });

  it("returns a full list without a reason when enough candidates clear the floor", () => {
    expect(ranker.rank("seed", "jackpotjoy", 2, operatorFor(catalogue))).toMatchObject({ reason: null, items: [{ gameId: "close" }, { gameId: "medium" }] });
  });

  it("excludes candidates that aren't live on the brand or are quarantined", () => {
    const operator = operatorFor(catalogue, { close: { status: "suspended" }, medium: { quarantined: true } });
    expect(ranker.rank("seed", "jackpotjoy", 5, operator).items).toEqual([]);
    expect(ranker.rank("seed", "virgin_games", 5, operatorFor(catalogue)).reason).toBe("seed_unavailable");
  });

  it("reports unknown, unavailable and thin seeds", () => {
    expect(ranker.rank("nope", "jackpotjoy", 5, operatorFor(catalogue)).reason).toBe("unknown_game");
    expect(ranker.rank("seed", "jackpotjoy", 5, operatorFor(catalogue, { seed: { status: "retired" } })).reason).toBe("seed_unavailable");

    const thinGame = game("thin", [1, 0, 0]);
    for (const k of ["primaryTheme", "coreMechanic", "mood", "pace", "artStyle", "subThemes"] as const) {
      thinGame.game.fields[k] = { value: null, provenance: "unknown", evidence: null, confidence: 0 } as never;
    }
    const withThin = [...catalogue, thinGame];
    expect(createRanker(withThin, config).rank("thin", "jackpotjoy", 5, operatorFor(withThin)).reason).toBe("thin_seed");
  });

  it("lets a higher step-up limit admit volatile games", () => {
    const loose = createRanker(catalogue, { ...config, maxVolatilityStepUp: 3 });
    expect(loose.rank("seed", "jackpotjoy", 1, operatorFor(catalogue)).items[0]!.gameId).toBe("jumpy");
  });
});

describe("rules", () => {
  it("isServable needs live, the brand, and no quarantine", () => {
    expect(isServable(state("a"), "jackpotjoy")).toBe(true);
    expect(isServable(undefined, "jackpotjoy")).toBe(false);
    expect(isServable(state("a", { status: "coming_soon" }), "jackpotjoy")).toBe(false);
    expect(isServable(state("a", { quarantined: true }), "jackpotjoy")).toBe(false);
  });

  it("passesVolatility limits step-ups, blocks unknown candidates, and ignores unknown seeds", () => {
    expect(passesVolatility("low", "medium", 1)).toBe(true);
    expect(passesVolatility("low", "high", 1)).toBe(false);
    expect(passesVolatility("very_high", "low", 1)).toBe(true);
    expect(passesVolatility("low", null, 1)).toBe(false);
    expect(passesVolatility(null, "very_high", 1)).toBe(true);
    expect(passesVolatility("low", "very_high", null)).toBe(true);
  });

  it("aspectScore is the weighted mean of aspect cosines", () => {
    const a = { content: [1, 0], gameplay: [1, 0], experience: [1, 0] };
    const b = { content: [1, 0], gameplay: [0, 1], experience: [1, 0] };
    expect(aspectScore(a, b, { content: 0.4, gameplay: 0.4, experience: 0.2 })).toBeCloseTo(0.6);
  });
});

describe("baselines", () => {
  const games = catalogue.map((c) => c.game);
  const operator = operatorFor(catalogue);

  it("random is deterministic per salt and has no floor", () => {
    const r = randomRanker(games, config, 7);
    expect(r.rank("seed", "jackpotjoy", 3, operator)).toEqual(r.rank("seed", "jackpotjoy", 3, operator));
    expect(r.rank("seed", "jackpotjoy", 3, operator).items).toHaveLength(3);
    expect(pairNoise("a", "b", 1)).not.toBe(pairNoise("a", "b", 2));
  });

  it("tf-idf ranks word overlap, ignoring games with no text", () => {
    const texts = new Map([["seed", "norse vikings runes"], ["close", "norse vikings fjord"], ["medium", "candy sweets"], ["far", "runes"]]);
    const r = tfidfRanker(games, texts, config).rank("seed", "jackpotjoy", 4, operator);
    expect(r.items[0]!.gameId).toBe("close");
    expect(r.items.find((i) => i.gameId === "medium")!.score).toBe(0);
  });

  it("tfidf helpers weight rare words higher and handle empty vectors", () => {
    const v = tfidfVectors(new Map([["a", "common rare"], ["b", "common"]]));
    expect(v.get("a")!.get("rare")!).toBeGreaterThan(v.get("a")!.get("common")!);
    expect(sparseCosine(new Map(), v.get("a")!)).toBe(0);
  });

  it("raw-text embedding ranks by single-vector cosine and scores missing vectors as 0", () => {
    const vectors = new Map([["seed", [1, 0]], ["close", [0.9, 0.1]], ["medium", [0, 1]]]);
    const r = rawTextEmbeddingRanker(games, vectors, config).rank("seed", "jackpotjoy", 3, operator);
    // "medium" is orthogonal and "far" has no vector: both score 0 and tie-break by id.
    expect(r.items.map((i) => i.gameId)).toEqual(["close", "far", "medium"]);
    expect(r.items.find((i) => i.gameId === "far")!.score).toBe(0);
  });
});
