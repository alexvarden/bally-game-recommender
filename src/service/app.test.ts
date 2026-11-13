import { describe, expect, it, vi } from "vitest";
import { RecommendationResponse } from "../contracts/ranking.ts";
import { MemoryCatalogueStore } from "../testing/memory-store.ts";
import { seededStore, silentLogger, stubRankerFactory, type StubRankerOptions } from "../testing/service-fixtures.ts";
import { buildPublicApp } from "./app.ts";
import { IndexLoader } from "./index-loader.ts";
import { fallbackList, isServable } from "./recommend.ts";

async function setup(ranker: StubRankerOptions = {}) {
  const { store, games } = await seededStore();
  const logger = silentLogger();
  const loader = new IndexLoader({ store, rankerFactory: stubRankerFactory(ranker), logger });
  await loader.refresh();
  return { app: buildPublicApp({ loader, logger }), store, games, loader, logger };
}

const liveOn = (games: Awaited<ReturnType<typeof setup>>["games"], brand: string) => games.filter((g) => g.status === "live" && g.brands.includes(brand as never));

const get = async (app: ReturnType<typeof buildPublicApp>, url: string) => {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() };
};

describe("GET /v1/brands/:brand/games/:gameId/recommendations", () => {
  it("returns ranked, servable games for the brand", async () => {
    const { app, games } = await setup();
    const seed = liveOn(games, "jackpotjoy")[0]!;
    const { status, body } = await get(app, `/v1/brands/jackpotjoy/games/${seed.id}/recommendations`);
    expect(status).toBe(200);
    const res = RecommendationResponse.parse(body);
    expect(res).toMatchObject({ brand: "jackpotjoy", gameId: seed.id, indexVersion: "v1", fallback: false, reason: null });
    expect(res.items).toHaveLength(6);
    const byId = new Map(games.map((g) => [g.id, g]));
    for (const item of res.items) {
      expect(item.gameId).not.toBe(seed.id);
      expect(byId.get(item.gameId)!.brands).toContain("jackpotjoy");
      expect(byId.get(item.gameId)!.status).toBe("live");
    }
  });

  it("filters games the ranker returns that aren't servable (defence in depth)", async () => {
    // The stub ranker ignores brand and status, so everything off-brand or not live must be removed by the service.
    const { app, games } = await setup();
    const seed = liveOn(games, "bally_casino_us")[0]!;
    const { body } = await get(app, `/v1/brands/bally_casino_us/games/${seed.id}/recommendations?limit=20`);
    const byId = new Map(games.map((g) => [g.id, g]));
    for (const item of body.items) expect(byId.get(item.gameId)!.brands).toContain("bally_casino_us");
  });

  it("respects the limit and rejects bad limits", async () => {
    const { app, games } = await setup();
    const seed = liveOn(games, "jackpotjoy")[0]!;
    expect((await get(app, `/v1/brands/jackpotjoy/games/${seed.id}/recommendations?limit=3`)).body.items).toHaveLength(3);
    expect((await get(app, `/v1/brands/jackpotjoy/games/${seed.id}/recommendations?limit=0`)).status).toBe(400);
    expect((await get(app, `/v1/brands/jackpotjoy/games/${seed.id}/recommendations?limit=21`)).status).toBe(400);
    expect((await get(app, `/v1/brands/jackpotjoy/games/${seed.id}/recommendations?limit=abc`)).status).toBe(400);
  });

  it("returns 404 for an unknown brand", async () => {
    const { app } = await setup();
    expect((await get(app, "/v1/brands/acme/games/BLY-SLT-0001/recommendations")).status).toBe(404);
  });

  it("falls back for an unknown game, without an error", async () => {
    const { app } = await setup();
    const { status, body } = await get(app, "/v1/brands/jackpotjoy/games/NOPE/recommendations");
    expect(status).toBe(200);
    expect(body).toMatchObject({ fallback: true, reason: "unknown_game" });
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i: { fallback: boolean; score: null }) => i.fallback && i.score === null)).toBe(true);
  });

  it("falls back when the seed isn't live on the brand", async () => {
    const { app, games } = await setup();
    const offBrand = games.find((g) => !g.brands.includes("double_bubble_bingo") && g.status === "live")!;
    expect((await get(app, `/v1/brands/double_bubble_bingo/games/${offBrand.id}/recommendations`)).body).toMatchObject({ fallback: true, reason: "seed_unavailable" });
  });

  it("tops up from the fallback list when the ranker comes back short, and says why", async () => {
    const { app, games } = await setup({ maxItems: 2 });
    const seed = liveOn(games, "jackpotjoy")[0]!;
    const { body } = await get(app, `/v1/brands/jackpotjoy/games/${seed.id}/recommendations`);
    expect(body).toMatchObject({ fallback: true, reason: "below_floor" });
    expect(body.items.filter((i: { fallback: boolean }) => !i.fallback).length).toBeLessThanOrEqual(2);
    expect(new Set(body.items.map((i: { gameId: string }) => i.gameId)).size).toBe(body.items.length);
  });

  it("passes the ranker's own reason through", async () => {
    const { app, games } = await setup({ maxItems: 0, reason: "thin_seed" });
    const seed = liveOn(games, "jackpotjoy")[0]!;
    expect((await get(app, `/v1/brands/jackpotjoy/games/${seed.id}/recommendations`)).body.reason).toBe("thin_seed");
  });

  it("logs one structured line per request", async () => {
    const { app, games, logger } = await setup();
    const info = vi.spyOn(logger, "info");
    const seed = liveOn(games, "jackpotjoy")[0]!;
    await get(app, `/v1/brands/jackpotjoy/games/${seed.id}/recommendations`);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ brand: "jackpotjoy", gameId: seed.id, indexVersion: "v1", fallbackReason: null, latencyMs: expect.any(Number) }), "recommendation");
  });
});

describe("health and readiness", () => {
  it("is ready only once an index is loaded", async () => {
    const logger = silentLogger();
    const loader = new IndexLoader({ store: new MemoryCatalogueStore(), rankerFactory: stubRankerFactory(), logger });
    const empty = buildPublicApp({ loader, logger });
    expect((await get(empty, "/healthz")).status).toBe(200);
    expect((await get(empty, "/readyz")).status).toBe(503);
    expect((await get(empty, "/v1/brands/jackpotjoy/games/BLY-SLT-0001/recommendations")).body).toMatchObject({ fallback: true, reason: "index_unavailable", items: [] });

    const { app } = await setup();
    expect((await get(app, "/readyz")).body).toEqual({ ready: true, indexVersion: "v1" });
  });
});

describe("fallbackList", () => {
  it("lists newest live in-house games on the brand", async () => {
    const { games, loader } = await setup();
    const list = fallbackList(games, "jackpotjoy", loader.operatorStates());
    expect(list.length).toBeGreaterThan(0);
    for (const g of list) expect(g.supplyChannel).toBe("in_house");
    const dates = list.map((g) => g.releaseDate!);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("treats unknown or quarantined state as not servable", async () => {
    const { games, loader } = await setup();
    const state = loader.operatorStates().get(games[0]!.id)!;
    expect(isServable(undefined, "jackpotjoy")).toBe(false);
    expect(isServable({ ...state, quarantined: true }, state.brands[0]!)).toBe(false);
  });
});
