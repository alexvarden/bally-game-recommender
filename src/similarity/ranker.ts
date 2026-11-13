/**
 * Rankers behind the shared Ranker contract.
 *
 * Every ranker shares the same request-time rules (rankWith): hard filters from operator state, the volatility
 * step-up guardrail, the similarity floor and the fallback reasons. They differ only in how they score a pair, so
 * the eval compares scoring methods on equal terms.
 */
import type { Brand, EnrichedGame, Volatility } from "../catalogue/schema.ts";
import type { RankableGame, RankedItem, Ranker, RankerConfig, RankResult } from "../contracts/ranking.ts";
import { DEFAULT_RANKER_CONFIG } from "../contracts/ranking.ts";
import type { Aspect, OperatorState } from "../contracts/storage.ts";
import { cosine, tokenise } from "./embedders.ts";
import { isThin } from "./profiles.ts";
import type { z } from "zod";

type BrandId = z.infer<typeof Brand>;
type VolatilityLevel = z.infer<typeof Volatility>;
type OperatorMap = ReadonlyMap<string, OperatorState>;

const VOLATILITY_LEVEL: Record<VolatilityLevel, number> = { low: 0, medium: 1, high: 2, very_high: 3 };

/** What a ranker needs to know about the catalogue, independent of how it scores. */
export interface RankerCore {
  has(id: string): boolean;
  ids(): Iterable<string>;
  volatility(id: string): VolatilityLevel | null;
  /** True when the seed has too little content to match on. Baselines that don't use enrichment omit it. */
  isThin?(id: string): boolean;
  /** Similarity of a candidate to the seed; higher is more related. */
  score(seedId: string, candidateId: string): number;
  floor: number;
  /** Null disables the guardrail. */
  maxVolatilityStepUp: number | null;
}

/** A game may be recommended on a brand only if it is live there and not quarantined. */
export function isServable(state: OperatorState | undefined, brand: BrandId): boolean {
  return !!state && state.status === "live" && !state.quarantined && state.brands.includes(brand);
}

/**
 * Blocks candidates more than `maxStep` volatility levels above the seed. A candidate with unknown volatility is
 * blocked, because we can't show it's safe; an unknown seed can't anchor the rule, so it doesn't apply.
 */
export function passesVolatility(seed: VolatilityLevel | null, candidate: VolatilityLevel | null, maxStep: number | null): boolean {
  if (maxStep === null || seed === null) return true;
  if (candidate === null) return false;
  return VOLATILITY_LEVEL[candidate] - VOLATILITY_LEVEL[seed] <= maxStep;
}

function seedProblem(core: RankerCore, seedId: string, brand: BrandId, operator: OperatorMap): RankResult["reason"] {
  if (!core.has(seedId)) return "unknown_game";
  if (!isServable(operator.get(seedId), brand)) return "seed_unavailable";
  return core.isThin?.(seedId) ? "thin_seed" : null;
}

function eligibleCandidates(core: RankerCore, seedId: string, brand: BrandId, operator: OperatorMap): string[] {
  const seedVolatility = core.volatility(seedId);
  return [...core.ids()].filter(
    (id) => id !== seedId && isServable(operator.get(id), brand) && passesVolatility(seedVolatility, core.volatility(id), core.maxVolatilityStepUp),
  );
}

const byScoreThenId = (a: RankedItem, b: RankedItem) => b.score - a.score || a.gameId.localeCompare(b.gameId);

/** The request-time ranking rules every ranker shares. */
export function rankWith(core: RankerCore, seedId: string, brand: BrandId, limit: number, operator: OperatorMap): RankResult {
  const problem = seedProblem(core, seedId, brand, operator);
  if (problem) return { items: [], reason: problem };

  const items = eligibleCandidates(core, seedId, brand, operator)
    .map((gameId) => ({ gameId, score: core.score(seedId, gameId) }))
    .filter((item) => item.score >= core.floor)
    .sort(byScoreThenId)
    .slice(0, limit);
  return { items, reason: items.length < limit ? "below_floor" : null };
}

const asRanker = (core: RankerCore): Ranker => ({ rank: (seedId, brand, limit, operator) => rankWith(core, seedId, brand, limit, operator) });

const volatilityOf = (game: EnrichedGame) => game.fields.volatility.value;

// ---------- The proposed ranker: weighted aspect similarity ----------

