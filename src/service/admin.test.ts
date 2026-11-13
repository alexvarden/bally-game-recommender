import { describe, expect, it, vi } from "vitest";
import { seededStore, silentLogger, stubRankerFactory } from "../testing/service-fixtures.ts";
import { applyOperatorPatch, buildAdminApp, filterStates, tokenMatches } from "./admin.ts";
import { buildPublicApp } from "./app.ts";
import { IndexLoader } from "./index-loader.ts";

const TOKEN = "test-token-123";
const auth = { authorization: `Bearer ${TOKEN}` };

async function setup() {
  const { store, objects, games } = await seededStore();
  const logger = silentLogger();
  const loader = new IndexLoader({ store, rankerFactory: stubRankerFactory(), logger });
  await loader.refresh();
  const admin = buildAdminApp({ store, objects, loader, logger, token: TOKEN, now: () => new Date("2026-11-13T12:00:00Z") });
  const pub = buildPublicApp({ loader, logger });
  return { admin, pub, store, objects, games, loader, logger };
}

type App = Awaited<ReturnType<typeof setup>>["admin"];
const call = async (app: App, method: "GET" | "PATCH" | "POST", url: string, payload?: object, headers: Record<string, string> = auth) => {
  const res = await app.inject({ method, url, payload, headers });
  return { status: res.statusCode, body: res.headers["content-type"]?.toString().includes("json") ? res.json() : res.body };
};

describe("auth", () => {
  it("requires the bearer token for the API but serves the page without it", async () => {
    const { admin } = await setup();
    expect((await call(admin, "GET", "/admin/games", undefined, {})).status).toBe(401);
    expect((await call(admin, "GET", "/admin/games", undefined, { authorization: "Bearer wrong-token-12" })).status).toBe(401);
    const page = await call(admin, "GET", "/admin/", undefined, {});
    expect(page.status).toBe(200);
    expect(page.body).toContain("<title>Game Admin</title>");
    expect((await admin.inject({ method: "GET", url: "/admin" })).statusCode).toBe(302);
  });

  it("refuses to start without a token", async () => {
    const { store, objects, loader, logger } = await setup();
    expect(() => buildAdminApp({ store, objects, loader, logger, token: "" })).toThrow(/ADMIN_TOKEN/);
  });

  it("compares tokens safely", () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(tokenMatches("Bearer short", TOKEN)).toBe(false);
  });
});

describe("reading games", () => {
  it("lists games with names and filters by status, brand and quarantine", async () => {
    const { admin, games } = await setup();
    const all = await call(admin, "GET", "/admin/games");
    expect(all.body).toHaveLength(games.length);
    expect(all.body[0]).toMatchObject({ gameId: expect.any(String), name: expect.any(String) });
    const retired = await call(admin, "GET", "/admin/games?status=retired");
    expect(retired.body.every((s: { status: string }) => s.status === "retired")).toBe(true);
    const bingo = await call(admin, "GET", "/admin/games?brand=double_bubble_bingo&quarantined=false");
    expect(bingo.body.every((s: { brands: string[] }) => s.brands.includes("double_bubble_bingo"))).toBe(true);
    expect((await call(admin, "GET", "/admin/games?status=bogus")).status).toBe(400);
  });

  it("shows one game's state, enrichment with provenance, and audit history", async () => {
    const { admin, games } = await setup();
    const { status, body } = await call(admin, "GET", `/admin/games/${games[0]!.id}`);
    expect(status).toBe(200);
    expect(body.enrichment.fields.rtp.provenance).toBe("feed");
    expect(body.audit).toHaveLength(1);
    expect((await call(admin, "GET", "/admin/games/NOPE")).status).toBe(404);
  });
});

