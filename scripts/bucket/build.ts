/**
 * Builds the S3-style bucket (var/bucket/) from the committed catalogue, in two drops:
 *
 *   initial  most of the catalogue, as the supplier feeds and documents that were already there
 *   update   ~10 new titles, an RTP change on an existing game, and a late document for an existing game
 *
 * The seed step ingests the initial drop; the update drop is left unprocessed to demonstrate the pipeline. Which
 * games are held back is decided here and committed in data/catalogue/holdback.json so every step agrees.
 *
 * Usage: node scripts/bucket/build.ts [--stage initial|update|all] [--bucket var/bucket] [--write-holdback]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { GameDocument, RawFeedRecord } from "../../src/catalogue/schema.ts";
import { BUCKET_PREFIX, type DocumentMeta, type ObjectStore } from "../../src/contracts/storage.ts";
import { argValue, hasFlag, isMain } from "../../src/lib/cli.ts";
import { mulberry32, sample } from "../../src/lib/random.ts";
import { DEFAULT_BUCKET_DIR, LocalObjectStore } from "../../src/storage/local-object-store.ts";
import { Plan, PLAN_PATH, type PlannedGame } from "../catalogue/plan.ts";

export const HOLDBACK_PATH = "data/catalogue/holdback.json";
const FEED_PATH = "data/catalogue/catalogue.raw.json";
const DOCUMENTS_PATH = "data/catalogue/documents.json";
const HOLDBACK_SEED = 11;
const NEW_TITLE_COUNT = 10;

export const Holdback = z.object({
  dates: z.object({ initial: z.string(), update: z.string() }),
  /** Games that only arrive in the update drop. */
  newTitles: z.array(z.string()),
  /** An existing game whose supplier re-certified it at a different RTP. Its rules text still states the old one. */
  rtpChange: z.object({ gameId: z.string(), fromRtp: z.number(), toRtp: z.number() }),
  /** A document for an existing game that arrives after the game itself. */
  lateDocument: z.object({ docId: z.string(), gameId: z.string() }),
});
export type Holdback = z.infer<typeof Holdback>;

export type Stage = "initial" | "update" | "all";

// ---------- Choosing what to hold back ----------

const isStandaloneLive = (p: PlannedGame) => p.status === "live" && !p.familyId && !p.defects.includes("duplicate_listing");

/** New titles: two planted-defect games (so the demo exercises them) plus a seeded sample of clean ones. */
export function chooseNewTitles(plan: Plan, seed = HOLDBACK_SEED): string[] {
  const candidates = plan.games.filter(isStandaloneLive);
  const withDefect = (d: string) => candidates.find((p) => p.defects.includes(d as never))!;
  const planted = [withDefect("wrong_game_rules"), withDefect("volatility_conflict")];
  const relatedIds = new Set(plan.games.map((p) => p.relatedGameId).filter(Boolean));
  const clean = candidates.filter((p) => p.defects.length === 0 && !relatedIds.has(p.id));
  return [...planted, ...sample(mulberry32(seed), clean, NEW_TITLE_COUNT - planted.length)].map((p) => p.id).sort();
}

export function chooseHoldback(plan: Plan, docs: GameDocument[]): Holdback {
  const newTitles = chooseNewTitles(plan);
  const held = new Set(newTitles);
  // Games another game's defect points at are left alone, so each demo case has one cause.
  const related = new Set(plan.games.map((p) => p.relatedGameId).filter(Boolean));
  const existing = plan.games.filter((p) => isStandaloneLive(p) && !held.has(p.id) && !related.has(p.id) && p.defects.length === 0);
  // In-house games always have rules text stating the RTP, so the change creates a feed/document conflict.
  const rtpGame = existing.find((p) => p.supplyChannel === "in_house")!;
  const lateDoc = docs.find((d) => d.kind !== "rules_text" && existing.some((p) => p.id === d.gameId && p.id !== rtpGame.id && p.documents.length >= 2))!;
  return {
    dates: { initial: "2026-11-10", update: "2026-11-13" },
    newTitles,
    rtpChange: { gameId: rtpGame.id, fromRtp: rtpGame.rtp, toRtp: Math.round((rtpGame.rtp - 0.02) * 10000) / 10000 },
    lateDocument: { docId: lateDoc.docId, gameId: lateDoc.gameId },
  };
}

// ---------- Laying out objects ----------

