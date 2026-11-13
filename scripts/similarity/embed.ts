/**
 * Embeds every game's aspect profiles and writes them for the service to load.
 *
 * Each (game, aspect) is keyed by a hash of model + profile text, so re-running only embeds profiles that changed:
 * after a re-enrichment, unchanged games cost nothing. Also writes a single raw-text vector per game, built from the
 * supplier documents with no enrichment, as the eval's "no enrichment" baseline.
 *
 * Usage: node scripts/similarity/embed.ts [--games enriched.json] [--embedder local|hash]
 *   --games defaults to the ground truth as EnrichedGame (src/testing/fixtures.ts) until enrichment output exists.
 * Output: data/catalogue/embeddings.json, data/catalogue/embeddings.baseline.json
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { EnrichedGame, GameDocument } from "../../src/catalogue/schema.ts";
import type { Embedder } from "../../src/contracts/ranking.ts";
import { Aspect, EmbeddingRecord } from "../../src/contracts/storage.ts";
import { argValue, isMain } from "../../src/lib/cli.ts";
import { HashEmbedder, LocalEmbedder } from "../../src/similarity/embedders.ts";
import { profiles } from "../../src/similarity/profiles.ts";
import { groundTruthAsEnriched } from "../../src/testing/fixtures.ts";

export const EMBEDDINGS_PATH = "data/catalogue/embeddings.json";
export const BASELINE_EMBEDDINGS_PATH = "data/catalogue/embeddings.baseline.json";
const DOCUMENTS_PATH = "data/catalogue/documents.json";

export const BaselineRecord = z.object({ gameId: z.string(), model: z.string(), inputHash: z.string(), vector: z.array(z.number()) });
export type BaselineRecord = z.infer<typeof BaselineRecord>;

interface Pending {
  gameId: string;
  aspect: Aspect;
  profileText: string;
  inputHash: string;
}

export const inputHash = (model: string, text: string) => createHash("sha256").update(`${model}\n${text}`).digest("hex").slice(0, 16);

/** Six decimal places keeps cosine similarity to ~1e-6 and the committed file small. */
const round = (v: number[]) => v.map((x) => Math.round(x * 1e6) / 1e6);

/** Splits work into records we can reuse unchanged and profiles that need embedding. */
export function planEmbeddings(games: readonly EnrichedGame[], existing: readonly EmbeddingRecord[], model: string) {
  const known = new Map(existing.filter((r) => r.model === model).map((r) => [`${r.gameId}|${r.aspect}|${r.inputHash}`, r]));
  const reuse: EmbeddingRecord[] = [];
  const pending: Pending[] = [];
  for (const game of games) {
    for (const [aspect, profileText] of Object.entries(profiles(game)) as [Aspect, string][]) {
      const hash = inputHash(model, profileText);
      const hit = known.get(`${game.id}|${aspect}|${hash}`);
      if (hit) reuse.push(hit);
      else pending.push({ gameId: game.id, aspect, profileText, inputHash: hash });
    }
  }
  return { reuse, pending };
}

export async function embedProfiles(games: readonly EnrichedGame[], existing: readonly EmbeddingRecord[], embedder: Embedder) {
  const { reuse, pending } = planEmbeddings(games, existing, embedder.model);
  const vectors = await embedder.embed(pending.map((p) => p.profileText));
  const fresh = pending.map((p, i) => EmbeddingRecord.parse({ ...p, model: embedder.model, vector: round(vectors[i]!) }));
  const order = new Map(games.map((g, i) => [g.id, i]));
  const records = [...reuse, ...fresh].sort((a, b) => order.get(a.gameId)! - order.get(b.gameId)! || a.aspect.localeCompare(b.aspect));
  return { records, embedded: fresh.length, reused: reuse.length };
}

/** Raw supplier text per game: every document concatenated with tags crudely removed. Deliberately unenriched. */
export function rawTextByGame(documents: readonly GameDocument[]): Map<string, string> {
  const texts = new Map<string, string>();
  for (const d of documents) {
    const plain = d.text.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
    texts.set(d.gameId, `${texts.get(d.gameId) ?? ""} ${plain}`.trim());
  }
  return texts;
}

export async function embedBaseline(texts: ReadonlyMap<string, string>, embedder: Embedder): Promise<BaselineRecord[]> {
  const entries = [...texts];
  const vectors = await embedder.embed(entries.map(([, t]) => t));
  return entries.map(([gameId, text], i) => ({ gameId, model: embedder.model, inputHash: inputHash(embedder.model, text), vector: round(vectors[i]!) }));
}

export interface EmbedPaths {
  games: string | null;
  documents: string;
  out: string;
  baselineOut: string;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;

export function embedderFor(name: string): Embedder {
  if (name === "hash") return new HashEmbedder();
  if (name === "local") return new LocalEmbedder();
  throw new Error(`unknown embedder ${name}; expected local or hash`);
}

export async function run(argv: readonly string[], paths: EmbedPaths, embedder: Embedder = embedderFor(argValue(argv, "--embedder", "local"))) {
  const games = paths.games ? z.array(EnrichedGame).parse(readJson(paths.games)) : groundTruthAsEnriched();
  const existing = existsSync(paths.out) ? z.array(EmbeddingRecord).parse(readJson(paths.out)) : [];
  const { records, embedded, reused } = await embedProfiles(games, existing, embedder);
  writeFileSync(paths.out, JSON.stringify(records));

  const documents = z.array(GameDocument).parse(readJson(paths.documents));
  const baseline = await embedBaseline(rawTextByGame(documents), embedder);
  writeFileSync(paths.baselineOut, JSON.stringify(baseline));

  console.log(`${embedder.model}: embedded ${embedded}, reused ${reused} aspect profiles; ${baseline.length} raw-text baseline vectors`);
  return { records, baseline, embedded, reused };
}

if (isMain(import.meta.url)) {
  const games = argValue(process.argv, "--games", "");
  await run(process.argv, { games: games || null, documents: DOCUMENTS_PATH, out: EMBEDDINGS_PATH, baselineOut: BASELINE_EMBEDDINGS_PATH });
}
