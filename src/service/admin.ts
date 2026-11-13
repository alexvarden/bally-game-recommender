/**
 * Admin API for operators, on a separate port from the public API and behind a bearer token.
 *
 * Trust tiers (see CLAUDE.md):
 * - Operator fields (status, brands, RG flags) apply immediately: every write refreshes the loader's operator cache.
 * - Regulated facts change only by resolving a quarantine, with a reason.
 * - Descriptive overrides are stored with the operator state and win over feed and LLM values at the next pipeline run.
 * - New games are written to the bucket, so they go through the same pipeline as any supplier's.
 * - Delete means retire. Every write is audited with the actor and, where required, a reason.
 */
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger as Logger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { Brand, DescriptiveOverrides, RawFeedRecord, REGULATED_FIELDS, RgFlag, Status } from "../catalogue/schema.ts";
import { BUCKET_PREFIX, type AuditInput, type CatalogueStore, type ObjectStore, type OperatorState } from "../contracts/storage.ts";
import { createFastify } from "./http.ts";
import type { IndexLoader } from "./index-loader.ts";

export const ACTOR = "admin";

const ADMIN_PAGE_PATH = new URL("./admin-page.html", import.meta.url);

const Reason = z.string().trim().min(3).max(500);

export const OperatorPatch = z
  .object({ status: Status.optional(), brands: z.array(Brand).min(1).optional(), rgFlags: z.array(RgFlag).optional(), reason: Reason.optional() })
  .strict();

export const ResolveConflict = z.object({ field: z.enum(REGULATED_FIELDS), value: z.union([z.string(), z.number(), z.null()]), reason: Reason }).strict();

export const ListQuery = z.object({
  status: Status.optional(),
  brand: Brand.optional(),
  quarantined: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});

/** Constant-time token check, so the token can't be guessed byte by byte from response timings. */
export function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function filterStates(states: OperatorState[], q: z.infer<typeof ListQuery>): OperatorState[] {
  return states.filter(
    (s) => (q.status === undefined || s.status === q.status) && (q.brand === undefined || s.brands.includes(q.brand)) && (q.quarantined === undefined || s.quarantined === q.quarantined),
  );
}

/** Applies a patch; a status change without a reason is refused. Returns null when nothing changes. */
export function applyOperatorPatch(state: OperatorState, patch: z.infer<typeof OperatorPatch>, now: string): OperatorState | null {
  const statusChanges = patch.status !== undefined && patch.status !== state.status;
  if (statusChanges && !patch.reason) throw new AdminError(400, "reason_required", "a reason is required to change status");
  const next = { ...state, status: patch.status ?? state.status, brands: patch.brands ?? state.brands, rgFlags: patch.rgFlags ?? state.rgFlags };
  const changed = JSON.stringify([next.status, next.brands, next.rgFlags]) !== JSON.stringify([state.status, state.brands, state.rgFlags]);
  return changed ? { ...next, updatedAt: now } : null;
}

