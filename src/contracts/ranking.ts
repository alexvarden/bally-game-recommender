/**
 * Ranking and API contracts. The embedder and ranker are implemented in src/similarity/; the HTTP layer in
 * src/service/. Kept here so the service, the ranker and the evals agree on shapes.
 */
import { z } from "zod";
import { Brand, type EnrichedGame } from "../catalogue/schema.ts";
import type { Aspect, OperatorState } from "./storage.ts";

export interface Embedder {
  /** Model id recorded with every vector and index version. */
  readonly model: string;
  readonly dimensions: number;
  /** Unit-normalised vectors, one per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

export type AspectWeights = Record<Aspect, number>;

export const DEFAULT_ASPECT_WEIGHTS: AspectWeights = { content: 0.4, gameplay: 0.4, experience: 0.2 };

/** Everything the ranker needs about one game, held in memory by the service. */
export interface RankableGame {
  game: EnrichedGame;
  vectors: Record<Aspect, number[]>;
}

export interface RankerConfig {
  weights: AspectWeights;
  /** Below this weighted similarity a candidate isn't "related" and is dropped. */
  similarityFloor: number;
  /** Max volatility levels a recommendation may sit above the seed (low=0 … very_high=3). */
  maxVolatilityStepUp: number;
}

export const DEFAULT_RANKER_CONFIG: RankerConfig = { weights: DEFAULT_ASPECT_WEIGHTS, similarityFloor: 0.35, maxVolatilityStepUp: 1 };

export const FallbackReason = z.enum([
  "unknown_game", // seed id not in the index
  "seed_unavailable", // seed not live on this brand, or quarantined
  "thin_seed", // seed has too little enriched content to match on
  "below_floor", // nothing (or too little) cleared the similarity floor
  "index_unavailable", // no index loaded yet
]);
export type FallbackReason = z.infer<typeof FallbackReason>;

export interface RankedItem {
  gameId: string;
  score: number;
}

export interface RankResult {
  items: RankedItem[];
  /** Set when the ranker couldn't produce a full list; the service tops up from the brand fallback list. */
  reason: FallbackReason | null;
}

export interface Ranker {
  /**
   * Related games for `seedId` on `brand`, best first. Applies hard filters using the operator state passed in
   * (live on the brand, not quarantined, not the seed), the volatility guardrail and the similarity floor.
   */
  rank(seedId: string, brand: z.infer<typeof Brand>, limit: number, operator: ReadonlyMap<string, OperatorState>): RankResult;
}

// ---------- HTTP response ----------

export const RecommendationItem = z.object({ gameId: z.string(), name: z.string(), score: z.number().nullable(), fallback: z.boolean() });

export const RecommendationResponse = z.object({
  brand: Brand,
  gameId: z.string(),
  indexVersion: z.string().nullable(),
  /** True when any item came from the brand fallback list. */
  fallback: z.boolean(),
  reason: FallbackReason.nullable(),
  items: z.array(RecommendationItem),
});
export type RecommendationResponse = z.infer<typeof RecommendationResponse>;
