/**
 * Holds what the service ranks over, in memory, and swaps it atomically when a new index version is published.
 *
 * - A snapshot is built from the store (enrichments + embeddings for the index's model) and validated before it
 *   replaces the current one. If validation fails, the old snapshot keeps serving and the failure is logged.
 * - Operator state (status, brands, quarantine) is cached separately and refreshed on every admin write and on every
 *   index change, so a suspension affects the very next request without a pipeline run.
 */
import type { FastifyBaseLogger as Logger } from "fastify";
import type { EnrichedGame } from "../catalogue/schema.ts";
import type { RankableGame, Ranker } from "../contracts/ranking.ts";
import { Aspect, type CatalogueStore, type EmbeddingRecord, type IndexVersion, type OperatorState } from "../contracts/storage.ts";

export type RankerFactory = (games: RankableGame[]) => Ranker;

export interface Snapshot {
  index: IndexVersion;
  games: RankableGame[];
  byId: ReadonlyMap<string, RankableGame>;
  ranker: Ranker;
}

export class SnapshotError extends Error {}

function vectorsByGame(embeddings: EmbeddingRecord[]) {
  const out = new Map<string, Partial<Record<Aspect, number[]>>>();
  for (const e of embeddings) out.set(e.gameId, { ...out.get(e.gameId), [e.aspect]: e.vector });
  return out;
}

function assertConsistentDimensions(games: RankableGame[]) {
  const dims = new Set(games.flatMap((g) => Aspect.options.map((a) => g.vectors[a].length)));
  if (dims.size > 1) throw new SnapshotError(`inconsistent vector dimensions: ${[...dims].join(", ")}`);
  if (dims.has(0)) throw new SnapshotError("empty vectors");
}

/** Joins enrichments with their vectors and checks the result matches what the index version promised. */
export function buildSnapshot(index: IndexVersion, enrichments: EnrichedGame[], embeddings: EmbeddingRecord[], rankerFactory: RankerFactory): Snapshot {
  const vectors = vectorsByGame(embeddings.filter((e) => e.model === index.embeddingModel));
  const games: RankableGame[] = [];
  for (const game of enrichments) {
    const v = vectors.get(game.id);
    if (v && Aspect.options.every((a) => v[a])) games.push({ game, vectors: v as Record<Aspect, number[]> });
  }
  if (games.length === 0) throw new SnapshotError(`index ${index.version} has no games with vectors for ${index.embeddingModel}`);
  if (games.length !== index.gameCount) throw new SnapshotError(`index ${index.version} promised ${index.gameCount} games, found ${games.length}`);
  assertConsistentDimensions(games);
  return { index, games, byId: new Map(games.map((g) => [g.game.id, g])), ranker: rankerFactory(games) };
}

export interface IndexLoaderOptions {
  store: CatalogueStore;
  rankerFactory: RankerFactory;
  logger: Logger;
  pollMs?: number;
}

export class IndexLoader {
  private snapshot: Snapshot | null = null;
  private operator = new Map<string, OperatorState>();
  private timer: NodeJS.Timeout | null = null;
  private readonly opts: IndexLoaderOptions;

  constructor(opts: IndexLoaderOptions) {
    this.opts = opts;
  }

  current(): Snapshot | null {
    return this.snapshot;
  }

  operatorStates(): ReadonlyMap<string, OperatorState> {
    return this.operator;
  }

  /** Swaps in the latest index if the pointer moved. Returns true if a new snapshot went live. */
  async refresh(): Promise<boolean> {
    const index = await this.opts.store.currentIndex();
    if (!index || index.version === this.snapshot?.index.version) return false;
    try {
      const [enrichments, embeddings] = await Promise.all([this.opts.store.listEnrichments(), this.opts.store.listEmbeddings(index.embeddingModel)]);
      const next = buildSnapshot(index, enrichments, embeddings, this.opts.rankerFactory);
      await this.refreshOperatorStates();
      this.snapshot = next;
      this.opts.logger.info({ indexVersion: index.version, games: next.games.length }, "index swapped in");
      return true;
    } catch (err) {
      this.opts.logger.error({ indexVersion: index.version, err: (err as Error).message, serving: this.snapshot?.index.version ?? null }, "index rejected; keeping current");
      return false;
    }
  }

  async refreshOperatorStates(): Promise<void> {
    const states = await this.opts.store.listOperatorStates();
    this.operator = new Map(states.map((s) => [s.gameId, s]));
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.refresh(), this.opts.pollMs ?? 5000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
