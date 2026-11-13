import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceGame } from "../catalogue/schema.ts";
import type { EmbeddingRecord, NormalisedDocument } from "../contracts/storage.ts";
import { groundTruthAsEnriched, operatorStateFrom } from "../testing/fixtures.ts";
import { SqliteCatalogueStore } from "./sqlite-catalogue-store.ts";

const stores: SqliteCatalogueStore[] = [];
const open = (path = ":memory:") => {
  const s = new SqliteCatalogueStore(path, { now: () => "2026-11-13T12:00:00.000Z" });
  stores.push(s);
  return s;
};
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => {});
});

const source: SourceGame = {
  id: "BLY-SLT-0001",
  name: "Lantern League",
  supplierGameCode: "LUC1234",
  studio: "Lucky Lantern",
  supplyChannel: "aggregator",
  familyId: null,
  familyRole: null,
  licensedIp: null,
  brands: ["jackpotjoy"],
  jurisdictions: ["GB"],
  status: "live",
  releaseDate: "2024-03-12",
  rgFlags: [],
  feedValues: { rtp: 0.9612 },
};

const doc: NormalisedDocument = {
  docId: "BLY-SLT-0001-rules_text",
  gameId: "BLY-SLT-0001",
  kind: "rules_text",
  format: "cms_html",
  contentType: "text/html",
  source: "Spinlane Hub / Lucky Lantern",
  receivedAt: "2024-03-01",
  rawKey: "incoming/documents/BLY-SLT-0001/BLY-SLT-0001-rules_text.html",
  text: "The theoretical RTP of this game is 96.12%.",
};

describe("SqliteCatalogueStore", () => {
  it("tracks processed objects per key and etag", async () => {
    const s = open();
    expect(await s.hasProcessed("k", "e1")).toBe(false);
    await s.markProcessed("k", "e1");
    await s.markProcessed("k", "e1");
    expect(await s.hasProcessed("k", "e1")).toBe(true);
    expect(await s.hasProcessed("k", "e2")).toBe(false);
  });

  it("upserts and reads source games and documents", async () => {
    const s = open();
    await s.upsertSourceGame(source, "feed-1");
    await s.upsertSourceGame({ ...source, name: "Renamed" }, "feed-2");
    expect(await s.getSourceGame(source.id)).toMatchObject({ name: "Renamed" });
    expect(await s.getSourceGame("missing")).toBeNull();
    expect(await s.listSourceGames()).toHaveLength(1);

    await s.upsertDocument(doc);
    await s.upsertDocument({ ...doc, text: "updated" });
    expect(await s.listDocuments(source.id)).toEqual([{ ...doc, text: "updated" }]);
    expect(await s.listDocuments("other")).toEqual([]);
  });

  it("rejects invalid entities at the edge", async () => {
    await expect(open().upsertSourceGame({ ...source, status: "maybe" as never }, "k")).rejects.toThrow();
  });

  it("saves and reads enrichments and embeddings", async () => {
    const s = open();
    const [game] = groundTruthAsEnriched();
    await s.saveEnrichment(game!);
    expect(await s.getEnrichment(game!.id)).toEqual(game);
    expect(await s.getEnrichment("missing")).toBeNull();
    expect(await s.listEnrichments()).toHaveLength(1);

    const rec: EmbeddingRecord = { gameId: game!.id, model: "m", aspect: "content", profileText: "p", inputHash: "h", vector: [0.6, 0.8] };
    await s.saveEmbeddings([rec, { ...rec, aspect: "gameplay" }, { ...rec, model: "other" }]);
    await s.saveEmbeddings([{ ...rec, vector: [1, 0] }]);
    const listed = await s.listEmbeddings("m");
    expect(listed.map((r) => r.aspect)).toEqual(["content", "gameplay"]);
    expect(listed[0]!.vector).toEqual([1, 0]);
  });

  it("writes operator state and its audit entry together", async () => {
    const s = open();
    const state = operatorStateFrom(groundTruthAsEnriched()[0]!);
    const entry = await s.writeOperatorState(state, { gameId: state.gameId, actor: "admin", action: "update_operator_fields", before: null, after: { status: "live" }, reason: "initial" });
    expect(entry).toMatchObject({ id: 1, actor: "admin", at: "2026-11-13T12:00:00.000Z", after: { status: "live" }, reason: "initial" });

    await s.writeOperatorState({ ...state, status: "suspended" }, { gameId: state.gameId, actor: "admin", action: "update_operator_fields", before: { status: "live" }, after: { status: "suspended" }, reason: "compliance" });
    expect((await s.getOperatorState(state.gameId))!.status).toBe("suspended");
    expect((await s.listAudit(state.gameId)).map((a) => a.reason)).toEqual(["initial", "compliance"]);
    expect(await s.listOperatorStates()).toHaveLength(1);
    expect(await s.getOperatorState("missing")).toBeNull();
  });

  it("rolls back the state write when the audit entry is inconsistent", async () => {
    const s = open();
    const state = operatorStateFrom(groundTruthAsEnriched()[0]!);
    await expect(s.writeOperatorState(state, { gameId: "other", actor: "admin", action: "retire", before: null, after: null, reason: null })).rejects.toThrow(/audit is for/);
    await expect(s.writeOperatorState({ ...state, status: "bad" as never }, { gameId: state.gameId, actor: "a", action: "retire", before: null, after: null, reason: null })).rejects.toThrow();
    expect(await s.getOperatorState(state.gameId)).toBeNull();
    expect(await s.listAudit(state.gameId)).toEqual([]);
  });

  it("rolls back a failed transaction", async () => {
    const s = open();
    const rec: EmbeddingRecord = { gameId: "g", model: "m", aspect: "content", profileText: "p", inputHash: "h", vector: [1] };
    await expect(s.saveEmbeddings([rec, { ...rec, aspect: "nope" as never }])).rejects.toThrow();
    expect(await s.listEmbeddings("m")).toEqual([]);
  });

  it("publishes index versions and returns the latest", async () => {
    const s = open();
    expect(await s.currentIndex()).toBeNull();
    await s.publishIndex({ version: "v1", createdAt: "t1", embeddingModel: "m", gameCount: 100 });
    await s.publishIndex({ version: "v2", createdAt: "t2", embeddingModel: "m", gameCount: 110 });
    expect((await s.currentIndex())!.version).toBe("v2");
  });

  it("records duplicate listings", async () => {
    const s = open();
    await s.recordDuplicate("BLY-SLT-9001", "BLY-SLT-0069");
    expect(await s.listDuplicates()).toEqual({ "BLY-SLT-9001": "BLY-SLT-0069" });
  });

  it("persists to a file across connections", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "store-")), "catalogue.sqlite");
    const a = open(path);
    await a.upsertSourceGame(source, "feed-1");
    await a.close();
    expect(await open(path).getSourceGame(source.id)).toMatchObject({ id: source.id });
  });
});
