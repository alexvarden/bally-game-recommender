/**
 * Storage contracts shared by the pipeline, the service and the admin API.
 *
 * ObjectStore is S3 in production and a local folder in development. CatalogueStore is SQLite locally; in
 * production it would be Postgres or DynamoDB. Implementations live in src/storage/.
 */
import { z } from "zod";
import { Brand, DescriptiveOverrides, DocumentFormat, DocumentKind, EnrichedGame, RgFlag, SourceGame, Status } from "../catalogue/schema.ts";

// ---------- Object store (the S3 bucket) ----------

export interface ObjectSummary {
  key: string;
  /** Content hash, as S3 returns it. Used to detect changed objects under the same key. */
  etag: string;
  lastModified: string;
}

export interface ObjectStore {
  /** Objects under a prefix, sorted by key. */
  list(prefix: string): Promise<ObjectSummary[]>;
  get(key: string): Promise<Buffer>;
  put(key: string, body: Buffer | string): Promise<ObjectSummary>;
}

/**
 * Bucket layout. Feeds are JSON arrays of RawFeedRecord; documents are raw bytes with a JSON sidecar.
 *   incoming/feeds/<aggregator-or-studio>/<yyyy-mm-dd>.json
 *   incoming/documents/<gameId>/<docId>.<ext>
 *   incoming/documents/<gameId>/<docId>.meta.json      (DocumentMeta)
 */
export const BUCKET_PREFIX = { feeds: "incoming/feeds/", documents: "incoming/documents/" } as const;

export const DocumentMeta = z.object({
  docId: z.string(),
  gameId: z.string(),
  kind: DocumentKind,
  format: DocumentFormat,
  contentType: z.string(),
  source: z.string(),
  receivedAt: z.string(),
});
export type DocumentMeta = z.infer<typeof DocumentMeta>;

// ---------- Catalogue store ----------

/** A document after deterministic normalisation to plain text. Evidence quotes are checked against `text`. */
export const NormalisedDocument = DocumentMeta.extend({
  rawKey: z.string(),
  text: z.string(),
});
export type NormalisedDocument = z.infer<typeof NormalisedDocument>;

/** Operator-owned state. Changes here take effect on the next request, without a pipeline run. */
export const OperatorState = z.object({
  gameId: z.string(),
  status: Status,
  brands: z.array(Brand),
  rgFlags: z.array(RgFlag),
  quarantined: z.boolean(),
  quarantineReason: z.string().nullable(),
  overrides: DescriptiveOverrides,
  updatedAt: z.string(),
});
export type OperatorState = z.infer<typeof OperatorState>;

export const AuditAction = z.enum(["update_operator_fields", "set_overrides", "resolve_conflict", "retire", "create_game", "quarantine"]);

export const AuditEntry = z.object({
  id: z.number().int(),
  gameId: z.string(),
  at: z.string(),
  actor: z.string(),
  action: AuditAction,
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const Aspect = z.enum(["content", "gameplay", "experience"]);
export type Aspect = z.infer<typeof Aspect>;

/** One embedding per (game, model, aspect). `inputHash` lets the pipeline skip unchanged profiles. */
export const EmbeddingRecord = z.object({
  gameId: z.string(),
  model: z.string(),
  aspect: Aspect,
  profileText: z.string(),
  inputHash: z.string(),
  vector: z.array(z.number()),
});
export type EmbeddingRecord = z.infer<typeof EmbeddingRecord>;

/** A published, immutable snapshot of what the service ranks over. The service polls `currentIndex()`. */
export const IndexVersion = z.object({
  version: z.string(),
  createdAt: z.string(),
  embeddingModel: z.string(),
  gameCount: z.number().int(),
});
export type IndexVersion = z.infer<typeof IndexVersion>;

export interface AuditInput {
  gameId: string;
  actor: string;
  action: z.infer<typeof AuditAction>;
  before: unknown;
  after: unknown;
  reason: string | null;
}

export interface CatalogueStore {
  // Ingestion bookkeeping: an object is processed once per (key, etag).
  hasProcessed(key: string, etag: string): Promise<boolean>;
  markProcessed(key: string, etag: string): Promise<void>;

  // Source data, as normalised by the ingest step.
  upsertSourceGame(game: SourceGame, sourceKey: string): Promise<void>;
  getSourceGame(id: string): Promise<SourceGame | null>;
  listSourceGames(): Promise<SourceGame[]>;
  upsertDocument(doc: NormalisedDocument): Promise<void>;
  listDocuments(gameId: string): Promise<NormalisedDocument[]>;

  // Enrichment, keyed by game; `meta.sourceHash` decides whether a game needs re-enriching.
  saveEnrichment(game: EnrichedGame): Promise<void>;
  getEnrichment(id: string): Promise<EnrichedGame | null>;
  listEnrichments(): Promise<EnrichedGame[]>;

  // Embeddings.
  saveEmbeddings(records: EmbeddingRecord[]): Promise<void>;
  listEmbeddings(model: string): Promise<EmbeddingRecord[]>;

  // Operator state and audit. Every write to operator state must go through one of these and be audited.
  getOperatorState(id: string): Promise<OperatorState | null>;
  listOperatorStates(): Promise<OperatorState[]>;
  /** Writes the new state and its audit entry in one transaction. */
  writeOperatorState(state: OperatorState, audit: AuditInput): Promise<AuditEntry>;
  listAudit(gameId: string): Promise<AuditEntry[]>;

  // Index versions.
  publishIndex(index: IndexVersion): Promise<void>;
  currentIndex(): Promise<IndexVersion | null>;

  close(): Promise<void>;
}