const EXTENSIONS: Record<GameDocument["format"], string> = { cms_html: "html", aggregator_xml: "xml", markdown: "md", email: "eml", pdf_text: "txt" };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Which supplier feed a record arrives in: its aggregator, or the in-house studio feed. */
export function feedSourceFor(record: RawFeedRecord, plans: ReadonlyMap<string, PlannedGame>): string {
  const p = plans.get(record.id);
  if (p) return slug(p.aggregator ?? "in-house");
  return slug(record.channel ?? "unknown");
}

export interface BucketObject {
  key: string;
  body: string;
}

function feedObjects(records: RawFeedRecord[], plans: ReadonlyMap<string, PlannedGame>, date: string): BucketObject[] {
  const bySource = Map.groupBy(records, (r) => feedSourceFor(r, plans));
  return [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([source, rs]) => ({ key: `${BUCKET_PREFIX.feeds}${source}/${date}.json`, body: JSON.stringify(rs, null, 2) }));
}

function documentObjects(docs: GameDocument[]): BucketObject[] {
  return docs.flatMap((d) => {
    const base = `${BUCKET_PREFIX.documents}${d.gameId}/${d.docId}`;
    const meta: DocumentMeta = { docId: d.docId, gameId: d.gameId, kind: d.kind, format: d.format, contentType: d.contentType, source: d.source, receivedAt: d.receivedAt };
    return [
      { key: `${base}.${EXTENSIONS[d.format]}`, body: d.text },
      { key: `${base}.meta.json`, body: JSON.stringify(meta, null, 2) },
    ];
  });
}

/** Re-states the RTP the way this supplier's feed already formats it, at the new value. */
export function withChangedRtp(record: RawFeedRecord, toRtp: number): RawFeedRecord {
  const pct = (toRtp * 100).toFixed(2);
  return { ...record, rtp: typeof record.rtp === "string" ? `${pct}%` : Number(pct) };
}

export function bucketObjects(feed: RawFeedRecord[], docs: GameDocument[], plan: Plan, holdback: Holdback, stage: Stage): BucketObject[] {
  const plans = new Map(plan.games.map((p) => [p.id, p]));
  const held = new Set(holdback.newTitles);
  const isLate = (d: GameDocument) => d.docId === holdback.lateDocument.docId;
  const initial = [
    ...feedObjects(feed.filter((r) => !held.has(r.id)), plans, holdback.dates.initial),
    ...documentObjects(docs.filter((d) => !held.has(d.gameId) && !isLate(d))),
  ];
  const changed = feed.find((r) => r.id === holdback.rtpChange.gameId)!;
  const update = [
    ...feedObjects([...feed.filter((r) => held.has(r.id)), withChangedRtp(changed, holdback.rtpChange.toRtp)], plans, holdback.dates.update),
    ...documentObjects(docs.filter((d) => held.has(d.gameId) || isLate(d))),
  ];
  return stage === "initial" ? initial : stage === "update" ? update : [...initial, ...update];
}

// ---------- Entry point ----------

export function loadInputs(paths = { feed: FEED_PATH, documents: DOCUMENTS_PATH, plan: PLAN_PATH }) {
  return {
    feed: z.array(RawFeedRecord).parse(JSON.parse(readFileSync(paths.feed, "utf8"))),
    docs: z.array(GameDocument).parse(JSON.parse(readFileSync(paths.documents, "utf8"))),
    plan: Plan.parse(JSON.parse(readFileSync(paths.plan, "utf8"))),
  };
}

export async function writeObjects(objects: BucketObject[], store: ObjectStore) {
  for (const o of objects) await store.put(o.key, o.body);
}

export async function run(argv: readonly string[]) {
  const stage = argValue(argv, "--stage", "all") as Stage;
  if (!["initial", "update", "all"].includes(stage)) throw new Error(`unknown stage ${stage}; expected initial, update or all`);
  const { feed, docs, plan } = loadInputs();
  const holdback = hasFlag(argv, "--write-holdback") ? chooseHoldback(plan, docs) : Holdback.parse(JSON.parse(readFileSync(HOLDBACK_PATH, "utf8")));
  if (hasFlag(argv, "--write-holdback")) writeFileSync(HOLDBACK_PATH, JSON.stringify(holdback, null, 2) + "\n");
  const objects = bucketObjects(feed, docs, plan, holdback, stage);
  await writeObjects(objects, new LocalObjectStore(argValue(argv, "--bucket", DEFAULT_BUCKET_DIR)));
  console.log(`wrote ${objects.length} objects (${stage}) to the bucket`);
  return objects;
}

if (isMain(import.meta.url)) await run(process.argv);
