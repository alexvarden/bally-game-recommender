import { describe, expect, it } from "vitest";
import { seededStore, silentLogger, stubRankerFactory } from "../testing/service-fixtures.ts";
import { startService, wireDependencies } from "./main.ts";

describe("startService", () => {
  it("serves the public and admin APIs on separate ports with an index loaded, and stops cleanly", async () => {
    const { store, objects, games } = await seededStore();
    const service = await startService({ store, objects, rankerFactory: stubRankerFactory() }, { PORT: "0", ADMIN_PORT: "0", ADMIN_TOKEN: "token-1234", INDEX_POLL_MS: "60000" }, silentLogger());
    try {
      const pubPort = (service.publicApp.server.address() as { port: number }).port;
      const adminPort = (service.adminApp.server.address() as { port: number }).port;
      expect(pubPort).not.toBe(adminPort);

      const ready = await fetch(`http://127.0.0.1:${pubPort}/readyz`);
      expect(await ready.json()).toEqual({ ready: true, indexVersion: "v1" });
      const seed = games.find((g) => g.status === "live" && g.brands.includes("jackpotjoy"))!;
      const recs = await fetch(`http://127.0.0.1:${pubPort}/v1/brands/jackpotjoy/games/${seed.id}/recommendations`);
      expect((await recs.json()).items).toHaveLength(6);

      expect((await fetch(`http://127.0.0.1:${pubPort}/admin/games`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${adminPort}/admin/games`, { headers: { authorization: "Bearer token-1234" } })).status).toBe(200);
    } finally {
      await service.stop();
    }
  });
});

describe("wireDependencies", () => {
  it("fails loudly until the real store and ranker are wired", async () => {
    await expect(wireDependencies()).rejects.toThrow(/TODO\(integrator\)/);
  });
});