describe("operator changes", () => {
  it("a suspension takes effect on the very next recommendation request", async () => {
    const { admin, pub, games } = await setup();
    const seed = games.find((g) => g.status === "live" && g.brands.includes("jackpotjoy"))!;
    const url = `/v1/brands/jackpotjoy/games/${seed.id}/recommendations?limit=20`;
    const victim = (await pub.inject({ url })).json().items[0].gameId;

    const res = await call(admin, "PATCH", `/admin/games/${victim}`, { status: "suspended", reason: "Supplier reported a fault" });
    expect(res.status).toBe(200);
    expect(res.body.audit).toMatchObject({ actor: "admin", action: "update_operator_fields", reason: "Supplier reported a fault" });

    const after = (await pub.inject({ url })).json();
    expect(after.items.map((i: { gameId: string }) => i.gameId)).not.toContain(victim);
    expect((await pub.inject({ url: `/v1/brands/jackpotjoy/games/${victim}/recommendations` })).json().reason).toBe("seed_unavailable");
  });

  it("requires a reason to change status, but not to change brands", async () => {
    const { admin, games } = await setup();
    const g = games.find((x) => x.status === "live")!;
    expect((await call(admin, "PATCH", `/admin/games/${g.id}`, { status: "suspended" })).body.error).toBe("reason_required");
    const res = await call(admin, "PATCH", `/admin/games/${g.id}`, { brands: ["jackpotjoy"] });
    expect(res.body.state.brands).toEqual(["jackpotjoy"]);
  });

  it("records nothing when a patch changes nothing, and rejects unknown fields", async () => {
    const { admin, store, games } = await setup();
    const g = games[0]!;
    expect((await call(admin, "PATCH", `/admin/games/${g.id}`, { brands: g.brands })).body.audit).toBeNull();
    expect(await store.listAudit(g.id)).toHaveLength(1);
    expect((await call(admin, "PATCH", `/admin/games/${g.id}`, { rtp: 0.5 })).status).toBe(400);
    expect((await call(admin, "PATCH", "/admin/games/NOPE", { brands: ["jackpotjoy"] })).status).toBe(404);
  });

  it("stores descriptive overrides, merged and audited", async () => {
    const { admin, store, games } = await setup();
    const g = games[0]!;
    await call(admin, "PATCH", `/admin/games/${g.id}/overrides`, { overrides: { mood: "spooky" } });
    const res = await call(admin, "PATCH", `/admin/games/${g.id}/overrides`, { overrides: { pace: "relaxed" }, reason: "Editorial review" });
    expect(res.body.state.overrides).toEqual({ mood: "spooky", pace: "relaxed" });
    expect((await store.listAudit(g.id)).at(-1)).toMatchObject({ action: "set_overrides", reason: "Editorial review" });
    expect((await call(admin, "PATCH", `/admin/games/${g.id}/overrides`, { overrides: { rtp: 0.9 } })).status).toBe(400);
  });

  it("resolves a quarantine only with a regulated field and a reason", async () => {
    const { admin, store, games } = await setup();
    const g = games[0]!;
    const state = (await store.getOperatorState(g.id))!;
    expect((await call(admin, "POST", `/admin/games/${g.id}/resolve-conflict`, { field: "rtp", value: 0.96, reason: "Checked certificate" })).status).toBe(409);

    await store.writeOperatorState({ ...state, quarantined: true, quarantineReason: "RTP: feed 96.12% vs rules 95.50%" }, { gameId: g.id, actor: "pipeline", action: "quarantine", before: null, after: null, reason: "conflict" });
    expect((await call(admin, "POST", `/admin/games/${g.id}/resolve-conflict`, { field: "mood", value: "cosy", reason: "x".repeat(5) })).status).toBe(400);
    expect((await call(admin, "POST", `/admin/games/${g.id}/resolve-conflict`, { field: "rtp", value: 0.9612 })).status).toBe(400);
    const res = await call(admin, "POST", `/admin/games/${g.id}/resolve-conflict`, { field: "rtp", value: 0.9612, reason: "Matches the certificate" });
    expect(res.body.state).toMatchObject({ quarantined: false, quarantineReason: null });
    expect(res.body.audit).toMatchObject({ action: "resolve_conflict", after: { field: "rtp", value: 0.9612 } });
  });

  it("retires with a reason, never deleting", async () => {
    const { admin, games } = await setup();
    const g = games[0]!;
    expect((await call(admin, "POST", `/admin/games/${g.id}/retire`, {})).status).toBe(400);
    const res = await call(admin, "POST", `/admin/games/${g.id}/retire`, { reason: "Licence ended" });
    expect(res.body.state.status).toBe("retired");
    expect((await call(admin, "GET", `/admin/games/${g.id}`)).status).toBe(200);
  });
});

describe("creating games", () => {
  it("writes the record to the bucket for the pipeline, appending within a day", async () => {
    const { admin, objects } = await setup();
    const res = await call(admin, "POST", "/admin/games", { id: "BLY-SLT-0500", name: "New Game", brands: "JPJ" });
    expect(res.status).toBe(202);
    expect(res.body.key).toBe("incoming/feeds/admin/2026-11-13.json");
    await call(admin, "POST", "/admin/games", { id: "BLY-SLT-0501", name: "Another" });
    const stored = JSON.parse((await objects.get(res.body.key)).toString());
    expect(stored.map((r: { id: string }) => r.id)).toEqual(["BLY-SLT-0500", "BLY-SLT-0501"]);
    expect((await call(admin, "POST", "/admin/games", { name: "No id" })).status).toBe(400);
  });
});

describe("errors", () => {
  it("returns a generic 500 and logs unexpected failures", async () => {
    const { admin, store, logger } = await setup();
    vi.spyOn(store, "listOperatorStates").mockRejectedValueOnce(new Error("disk on fire"));
    const error = vi.spyOn(logger, "error");
    const res = await call(admin, "GET", "/admin/games");
    expect(res).toEqual({ status: 500, body: { error: "internal_error" } });
    expect(error).toHaveBeenCalled();
  });
});

describe("pure helpers", () => {
  const state = { gameId: "g", status: "live" as const, brands: ["jackpotjoy" as const], rgFlags: [], quarantined: false, quarantineReason: null, overrides: {}, updatedAt: "t0" };

  it("applyOperatorPatch returns the new state, or null when nothing changes", () => {
    expect(applyOperatorPatch(state, { rgFlags: ["high_intensity"] }, "t1")).toMatchObject({ rgFlags: ["high_intensity"], updatedAt: "t1" });
    expect(applyOperatorPatch(state, { status: "live" }, "t1")).toBeNull();
    expect(() => applyOperatorPatch(state, { status: "retired" }, "t1")).toThrow(/reason/);
  });

  it("filterStates combines filters", () => {
    expect(filterStates([state, { ...state, gameId: "h", quarantined: true }], { quarantined: true }).map((s) => s.gameId)).toEqual(["h"]);
    expect(filterStates([state], { brand: "virgin_games" })).toEqual([]);
  });
});