/** Weighted mean of per-aspect cosine similarities, in [-1, 1]. */
export function aspectScore(seed: RankableGame["vectors"], candidate: RankableGame["vectors"], weights: RankerConfig["weights"]): number {
  const aspects = Object.keys(weights) as Aspect[];
  const total = aspects.reduce((s, a) => s + weights[a], 0);
  return aspects.reduce((s, a) => s + weights[a] * cosine(seed[a], candidate[a]), 0) / total;
}

export function createRanker(games: readonly RankableGame[], config: RankerConfig = DEFAULT_RANKER_CONFIG): Ranker {
  const byId = new Map(games.map((g) => [g.game.id, g]));
  return asRanker({
    has: (id) => byId.has(id),
    ids: () => byId.keys(),
    volatility: (id) => volatilityOf(byId.get(id)!.game),
    isThin: (id) => isThin(byId.get(id)!.game),
    score: (seedId, id) => aspectScore(byId.get(seedId)!.vectors, byId.get(id)!.vectors, config.weights),
    floor: config.similarityFloor,
    maxVolatilityStepUp: config.maxVolatilityStepUp,
  });
}

// ---------- Baselines for the eval ----------

/** Baselines keep the same filters and guardrail but have no floor and no thin-seed check. */
function baselineCore(games: readonly EnrichedGame[], config: RankerConfig, score: RankerCore["score"]): RankerCore {
  const byId = new Map(games.map((g) => [g.id, g]));
  return {
    has: (id) => byId.has(id),
    ids: () => byId.keys(),
    volatility: (id) => volatilityOf(byId.get(id)!),
    score,
    floor: -Infinity,
    maxVolatilityStepUp: config.maxVolatilityStepUp,
  };
}

/** Deterministic pseudo-random score per (seed, candidate) pair: the floor any method must beat. */
export function pairNoise(seedId: string, candidateId: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (const c of `${seedId}|${candidateId}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967296;
}

export function randomRanker(games: readonly EnrichedGame[], config: RankerConfig = DEFAULT_RANKER_CONFIG, salt = 1): Ranker {
  return asRanker(baselineCore(games, config, (s, c) => pairNoise(s, c, salt)));
}

type SparseVector = Map<string, number>;

/** TF-IDF vectors for a set of texts, keyed like the input. */
export function tfidfVectors(texts: ReadonlyMap<string, string>): Map<string, SparseVector> {
  const tokens = new Map([...texts].map(([id, t]) => [id, tokenise(t)]));
  const docFreq = new Map<string, number>();
  for (const toks of tokens.values()) for (const t of new Set(toks)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log((1 + texts.size) / (1 + docFreq.get(t)!)) + 1;

  return new Map(
    [...tokens].map(([id, toks]) => {
      const v: SparseVector = new Map();
      for (const t of toks) v.set(t, (v.get(t) ?? 0) + 1);
      for (const [t, tf] of v) v.set(t, tf * idf(t));
      return [id, v];
    }),
  );
}

export function sparseCosine(a: SparseVector, b: SparseVector): number {
  let dot = 0;
  for (const [t, w] of a) dot += w * (b.get(t) ?? 0);
  const norm = (v: SparseVector) => Math.sqrt([...v.values()].reduce((s, w) => s + w * w, 0));
  const denominator = norm(a) * norm(b);
  return denominator === 0 ? 0 : dot / denominator;
}

/** Word-overlap baseline over raw text (e.g. the supplier's documents with no enrichment). */
export function tfidfRanker(games: readonly EnrichedGame[], texts: ReadonlyMap<string, string>, config: RankerConfig = DEFAULT_RANKER_CONFIG): Ranker {
  const vectors = tfidfVectors(texts);
  const empty: SparseVector = new Map();
  return asRanker(baselineCore(games, config, (s, c) => sparseCosine(vectors.get(s) ?? empty, vectors.get(c) ?? empty)));
}

/** Single-vector baseline: one embedding of raw text per game, no aspect profiles. */
export function rawTextEmbeddingRanker(games: readonly EnrichedGame[], vectors: ReadonlyMap<string, number[]>, config: RankerConfig = DEFAULT_RANKER_CONFIG): Ranker {
  return asRanker(baselineCore(games, config, (s, c) => (vectors.has(s) && vectors.has(c) ? cosine(vectors.get(s)!, vectors.get(c)!) : 0)));
}
