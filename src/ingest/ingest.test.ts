import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bucketObjects, Holdback, HOLDBACK_PATH, loadInputs, writeObjects } from "../../scripts/bucket/build.ts";
import { readFileSync } from "node:fs";
import type { SourceGame } from "../catalogue/schema.ts";
import { LocalObjectStore } from "../storage/local-object-store.ts";
import { SqliteCatalogueStore } from "../storage/sqlite-catalogue-store.ts";
import { findOriginal, identityText, inDropOrder, ingest, initialOperatorState, metaKeyFor, pairDocuments, run, summarise, type IngestDeps } from "./ingest.ts";

const inputs = loadInputs();
const holdback = Holdback.parse(JSON.parse(readFileSync(HOLDBACK_PATH, "utf8")));
const stores: SqliteCatalogueStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function setup(stage: "initial" | "all" = "all") {
  const objects = new LocalObjectStore(mkdtempSync(join(tmpdir(), "ingest-bucket-")));
  await writeObjects(bucketObjects(inputs.feed, inputs.docs, inputs.plan, holdback, stage), objects);
  const store = new SqliteCatalogueStore(":memory:", { now: () => "2026-11-13T00:00:00.000Z" });
  stores.push(store);
  const deps: IngestDeps = { objects, store, normaliseText: identityText, now: () => "2026-11-13T00:00:00.000Z" };
  return { objects, store, deps };
}

describe("ingest", () => {
  it("loads every game and document once, detecting the planned duplicates", async () => {
    const { store, deps } = await setup();
    const report = await ingest(deps);
    expect(report.newGames).toHaveLength(100);
    expect(report.duplicates).toEqual(JSON.parse(readFileSync("data/catalogue/manifest.json", "utf8")).duplicates);
    expect(await store.listSourceGames()).toHaveLength(100);
    expect(report.documentsProcessed).toHaveLength(inputs.docs.length);
    expect(report.orphanDocuments).toEqual([]);
  });

  it("is idempotent: a second run does nothing", async () => {
    const { deps } = await setup();
    await ingest(deps);
    expect(summarise(await ingest(deps))).toEqual({ feeds: 0, documents: 0, newGames: 0, updatedGames: 0, duplicates: 0, gamesWithUnparsedValues: 0, orphanDocuments: 0 });
  });

  it("picks up only the update drop after the initial one", async () => {
    const { objects, store, deps } = await setup("initial");
    const first = await ingest(deps);
    expect(first.newGames).toHaveLength(100 - holdback.newTitles.length);

    await writeObjects(bucketObjects(inputs.feed, inputs.docs, inputs.plan, holdback, "update"), objects);
    const second = await ingest(deps);
    expect(second.newGames.sort()).toEqual(holdback.newTitles);
    expect(second.updatedGames).toEqual([holdback.rtpChange.gameId]);
    expect((await store.getSourceGame(holdback.rtpChange.gameId))!.feedValues.rtp).toBe(holdback.rtpChange.toRtp);
    expect(second.documentsProcessed.some((k) => k.includes(holdback.lateDocument.docId))).toBe(true);
  });

  it("initialises operator state on first sight with an audit entry, and leaves it alone on updates", async () => {
    const { objects, store, deps } = await setup("initial");
    await ingest(deps);
    const id = holdback.rtpChange.gameId;
    expect((await store.getOperatorState(id))!.status).toBe("live");
    expect(await store.listAudit(id)).toEqual([expect.objectContaining({ actor: "ingest", action: "create_game" })]);

    await writeObjects(bucketObjects(inputs.feed, inputs.docs, inputs.plan, holdback, "update"), objects);
    await ingest(deps);
    expect(await store.listAudit(id)).toHaveLength(1);
  });

  it("attaches a duplicate listing's documents to the original game", async () => {
    const { store, deps } = await setup();
    const report = await ingest(deps);
    const [dupId, originalId] = Object.entries(report.duplicates)[0]!;
    const docs = await store.listDocuments(originalId);
    expect(docs.some((d) => d.docId.startsWith(dupId))).toBe(true);
  });

  it("passes document text through the injected normaliser", async () => {
    const { store, deps } = await setup();
    await ingest({ ...deps, normaliseText: (raw, format) => `${format}:${raw.length}` });
    const [doc] = await store.listDocuments(inputs.docs[0]!.gameId);
    expect(doc!.text).toMatch(/^[a-z_]+:\d+$/);
  });

  it("rejects a feed that isn't an array", async () => {
    const { objects, deps } = await setup("initial");
    await objects.put("incoming/feeds/bad/2026-11-14.json", "{}");
    await expect(ingest(deps)).rejects.toThrow(/not a JSON array/);
  });

  it("holds a document whose game hasn't arrived yet", async () => {
    const objects = new LocalObjectStore(mkdtempSync(join(tmpdir(), "orphan-")));
    const doc = inputs.docs[0]!;
    await objects.put(`incoming/documents/${doc.gameId}/${doc.docId}.html`, doc.text);
    await objects.put(`incoming/documents/${doc.gameId}/${doc.docId}.meta.json`, JSON.stringify({ ...doc, text: undefined }));
    const store = new SqliteCatalogueStore();
    stores.push(store);
    const report = await ingest({ objects, store, normaliseText: identityText, now: () => "t" });
    expect(report.orphanDocuments).toEqual([doc.docId]);
    expect(await store.listDocuments(doc.gameId)).toHaveLength(1);
  });
});

