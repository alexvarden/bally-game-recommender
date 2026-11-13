/**
 * Ingest: new objects in the bucket → normalised games and documents in the catalogue store.
 *
 * Run-once and idempotent: each object is processed once per (key, etag), so re-running does nothing and a changed
 * object is picked up again. Feeds are processed before documents so duplicate listings are known when their
 * documents arrive. A game's operator state (status, brands, RG flags) is initialised from the feed the first time
 * the game is seen; after that the operator owns it, and only the admin API changes it.
 *
 * Usage: node src/ingest/ingest.ts [--bucket var/bucket] [--db var/catalogue.sqlite]
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";
import type { DocumentFormat, SourceGame } from "../catalogue/schema.ts";
import { BUCKET_PREFIX, DocumentMeta, type CatalogueStore, type ObjectStore, type ObjectSummary, type OperatorState } from "../contracts/storage.ts";
import { argValue, isMain } from "../lib/cli.ts";
import { LocalObjectStore, DEFAULT_BUCKET_DIR } from "../storage/local-object-store.ts";
import { SqliteCatalogueStore } from "../storage/sqlite-catalogue-store.ts";
import { nameKey, normaliseFeedRecord } from "./normalise-feed.ts";

export const DEFAULT_DB_PATH = "var/catalogue.sqlite";
export const INGEST_ACTOR = "ingest";

/** Turns a raw document (HTML, XML, email…) into plain text. The real one lives in src/text/normalise.ts. */
export type NormaliseText = (raw: string, format: z.infer<typeof DocumentFormat>) => string;

/** Placeholder until the text normaliser is wired in: stores the raw text unchanged. */
export const identityText: NormaliseText = (raw) => raw;

/** The catalogue store plus the duplicate registry ingest needs (not part of the shared contract). */
export interface IngestStore extends CatalogueStore {
  recordDuplicate(duplicateId: string, originalId: string): Promise<void>;
  listDuplicates(): Promise<Record<string, string>>;
}

export interface IngestDeps {
  objects: ObjectStore;
  store: IngestStore;
  normaliseText: NormaliseText;
  now: () => string;
}

export interface IngestReport {
  feedsProcessed: string[];
  documentsProcessed: string[];
  newGames: string[];
  updatedGames: string[];
  /** Duplicate listing id → the original game it duplicates. */
  duplicates: Record<string, string>;
  /** Game id → feed values that couldn't be parsed. */
  unparsed: Record<string, string[]>;
  /** Documents stored for games with no feed record yet; held until the feed arrives. */
  orphanDocuments: string[];
}

const emptyReport = (): IngestReport => ({ feedsProcessed: [], documentsProcessed: [], newGames: [], updatedGames: [], duplicates: {}, unparsed: {}, orphanDocuments: [] });

// ---------- Duplicates ----------

const duplicateKey = (g: Pick<SourceGame, "supplierGameCode" | "name">) => (g.supplierGameCode ? `${g.supplierGameCode}|${nameKey(g.name)}` : null);

/** The id of an already-known game this one duplicates: same supplier code and same name, different id. */
export function findOriginal(game: SourceGame, known: ReadonlyMap<string, string>): string | null {
  const key = duplicateKey(game);
  const original = key ? known.get(key) : undefined;
  return original && original !== game.id ? original : null;
}

async function knownGameKeys(store: IngestStore): Promise<Map<string, string>> {
  const known = new Map<string, string>();
  for (const g of await store.listSourceGames()) {
    const key = duplicateKey(g);
    if (key && !known.has(key)) known.set(key, g.id);
  }
  return known;
}

// ---------- Feeds ----------

/** Operator state for a game seen for the first time. Unknown status is never served, so it starts suspended. */
export function initialOperatorState(game: SourceGame, now: string): OperatorState {
  return { gameId: game.id, status: game.status ?? "suspended", brands: game.brands, rgFlags: game.rgFlags, quarantined: false, quarantineReason: null, overrides: {}, updatedAt: now };
}

async function ingestGame(game: SourceGame, sourceKey: string, deps: IngestDeps, known: Map<string, string>, report: IngestReport) {
  const original = findOriginal(game, known);
  if (original) {
    await deps.store.recordDuplicate(game.id, original);
    report.duplicates[game.id] = original;
    return;
  }
  const existing = await deps.store.getSourceGame(game.id);
  await deps.store.upsertSourceGame(game, sourceKey);
  const key = duplicateKey(game);
  if (key && !known.has(key)) known.set(key, game.id);
  if (existing) {
    report.updatedGames.push(game.id);
    return;
  }
  report.newGames.push(game.id);
  const state = initialOperatorState(game, deps.now());
  await deps.store.writeOperatorState(state, { gameId: game.id, actor: INGEST_ACTOR, action: "create_game", before: null, after: state, reason: `first seen in ${sourceKey}` });
}

async function readFeed(object: ObjectSummary, deps: IngestDeps) {
  const records = JSON.parse((await deps.objects.get(object.key)).toString("utf8")) as unknown;
  if (!Array.isArray(records)) throw new Error(`${object.key}: feed is not a JSON array`);
  return records.map((record) => ({ ...normaliseFeedRecord(record), sourceKey: object.key }));
}

