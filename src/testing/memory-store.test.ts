import { describe, expect, it } from "vitest";
import type { SourceGame } from "../catalogue/schema.ts";
import { groundTruthAsEnriched, operatorStateFrom } from "./fixtures.ts";
import { MemoryCatalogueStore, MemoryObjectStore } from "./memory-store.ts";
import { testEmbeddings, testIndex } from "./service-fixtures.ts";

const game = groundTruthAsEnriched()[0]!;

describe("MemoryCatalogueStore", () => {
  it("tracks processed objects per key and etag", async () => {
    const s = new MemoryCatalogueStore();
    await s.markProcessed("k", "e1");
    expect(await s.hasProcessed("k", "e1")).toBe(true);
    expect(await s.hasProcessed("k", "e2")).toBe(false);
  });

  it("stores source games and documents", async () => {
    const s = new MemoryCatalogueStore();
    const source = { id: game.id, name: game.name } as SourceGame;
    await s.upsertSourceGame(source, "key");
    expect(await s.getSourceGame(game.id)).toEqual(source);
    expect(await s.getSourceGame("nope")).toBeNull();
    expect(await s.listSourceGames()).toHaveLength(1);
    const doc = { docId: "d1", gameId: game.id, kind: "rules_text", format: "cms_html", contentType: "text/html", source: "s", receivedAt: "2026-01-01", rawKey: "r", text: "t" } as const;
    await s.upsertDocument(doc);
    expect(await s.listDocuments(game.id)).toEqual([doc]);
    expect(await s.listDocuments("other")).toEqual([]);
  });

  it("stores enrichments and embeddings by model", async () => {
    const s = new MemoryCatalogueStore();
    await s.saveEnrichment(game);
    expect((await s.getEnrichment(game.id))!.name).toBe(game.name);
    expect(await s.getEnrichment("nope")).toBeNull();
    await s.saveEmbeddings(testEmbeddings([game], "m1"));
    expect(await s.listEmbeddings("m1")).toHaveLength(3);
    expect(await s.listEmbeddings("m2")).toHaveLength(0);
  });

  it("writes operator state with an incrementing audit trail and returns copies", async () => {
    const s = new MemoryCatalogueStore();
    const state = operatorStateFrom(game);
    const a1 = await s.writeOperatorState(state, { gameId: game.id, actor: "admin", action: "retire", before: 1, after: 2, reason: "r" });
    const a2 = await s.writeOperatorState({ ...state, status: "retired" }, { gameId: game.id, actor: "admin", action: "retire", before: 2, after: 3, reason: null });
    expect([a1.id, a2.id]).toEqual([1, 2]);
    expect((await s.getOperatorState(game.id))!.status).toBe("retired");
    expect(await s.getOperatorState("nope")).toBeNull();
    expect(await s.listAudit(game.id)).toHaveLength(2);
    const copy = (await s.listOperatorStates())[0]!;
    copy.status = "live";
    expect((await s.getOperatorState(game.id))!.status).toBe("retired");
  });

  it("returns the most recently published index", async () => {
    const s = new MemoryCatalogueStore();
    expect(await s.currentIndex()).toBeNull();
    await s.publishIndex(testIndex("v1", 1));
    await s.publishIndex(testIndex("v2", 1));
    expect((await s.currentIndex())!.version).toBe("v2");
    await s.close();
  });
});

describe("MemoryObjectStore", () => {
  it("lists by prefix in key order and round-trips bodies with an etag", async () => {
    const o = new MemoryObjectStore();
    await o.put("a/2.json", "two");
    const one = await o.put("a/1.json", Buffer.from("one"));
    await o.put("b/1.json", "x");
    expect((await o.list("a/")).map((x) => x.key)).toEqual(["a/1.json", "a/2.json"]);
    expect((await o.get("a/1.json")).toString()).toBe("one");
    expect(one.etag).toMatch(/^[0-9a-f]{32}$/);
    await expect(o.get("missing")).rejects.toThrow(/NoSuchKey/);
  });
});
