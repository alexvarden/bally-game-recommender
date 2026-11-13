/**
 * Public, player-facing API. Read-only; ranks over the in-memory snapshot held by the IndexLoader.
 */
import type { FastifyBaseLogger as Logger, FastifyInstance } from "fastify";
import { z } from "zod";
import { Brand } from "../catalogue/schema.ts";
import type { IndexLoader } from "./index-loader.ts";
import { createFastify } from "./http.ts";
import { recommend } from "./recommend.ts";

export interface PublicAppOptions {
  loader: IndexLoader;
  logger: Logger;
  config?: { defaultLimit?: number; maxLimit?: number };
}

const Params = z.object({ brand: z.string(), gameId: z.string().min(1).max(64) });

export function buildPublicApp({ loader, logger, config = {} }: PublicAppOptions): FastifyInstance {
  const maxLimit = config.maxLimit ?? 20;
  const Query = z.object({ limit: z.coerce.number().int().min(1).max(maxLimit).default(config.defaultLimit ?? 6) });
  const app = createFastify(logger);

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_req, reply) => {
    const snapshot = loader.current();
    if (!snapshot) return reply.code(503).send({ ready: false, reason: "index_unavailable" });
    return { ready: true, indexVersion: snapshot.index.version };
  });

  app.get("/v1/brands/:brand/games/:gameId/recommendations", async (req, reply) => {
    const started = performance.now();
    const params = Params.safeParse(req.params);
    const query = Query.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid_request", issues: [...(params.error?.issues ?? []), ...(query.error?.issues ?? [])] });
    const brand = Brand.safeParse(params.data.brand);
    if (!brand.success) return reply.code(404).send({ error: "unknown_brand" });

    const body = recommend({ snapshot: loader.current(), operator: loader.operatorStates(), brand: brand.data, seedId: params.data.gameId, limit: query.data.limit });
    req.log.info(
      { brand: body.brand, gameId: body.gameId, latencyMs: Math.round((performance.now() - started) * 1000) / 1000, indexVersion: body.indexVersion, fallbackReason: body.reason, items: body.items.length },
      "recommendation",
    );
    return body;
  });

  return app;
}
