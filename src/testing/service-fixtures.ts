/**
 * Test wiring for the service: a memory store seeded from the ground truth, simple vectors, and a stub ranker.
 * The stub stands in for src/similarity/ranker.ts; it is deliberately naive and ignores operator state, so tests can
 * prove the service filters on its own.
 */
import pino from "pino";
import type { EnrichedGame } from "../catalogue/schema.ts";
import type { RankableGame, Ranker, RankResult } from "../contracts/ranking.ts";
import { Aspect, type EmbeddingRecord, type IndexVersion } from "../contracts/storage.ts";
import { groundTruthAsEnriched, operatorStateFrom } from "./fixtures.ts";
import { MemoryCatalogueStore, MemoryObjectStore } from "./memory-store.ts";

export const TEST_MODEL = "test-embedder";

export const silentLogger = () => pino({ level: "silent" });

/** Three-dimensional unit vectors that differ per game, enough to validate shapes. */
export function testEmbeddings(games: EnrichedGame[], model = TEST_MODEL, dims = 3): EmbeddingRecord[] {
  return games.flatMap((g, i) =>
    Aspect.options.map((aspect) => {
      const raw = Array.from({ length: dims }, (_, d) => Math.cos(i + d + aspect.length));
      const norm = Math.hypot(...raw);
      return { gameId: g.id, model, aspect, profileText: `${aspect} of ${g.name}`, inputHash: `${g.id}-${aspect}`, vector: raw.map((x) => x / norm) };
    }),
  );
}

export const testIndex = (version: string, gameCount: number, model = TEST_MODEL): IndexVersion => ({ version, createdAt: "2026-11-13T00:00:00.000Z", embeddingModel: model, gameCount });

export interface StubRankerOptions {
  /** How many items to return at most (to simulate a floor cutting the list short). */
  maxItems?: number;
  reason?: RankResult["reason"];
}

/** Returns every other game in index order, ignoring brand and status, with descending scores. */
export function stubRankerFactory(options: StubRankerOptions = {}) {
  return (games: RankableGame[]): Ranker => ({
    rank: (seedId, _brand, limit) => ({
      items: games
        .filter((g) => g.game.id !== seedId)
        .slice(0, Math.min(limit * 3, options.maxItems ?? Infinity))
        .map((g, i) => ({ gameId: g.game.id, score: Math.round((0.95 - i * 0.01) * 100) / 100 })),
      reason: options.reason ?? null,
    }),
  });
}

/** A store with every ground-truth game enriched, embedded, published as index v1, with operator state. */
export async function seededStore(games = groundTruthAsEnriched()) {
  const store = new MemoryCatalogueStore();
  for (const g of games) {
    await store.saveEnrichment(g);
    await store.writeOperatorState(operatorStateFrom(g), { gameId: g.id, actor: "seed", action: "create_game", before: null, after: null, reason: "seed" });
  }
  await store.saveEmbeddings(testEmbeddings(games));
  await store.publishIndex(testIndex("v1", games.length));
  return { store, objects: new MemoryObjectStore(), games };
}