/**
 * Ingests one drop: every unprocessed feed file sharing a date. Records are taken in game-id order across
 * suppliers, so when two suppliers list the same game in one drop the lower (earlier-registered) id is the original.
 */
async function ingestDrop(objects: ObjectSummary[], deps: IngestDeps, known: Map<string, string>, report: IngestReport) {
  const records = (await Promise.all(objects.map((o) => readFeed(o, deps)))).flat();
  for (const { game, unparsed, sourceKey } of records.sort((a, b) => a.game.id.localeCompare(b.game.id))) {
    if (unparsed.length) report.unparsed[game.id] = unparsed;
    await ingestGame(game, sourceKey, deps, known, report);
  }
  for (const o of objects) {
    await deps.store.markProcessed(o.key, o.etag);
    report.feedsProcessed.push(o.key);
  }
}

// ---------- Documents ----------

const META_SUFFIX = ".meta.json";

/** "incoming/documents/G/D.html" → "incoming/documents/G/D.meta.json". */
export const metaKeyFor = (contentKey: string) => contentKey.replace(/\.[^./]+$/, META_SUFFIX);

/** A document is reprocessed if either its content or its sidecar changes. */
const documentEtag = (content: ObjectSummary, meta: ObjectSummary) => createHash("sha256").update(content.etag + meta.etag).digest("hex");

async function ingestDocument(content: ObjectSummary, meta: ObjectSummary, deps: IngestDeps, duplicates: Record<string, string>, report: IngestReport) {
  const parsed = DocumentMeta.parse(JSON.parse((await deps.objects.get(meta.key)).toString("utf8")));
  // A duplicate listing's documents belong to the original game.
  const gameId = duplicates[parsed.gameId] ?? parsed.gameId;
  const raw = (await deps.objects.get(content.key)).toString("utf8");
  await deps.store.upsertDocument({ ...parsed, gameId, rawKey: content.key, text: deps.normaliseText(raw, parsed.format) });
  if (!(await deps.store.getSourceGame(gameId))) report.orphanDocuments.push(parsed.docId);
  report.documentsProcessed.push(content.key);
}

/** Pairs each document with its sidecar; content without a sidecar waits until the sidecar lands. */
export function pairDocuments(objects: ObjectSummary[]): { content: ObjectSummary; meta: ObjectSummary }[] {
  const byKey = new Map(objects.map((o) => [o.key, o]));
  return objects
    .filter((o) => !o.key.endsWith(META_SUFFIX))
    .flatMap((content) => {
      const meta = byKey.get(metaKeyFor(content.key));
      return meta ? [{ content, meta }] : [];
    });
}

// ---------- Run ----------

const fileName = (key: string) => key.slice(key.lastIndexOf("/") + 1);

/**
 * Feeds in drop order (their date-named file), then by key. Listing order alone would process one supplier's
 * newer drop before another's older one, and the first listing seen is the one a duplicate is matched to.
 */
export const inDropOrder = (objects: ObjectSummary[]) =>
  [...objects].sort((a, b) => fileName(a.key).localeCompare(fileName(b.key)) || a.key.localeCompare(b.key));

async function ingestFeeds(deps: IngestDeps, report: IngestReport) {
  const known = await knownGameKeys(deps.store);
  const pending: ObjectSummary[] = [];
  for (const object of inDropOrder(await deps.objects.list(BUCKET_PREFIX.feeds))) {
    if (!(await deps.store.hasProcessed(object.key, object.etag))) pending.push(object);
  }
  for (const drop of Map.groupBy(pending, (o) => fileName(o.key)).values()) await ingestDrop(drop, deps, known, report);
}

async function ingestDocuments(deps: IngestDeps, report: IngestReport) {
  const duplicates = await deps.store.listDuplicates();
  for (const { content, meta } of pairDocuments(await deps.objects.list(BUCKET_PREFIX.documents))) {
    const etag = documentEtag(content, meta);
    if (await deps.store.hasProcessed(content.key, etag)) continue;
    await ingestDocument(content, meta, deps, duplicates, report);
    await deps.store.markProcessed(content.key, etag);
  }
}

export async function ingest(deps: IngestDeps): Promise<IngestReport> {
  const report = emptyReport();
  await ingestFeeds(deps, report);
  await ingestDocuments(deps, report);
  return report;
}

export function summarise(report: IngestReport) {
  return {
    feeds: report.feedsProcessed.length,
    documents: report.documentsProcessed.length,
    newGames: report.newGames.length,
    updatedGames: report.updatedGames.length,
    duplicates: Object.keys(report.duplicates).length,
    gamesWithUnparsedValues: Object.keys(report.unparsed).length,
    orphanDocuments: report.orphanDocuments.length,
  };
}

export async function run(argv: readonly string[], normaliseText: NormaliseText = identityText): Promise<IngestReport> {
  const dbPath = argValue(argv, "--db", DEFAULT_DB_PATH);
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const store = new SqliteCatalogueStore(dbPath);
  try {
    const report = await ingest({ objects: new LocalObjectStore(argValue(argv, "--bucket", DEFAULT_BUCKET_DIR)), store, normaliseText, now: () => new Date().toISOString() });
    console.log("ingest", summarise(report));
    return report;
  } finally {
    await store.close();
  }
}

if (isMain(import.meta.url)) await run(process.argv);