describe("helpers", () => {
  const game = (over: Partial<SourceGame>): SourceGame => ({
    id: "A", name: "Pharaoh's Vault", supplierGameCode: "SAN1", studio: null, supplyChannel: null, familyId: null, familyRole: null, licensedIp: null,
    brands: [], jurisdictions: [], status: null, releaseDate: null, rgFlags: [], feedValues: {}, ...over,
  });

  it("matches duplicates on supplier code and name, never on id alone", () => {
    const known = new Map([["SAN1|pharaohsvault", "A"]]);
    expect(findOriginal(game({ id: "B", name: "PHARAOHS VAULT™" }), known)).toBe("A");
    expect(findOriginal(game({ id: "A" }), known)).toBeNull();
    expect(findOriginal(game({ id: "B", supplierGameCode: null }), known)).toBeNull();
    expect(findOriginal(game({ id: "B", name: "Other" }), known)).toBeNull();
  });

  it("starts games with unknown status suspended", () => {
    expect(initialOperatorState(game({}), "t").status).toBe("suspended");
    expect(initialOperatorState(game({ status: "live" }), "t").status).toBe("live");
  });

  it("orders feeds by drop date, then key", () => {
    const o = (key: string) => ({ key, etag: "", lastModified: "" });
    expect(inDropOrder([o("f/b/2026-11-13.json"), o("f/a/2026-11-13.json"), o("f/z/2026-11-10.json")]).map((x) => x.key)).toEqual([
      "f/z/2026-11-10.json",
      "f/a/2026-11-13.json",
      "f/b/2026-11-13.json",
    ]);
  });

  it("pairs documents with sidecars and skips unpaired content", () => {
    const o = (key: string) => ({ key, etag: "", lastModified: "" });
    expect(metaKeyFor("d/G/D.html")).toBe("d/G/D.meta.json");
    expect(pairDocuments([o("d/G/D.html"), o("d/G/D.meta.json"), o("d/G/E.xml")]).map((p) => p.content.key)).toEqual(["d/G/D.html"]);
  });
});

describe("run", () => {
  it("ingests a bucket into a SQLite file", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "ingest-run-"));
    await writeObjects(bucketObjects(inputs.feed, inputs.docs, inputs.plan, holdback, "initial"), new LocalObjectStore(join(dir, "bucket")));
    const report = await run(["--bucket", join(dir, "bucket"), "--db", join(dir, "db", "catalogue.sqlite")]);
    expect(report.newGames).toHaveLength(90);
    expect((await run(["--bucket", join(dir, "bucket"), "--db", ":memory:"])).newGames).toHaveLength(90);
  });
});
