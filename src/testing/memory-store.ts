/**
 * In-memory implementations of the storage contracts, for tests and local experiments.
 * Behaviour matches the contracts; nothing here is durable.
 */
import { createHash } from "node:crypto";
import type { EnrichedGame, SourceGame } from "../catalogue/schema.ts";
import type {
  AuditEntry,
  AuditInput,
  CatalogueStore,
  EmbeddingRecord,
  IndexVersion,
  NormalisedDocument,
  ObjectStore,
  ObjectSummary,
  OperatorState,
} from "../contracts/storage.ts";

export class MemoryCatalogueStore implements CatalogueStore {
  private processed = new Set<string>();
  private sourceGames = new Map<string, SourceGame>();
  private documents = new Map<string, NormalisedDocument>();
  private enrichments = new Map<string, EnrichedGame>();
  private embeddings = new Map<string, EmbeddingRecord>();
  private operatorStates = new Map<string, OperatorState>();
  private audit: AuditEntry[] = [];
  private indexes: IndexVersion[] = [];

  async hasProcessed(key: string, etag: string) {
    return this.processed.has(`${key}|${etag}`);
  }

  async markProcessed(key: string, etag: string) {
    this.processed.add(`${key}|${etag}`);
  }

  async upsertSourceGame(game: SourceGame, _sourceKey: string) {
    this.sourceGames.set(game.id, structuredClone(game));
  }

  async getSourceGame(id: string) {
    return structuredClone(this.sourceGames.get(id) ?? null);
  }

  async listSourceGames() {
    return [...this.sourceGames.values()].map((g) => structuredClone(g));
  }

  async upsertDocument(doc: NormalisedDocument) {
    this.documents.set(doc.docId, structuredClone(doc));
  }

  async listDocuments(gameId: string) {
    return [...this.documents.values()].filter((d) => d.gameId === gameId).map((d) => structuredClone(d));
  }

  async saveEnrichment(game: EnrichedGame) {
    this.enrichments.set(game.id, structuredClone(game));
  }

  async getEnrichment(id: string) {
    return structuredClone(this.enrichments.get(id) ?? null);
  }

  async listEnrichments() {
    return [...this.enrichments.values()].map((g) => structuredClone(g));
  }

  async saveEmbeddings(records: EmbeddingRecord[]) {
    for (const r of records) this.embeddings.set(`${r.gameId}|${r.model}|${r.aspect}`, structuredClone(r));
  }

  async listEmbeddings(model: string) {
    return [...this.embeddings.values()].filter((r) => r.model === model).map((r) => structuredClone(r));
  }

  async getOperatorState(id: string) {
    return structuredClone(this.operatorStates.get(id) ?? null);
  }

  async listOperatorStates() {
    return [...this.operatorStates.values()].map((s) => structuredClone(s));
  }

  async writeOperatorState(state: OperatorState, input: AuditInput) {
    const entry: AuditEntry = { id: this.audit.length + 1, at: new Date().toISOString(), ...input };
    this.operatorStates.set(state.gameId, structuredClone(state));
    this.audit.push(entry);
    return structuredClone(entry);
  }

  async listAudit(gameId: string) {
    return this.audit.filter((a) => a.gameId === gameId).map((a) => structuredClone(a));
  }

  async publishIndex(index: IndexVersion) {
    this.indexes.push(structuredClone(index));
  }

  async currentIndex() {
    return structuredClone(this.indexes.at(-1) ?? null);
  }

  async close() {}
}

export class MemoryObjectStore implements ObjectStore {
  private objects = new Map<string, { body: Buffer; summary: ObjectSummary }>();

  async list(prefix: string) {
    return [...this.objects.values()]
      .map((o) => o.summary)
      .filter((s) => s.key.startsWith(prefix))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) throw new Error(`NoSuchKey: ${key}`);
    return Buffer.from(o.body);
  }

  async put(key: string, body: Buffer | string) {
    const buf = Buffer.from(body);
    const summary = { key, etag: createHash("md5").update(buf).digest("hex"), lastModified: new Date().toISOString() };
    this.objects.set(key, { body: buf, summary });
    return summary;
  }
}