export class AdminError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface AdminAppOptions {
  store: CatalogueStore;
  objects: ObjectStore;
  loader: IndexLoader;
  logger: Logger;
  token: string;
  now?: () => Date;
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new AdminError(400, "invalid_request", result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return result.data;
}

export function buildAdminApp(opts: AdminAppOptions): FastifyInstance {
  if (!opts.token) throw new Error("ADMIN_TOKEN must be set to start the admin API");
  const now = () => (opts.now ?? (() => new Date()))().toISOString();
  const app = createFastify(opts.logger);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AdminError) return reply.code(err.status).send({ error: err.code, message: err.message });
    opts.logger.error({ err }, "admin request failed");
    return reply.code(500).send({ error: "internal_error" });
  });

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/admin/" || req.url === "/admin") return;
    if (!tokenMatches(req.headers.authorization, opts.token)) return reply.code(401).send({ error: "unauthorised" });
  });

  const stateOf = async (id: string) => {
    const state = await opts.store.getOperatorState(id);
    if (!state) throw new AdminError(404, "unknown_game", `no game ${id}`);
    return state;
  };

  /** Every operator write goes through here: store + audit in one transaction, then the live cache refresh. */
  const write = async (state: OperatorState, audit: Omit<AuditInput, "gameId" | "actor">) => {
    const entry = await opts.store.writeOperatorState(state, { ...audit, gameId: state.gameId, actor: ACTOR });
    await opts.loader.refreshOperatorStates();
    opts.logger.info({ gameId: state.gameId, action: audit.action, auditId: entry.id }, "operator change");
    return { state, audit: entry };
  };

  const page = readFileSync(ADMIN_PAGE_PATH, "utf8");
  app.get("/admin/", async (_req, reply) => reply.type("text/html").send(page));
  app.get("/admin", async (_req, reply) => reply.redirect("/admin/"));

  app.get("/admin/games", async (req) => {
    const q = parse(ListQuery, req.query);
    const [states, games] = await Promise.all([opts.store.listOperatorStates(), opts.store.listEnrichments()]);
    const names = new Map(games.map((g) => [g.id, g.name]));
    return filterStates(states, q)
      .sort((a, b) => a.gameId.localeCompare(b.gameId))
      .map((s) => ({ ...s, name: names.get(s.gameId) ?? null }));
  });

  app.get("/admin/games/:id", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const state = await stateOf(req.params.id);
    const [enrichment, audit] = await Promise.all([opts.store.getEnrichment(req.params.id), opts.store.listAudit(req.params.id)]);
    return { state, enrichment, audit };
  });

  app.patch("/admin/games/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const patch = parse(OperatorPatch, req.body);
    const before = await stateOf(req.params.id);
    const after = applyOperatorPatch(before, patch, now());
    if (!after) return reply.code(200).send({ state: before, audit: null });
    return write(after, { action: "update_operator_fields", before: pick(before), after: pick(after), reason: patch.reason ?? null });
  });

  app.patch("/admin/games/:id/overrides", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const body = parse(z.object({ overrides: DescriptiveOverrides.strict(), reason: Reason.optional() }).strict(), req.body);
    const before = await stateOf(req.params.id);
    const after = { ...before, overrides: { ...before.overrides, ...body.overrides }, updatedAt: now() };
    return write(after, { action: "set_overrides", before: before.overrides, after: after.overrides, reason: body.reason ?? null });
  });

  app.post("/admin/games/:id/resolve-conflict", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const body = parse(ResolveConflict, req.body);
    const before = await stateOf(req.params.id);
    if (!before.quarantined) throw new AdminError(409, "not_quarantined", `${before.gameId} has no open conflict`);
    const after = { ...before, quarantined: false, quarantineReason: null, updatedAt: now() };
    // OperatorState has no field for regulated values, so the decision lives in the audit entry (see PR notes).
    return write(after, { action: "resolve_conflict", before: { quarantineReason: before.quarantineReason }, after: { field: body.field, value: body.value }, reason: body.reason });
  });

  app.post("/admin/games/:id/retire", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const body = parse(z.object({ reason: Reason }).strict(), req.body);
    const before = await stateOf(req.params.id);
    const after = { ...before, status: "retired" as const, updatedAt: now() };
    return write(after, { action: "retire", before: { status: before.status }, after: { status: "retired" }, reason: body.reason });
  });

  app.post("/admin/games", async (req, reply) => {
    const record = parse(RawFeedRecord, req.body);
    const key = `${BUCKET_PREFIX.feeds}admin/${now().slice(0, 10)}.json`;
    const existing = (await opts.objects.list(key)).some((o) => o.key === key) ? (JSON.parse((await opts.objects.get(key)).toString("utf8")) as unknown[]) : [];
    const summary = await opts.objects.put(key, JSON.stringify([...existing, record], null, 2));
    opts.logger.info({ gameId: record.id, key }, "game submitted to bucket");
    return reply.code(202).send({ key: summary.key, etag: summary.etag, note: "queued for the next pipeline run" });
  });

  return app;
}

const pick = (s: OperatorState) => ({ status: s.status, brands: s.brands, rgFlags: s.rgFlags });
