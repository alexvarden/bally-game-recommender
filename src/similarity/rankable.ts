/** Joins enriched games with their stored aspect vectors into what the ranker holds in memory. */
import type { EnrichedGame } from "../catalogue/schema.ts";
import type { RankableGame } from "../contracts/ranking.ts";
import type { Aspect, EmbeddingRecord } from "../contracts/storage.ts";

const ASPECTS: Aspect[] = ["content", "gameplay", "experience"];

/** Games with a vector for every aspect from `model`. Games missing any aspect are left out and reported. */
export function toRankable(games: readonly EnrichedGame[], records: readonly EmbeddingRecord[], model: string) {
  const vectors = new Map<string, Partial<Record<Aspect, number[]>>>();
  for (const r of records.filter((r) => r.model === model)) {
    vectors.set(r.gameId, { ...vectors.get(r.gameId), [r.aspect]: r.vector });
  }
  const rankable: RankableGame[] = [];
  const missing: string[] = [];
  for (const game of games) {
    const v = vectors.get(game.id);
    if (v && ASPECTS.every((a) => v[a])) rankable.push({ game, vectors: v as Record<Aspect, number[]> });
    else missing.push(game.id);
  }
  return { rankable, missing };
}
