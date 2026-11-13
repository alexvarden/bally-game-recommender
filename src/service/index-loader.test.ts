import { describe, expect, it, vi } from "vitest";
import { groundTruthAsEnriched, operatorStateFrom } from "../testing/fixtures.ts";
import { seededStore, silentLogger, stubRankerFactory, testEmbeddings, testIndex } from "../testing/service-fixtures.ts";
import { buildSnapshot, IndexLoader, SnapshotError } from "./index-loader.ts";

const games = groundTruthAsEnriched().slice(0, 5);
const ranker = stubRankerFactory();

describe("buildSnapshot", () => {
  it("joins enrichments with their three aspect vectors", () => {
    const snap = buildSnapshot(testIndex("v1", 5), games, testEmbeddings(games), ranker);
    expect(snap.games).toHaveLength(5);
    expect(snap.byId.get(games[0]!.id)!.vectors.content).toHaveLength(3);
  });

  it("ignores vectors from another model and games missing an aspect", () => {
    const embeddings = [...testEmbeddings(games).filter((e) => !(e.gameId === games[0]!.id && e.aspect === "experience")), ...testEmbeddings(games, "other")];
    expect(buildSnapshot(testIndex("v1", 4), games, embeddings, ranker).games).toHaveLength(4);
  });

  it("rejects an empty index, a game-count mismatch and mixed dimensions", () => {
    expect(() => buildSnapshot(testIndex("v1", 5), games, [], ranker)).toThrow(SnapshotError);
    expect(() => buildSnapshot(testIndex("v1", 6), games, testEmbeddings(games), ranker)).toThrow(/promised 6/);
    const mixed = [...testEmbeddings(games.slice(0, 2), undefined, 3), ...testEmbeddings(games.slice(2), undefined, 4)];
    expect(() => buildSnapshot(testIndex("v1", 5), games, mixed, ranker)).toThrow(/dimensions/);
    const empty = testEmbeddings(games, undefined, 0);
    expect(() => buildSnapshot(testIndex("v1", 5), games, empty, ranker)).toThrow(/empty vectors/);
  });
});

describe("IndexLoader", () => {
  const loaderFor = async () => {
    const { store } = await seededStore(games);
    const logger = silentLogger();
    return { store, logger, loader: new IndexLoader({ store, rankerFactory: ranker, logger, pollMs: 10 }) };
  };

  it("has nothing until refreshed, then serves the published index with operator state", async () => {
    const { loader } = await loaderFor();
    expect(loader.current()).toBeNull();
    expect(await loader.refresh()).toBe(true);
    expect(loader.current()!.index.version).toBe("v1");
    expect(loader.operatorStates().get(games[0]!.id)!.status).toBe("live");
    expect(await loader.refresh()).toBe(false);
  });

  it("does nothing when no index has been published", async () => {
    const logger = silentLogger();
    const { MemoryCatalogueStore } = await import("../testing/memory-store.ts");
    const loader = new IndexLoader({ store: new MemoryCatalogueStore(), rankerFactory: ranker, logger });
    expect(await loader.refresh()).toBe(false);
  });

  it("swaps atomically to a new valid version", async () => {
    const { store, loader } = await loaderFor();
    await loader.refresh();
    const before = loader.current();
    await store.publishIndex(testIndex("v2", 5));
    expect(await loader.refresh()).toBe(true);
    expect(loader.current()!.index.version).toBe("v2");
    expect(loader.current()).not.toBe(before);
  });

  it("keeps serving the old version when the new one fails validation, and logs it", async () => {
    const { store, loader, logger } = await loaderFor();
    const error = vi.spyOn(logger, "error");
    await loader.refresh();
    await store.publishIndex(testIndex("v2-broken", 99));
    expect(await loader.refresh()).toBe(false);
    expect(loader.current()!.index.version).toBe("v1");
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ indexVersion: "v2-broken", serving: "v1" }), expect.stringContaining("rejected"));
  });

  it("refreshes operator state on demand", async () => {
    const { store, loader } = await loaderFor();
    await loader.refresh();
    const g = games[1]!;
    await store.writeOperatorState({ ...operatorStateFrom(g), status: "suspended" }, { gameId: g.id, actor: "admin", action: "update_operator_fields", before: null, after: null, reason: "test" });
    expect(loader.operatorStates().get(g.id)!.status).toBe("live");
    await loader.refreshOperatorStates();
    expect(loader.operatorStates().get(g.id)!.status).toBe("suspended");
  });

  it("polls for new versions until stopped", async () => {
    vi.useFakeTimers();
    try {
      const { store, loader } = await loaderFor();
      loader.start();
      await vi.advanceTimersByTimeAsync(15);
      expect(loader.current()!.index.version).toBe("v1");
      await store.publishIndex(testIndex("v2", 5));
      await vi.advanceTimersByTimeAsync(15);
      expect(loader.current()!.index.version).toBe("v2");
      loader.stop();
      await store.publishIndex(testIndex("v3", 5));
      await vi.advanceTimersByTimeAsync(50);
      expect(loader.current()!.index.version).toBe("v2");
    } finally {
      vi.useRealTimers();
    }
  });
});
