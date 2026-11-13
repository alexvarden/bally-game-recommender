/**
 * Enriches one game: cache lookup, LLM call with retries, then code-side verification and merge.
 *
 * The cache holds the raw LLM response keyed by its inputs, so changing verification or merge rules never needs new
 * LLM calls, and an unchanged game is never paid for twice.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LlmEnrichment, type DescriptiveOverrides, type SourceGame } from "../catalogue/schema.ts";
import type { NormalisedDocument } from "../contracts/storage.ts";
import { LlmError, type generateStructured } from "../lib/llm.ts";
import { mergeEnrichment, type MergeResult } from "./merge.ts";
import { PROMPT_VERSION, SYSTEM, userPrompt } from "./prompt.ts";

export const DEFAULT_ENRICH_MODEL = "openai/gpt-6.1-terra";
const MAX_ATTEMPTS = 3;

export interface EnrichDeps {
  llm: typeof generateStructured;
  model: string;
  cacheDir: string;
  now: () => Date;
  log: (message: string) => void;
}

export interface EnrichOutcome extends MergeResult {
  cached: boolean;
  usage: { input: number; output: number };
}

/** Changes whenever anything the model sees changes: prompt, model, feed record or documents. */
export function sourceHash(model: string, source: SourceGame, documents: readonly NormalisedDocument[]): string {
  const docs = [...documents].sort((a, b) => a.docId.localeCompare(b.docId)).map((d) => ({ docId: d.docId, kind: d.kind, text: d.text }));
  return createHash("sha256").update(JSON.stringify({ PROMPT_VERSION, SYSTEM, model, source, docs })).digest("hex").slice(0, 20);
}

function readCache(path: string): LlmEnrichment | null {
  return existsSync(path) ? LlmEnrichment.parse(JSON.parse(readFileSync(path, "utf8"))) : null;
}

/** Calls the model, retrying retryable failures. Non-retryable ones (no credit, refusal) fail fast. */
async function callWithRetries(source: SourceGame, documents: readonly NormalisedDocument[], deps: EnrichDeps) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await deps.llm({ schema: LlmEnrichment, schemaName: "game_enrichment", model: deps.model, maxTokens: 8000, system: SYSTEM, user: userPrompt(source, documents) });
    } catch (err) {
      lastError = err;
      deps.log(`  ${source.id} attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof LlmError && !err.retryable) break;
    }
  }
  throw lastError;
}

export async function enrichGame(source: SourceGame, documents: NormalisedDocument[], overrides: DescriptiveOverrides, deps: EnrichDeps): Promise<EnrichOutcome> {
  const hash = sourceHash(deps.model, source, documents);
  const cachePath = join(deps.cacheDir, `${source.id}-${hash}.json`);
  const cachedLlm = readCache(cachePath);
  let llm = cachedLlm;
  let usage = { input: 0, output: 0 };
  if (!llm) {
    const response = await callWithRetries(source, documents, deps);
    llm = response.data;
    usage = { input: response.usage.inputTokens, output: response.usage.outputTokens };
    mkdirSync(deps.cacheDir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(llm, null, 2));
  }
  const meta = { sourceHash: hash, promptVersion: PROMPT_VERSION, model: deps.model, enrichedAt: deps.now().toISOString() };
  return { ...mergeEnrichment({ source, documents, llm, overrides, meta }), cached: cachedLlm !== null, usage };
}
