/**
 * Entry point: `npm run serve`. Starts the public API and the admin API on separate ports, sharing one IndexLoader.
 *
 * Env: PORT (default 3000), ADMIN_PORT (default 3001), ADMIN_TOKEN (required), INDEX_POLL_MS (default 5000),
 *      LOG_LEVEL (default info).
 */
import type { FastifyBaseLogger as Logger } from "fastify";
import pino from "pino";
import { isMain } from "../lib/cli.ts";
import type { CatalogueStore, ObjectStore } from "../contracts/storage.ts";
import { buildAdminApp } from "./admin.ts";
import { buildPublicApp } from "./app.ts";
import { IndexLoader, type RankerFactory } from "./index-loader.ts";

export interface ServiceDeps {
  store: CatalogueStore;
  objects: ObjectStore;
  rankerFactory: RankerFactory;
}

export interface ServiceEnv {
  PORT?: string;
  ADMIN_PORT?: string;
  ADMIN_TOKEN?: string;
  INDEX_POLL_MS?: string;
  HOST?: string;
}

/**
 * Real implementations. TODO(integrator): once the storage and similarity workstreams merge, replace the body with:
 *   const store = new SqliteCatalogueStore(...)      // src/storage/sqlite-catalogue-store.ts
 *   const objects = new LocalObjectStore(...)       // src/storage/ (local folder bucket)
 *   const rankerFactory = (games) => createRanker(games, DEFAULT_RANKER_CONFIG)   // src/similarity/ranker.ts
 */
export async function wireDependencies(): Promise<ServiceDeps> {
  throw new Error("Service dependencies are not wired yet: see TODO(integrator) in src/service/main.ts");
}

export async function startService(deps: ServiceDeps, env: ServiceEnv, logger: Logger) {
  const loader = new IndexLoader({ store: deps.store, rankerFactory: deps.rankerFactory, logger, pollMs: Number(env.INDEX_POLL_MS ?? 5000) });
  await loader.refreshOperatorStates();
  await loader.refresh();
  loader.start();

  const host = env.HOST ?? "127.0.0.1";
  const publicApp = buildPublicApp({ loader, logger });
  const adminApp = buildAdminApp({ store: deps.store, objects: deps.objects, loader, logger, token: env.ADMIN_TOKEN ?? "" });
  await publicApp.listen({ port: Number(env.PORT ?? 3000), host });
  await adminApp.listen({ port: Number(env.ADMIN_PORT ?? 3001), host });

  const stop = async () => {
    loader.stop();
    await Promise.all([publicApp.close(), adminApp.close()]);
    await deps.store.close();
  };
  return { loader, publicApp, adminApp, stop };
}

if (isMain(import.meta.url)) {
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
  const service = await startService(await wireDependencies(), process.env, logger);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void service.stop().then(() => process.exit(0)));
}
