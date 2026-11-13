/**
 * CatalogueStore on SQLite (`node:sqlite`, built into Node).
 *
 * Entities are stored as validated JSON in narrow tables keyed by id: the schema lives in zod, not in SQL, so
 * there is one source of truth for shapes. Every read is parsed back through zod. The audit table is append-only.
 * In production this interface would sit on Postgres or DynamoDB; nothing above it knows it is SQLite.
 */
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { EnrichedGame, SourceGame } from "../catalogue/schema.ts";
import {
  AuditEntry,
  EmbeddingRecord,
  IndexVersion,
  NormalisedDocument,
  OperatorState,
  type AuditInput,
  type CatalogueStore,
} from "../contracts/storage.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS processed_objects (key TEXT NOT NULL, etag TEXT NOT NULL, processed_at TEXT NOT NULL, PRIMARY KEY (key, etag));
  CREATE TABLE IF NOT EXISTS source_games (id TEXT PRIMARY KEY, source_key TEXT NOT NULL, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS documents (doc_id TEXT PRIMARY KEY, game_id TEXT NOT NULL, json TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS documents_by_game ON documents (game_id);
  CREATE TABLE IF NOT EXISTS enrichments (id TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS embeddings (game_id TEXT NOT NULL, model TEXT NOT NULL, aspect TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (game_id, model, aspect));
  CREATE TABLE IF NOT EXISTS operator_state (game_id TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, before TEXT, after TEXT, reason TEXT);
  CREATE INDEX IF NOT EXISTS audit_by_game ON audit (game_id);
  CREATE TABLE IF NOT EXISTS index_versions (seq INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL UNIQUE, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS duplicates (duplicate_id TEXT PRIMARY KEY, original_id TEXT NOT NULL);
`;

type Row = Record<string, unknown>;

const parseJson = <T extends z.ZodType>(schema: T, row: Row | undefined): z.infer<T> | null =>
  row ? schema.parse(JSON.parse(row.json as string)) : null;

const parseAll = <T extends z.ZodType>(schema: T, rows: Row[]): z.infer<T>[] => rows.map((r) => schema.parse(JSON.parse(r.json as string)));

const toAuditEntry = (row: Row): AuditEntry =>
  AuditEntry.parse({
    id: Number(row.id),
    gameId: row.game_id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    before: row.before === null ? null : JSON.parse(row.before as string),
    after: row.after === null ? null : JSON.parse(row.after as string),
    reason: row.reason,
  });

export interface SqliteStoreOptions {
  /** Clock for audit timestamps; injectable for tests. */
  now?: () => string;
}

export class SqliteCatalogueStore implements CatalogueStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(path = ":memory:", options: SqliteStoreOptions = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // ---------- Ingestion bookkeeping ----------

  async hasProcessed(key: string, etag: string) {
    return this.db.prepare("SELECT 1 FROM processed_objects WHERE key = ? AND etag = ?").get(key, etag) !== undefined;
  }

  async markProcessed(key: string, etag: string) {
    this.db.prepare("INSERT OR IGNORE INTO processed_objects VALUES (?, ?, ?)").run(key, etag, this.now());
  }

  // ---------- Source data ----------

  async upsertSourceGame(game: SourceGame, sourceKey: string) {
    const json = JSON.stringify(SourceGame.parse(game));
    this.db.prepare("INSERT INTO source_games VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET source_key = excluded.source_key, json = excluded.json").run(game.id, sourceKey, json);
  }

  async getSourceGame(id: string) {
    return parseJson(SourceGame, this.db.prepare("SELECT json FROM source_games WHERE id = ?").get(id) as Row | undefined);
  }

  async listSourceGames() {
    return parseAll(SourceGame, this.db.prepare("SELECT json FROM source_games ORDER BY id").all() as Row[]);
  }

  async upsertDocument(doc: NormalisedDocument) {
    const json = JSON.stringify(NormalisedDocument.parse(doc));
    this.db.prepare("INSERT INTO documents VALUES (?, ?, ?) ON CONFLICT(doc_id) DO UPDATE SET game_id = excluded.game_id, json = excluded.json").run(doc.docId, doc.gameId, json);
  }

  async listDocuments(gameId: string) {
    return parseAll(NormalisedDocument, this.db.prepare("SELECT json FROM documents WHERE game_id = ? ORDER BY doc_id").all(gameId) as Row[]);
  }

  // ---------- Enrichment ----------

  async saveEnrichment(game: EnrichedGame) {
    const json = JSON.stringify(EnrichedGame.parse(game));
    this.db.prepare("INSERT INTO enrichments VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json").run(game.id, json);
  }

  async getEnrichment(id: string) {
    return parseJson(EnrichedGame, this.db.prepare("SELECT json FROM enrichments WHERE id = ?").get(id) as Row | undefined);
  }

  async listEnrichments() {
    return parseAll(EnrichedGame, this.db.prepare("SELECT json FROM enrichments ORDER BY id").all() as Row[]);
  }

  // ---------- Embeddings ----------

  async saveEmbeddings(records: EmbeddingRecord[]) {
    const stmt = this.db.prepare("INSERT INTO embeddings VALUES (?, ?, ?, ?) ON CONFLICT(game_id, model, aspect) DO UPDATE SET json = excluded.json");
    this.transaction(() => {
      for (const r of records) stmt.run(r.gameId, r.model, r.aspect, JSON.stringify(EmbeddingRecord.parse(r)));
    });
  }

  async listEmbeddings(model: string) {
    return parseAll(EmbeddingRecord, this.db.prepare("SELECT json FROM embeddings WHERE model = ? ORDER BY game_id, aspect").all(model) as Row[]);
  }

  // ---------- Operator state and audit ----------

  async getOperatorState(id: string) {
    return parseJson(OperatorState, this.db.prepare("SELECT json FROM operator_state WHERE game_id = ?").get(id) as Row | undefined);
  }

  async listOperatorStates() {
    return parseAll(OperatorState, this.db.prepare("SELECT json FROM operator_state ORDER BY game_id").all() as Row[]);
  }

  async writeOperatorState(state: OperatorState, audit: AuditInput) {
    if (state.gameId !== audit.gameId) throw new Error(`audit is for ${audit.gameId}, state is for ${state.gameId}`);
    const json = JSON.stringify(OperatorState.parse(state));
    return this.transaction(() => {
      this.db.prepare("INSERT INTO operator_state VALUES (?, ?) ON CONFLICT(game_id) DO UPDATE SET json = excluded.json").run(state.gameId, json);
      const result = this.db
        .prepare("INSERT INTO audit (game_id, at, actor, action, before, after, reason) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(audit.gameId, this.now(), audit.actor, audit.action, JSON.stringify(audit.before ?? null), JSON.stringify(audit.after ?? null), audit.reason);
      return toAuditEntry(this.db.prepare("SELECT * FROM audit WHERE id = ?").get(result.lastInsertRowid) as Row);
    });
  }

  async listAudit(gameId: string) {
    return (this.db.prepare("SELECT * FROM audit WHERE game_id = ? ORDER BY id").all(gameId) as Row[]).map(toAuditEntry);
  }

  // ---------- Index versions ----------

  async publishIndex(index: IndexVersion) {
    this.db.prepare("INSERT INTO index_versions (version, json) VALUES (?, ?)").run(index.version, JSON.stringify(IndexVersion.parse(index)));
  }

  async currentIndex() {
    return parseJson(IndexVersion, this.db.prepare("SELECT json FROM index_versions ORDER BY seq DESC LIMIT 1").get() as Row | undefined);
  }

  // ---------- Duplicates (beyond the shared contract; used by ingest) ----------

  async recordDuplicate(duplicateId: string, originalId: string) {
    this.db.prepare("INSERT INTO duplicates VALUES (?, ?) ON CONFLICT(duplicate_id) DO UPDATE SET original_id = excluded.original_id").run(duplicateId, originalId);
  }

  async listDuplicates(): Promise<Record<string, string>> {
    const rows = this.db.prepare("SELECT duplicate_id, original_id FROM duplicates ORDER BY duplicate_id").all() as Row[];
    return Object.fromEntries(rows.map((r) => [r.duplicate_id as string, r.original_id as string]));
  }

  async close() {
    this.db.close();
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
