import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from "fastify";

/** A Fastify instance using our logger. Per-request logging is ours (one structured line per request), not Fastify's. */
export function createFastify(logger: FastifyBaseLogger): FastifyInstance {
  return Fastify({ loggerInstance: logger, logController: new LogController({ disableRequestLogging: true }) });
}
