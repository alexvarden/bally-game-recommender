/**
 * Enrich the catalogue: committed feed + documents → EnrichedGame per game, via the LLM with code-verified evidence.
 *
 * Usage: node --env-file=.env scripts/enrich/run.ts [--games ID,ID] [--limit N] [--model id]
 *   With --games or --limit, prints a per-game report and writes nothing but the cache.
 *   A full run also writes data/catalogue/enriched.json.
 * Env:   OPENROUTER_API_KEY or ANTHROPIC_API_KEY. Cache: data/catalogue/.enrich-cache (git-ignored).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { EnrichedGame, GameDocument, RawFeedRecord, type SourceGame } from "../../src/catalogue/schema.ts";
import type { NormalisedDocument } from "../../src/contracts/storage.ts";
import { DEFAULT_ENRICH_MODEL, enrichGame, type EnrichDeps, type EnrichOutcome } from "../../src/enrich/enrich.ts";
import { PROMPT_VERSION } from "../../src/enrich/prompt.ts";
import { argValue, countBy, hasFlag, isMain } from "../../src/lib/cli.ts";
import { generateStructured } from "../../src/lib/llm.ts";
import { normalisedDocumentFrom, sourceGameFrom } from "./adapter.ts";

export const ENRICHED_PATH = "data/catalogue/enriched.json";
const CONCURRENCY = 4;

/** USD per million tokens (input, output), for the run report. */
const PRICES: Record<string, [number, number]> = {
  "openai/gpt-6.1-terra": [1, 5],
  "openai/gpt-6-luna": [0.1, 0.5],
  "anthropic/claude-haiku-5.5": [0.1, 0.5],
};

export const EnrichedCatalogue = z.object({
  meta: z.object({ model: z.string(), promptVersion: z.string(), enrichedAt: z.string(), usage: z.object({ input: z.number(), output: z.number(), usd: z.number() }) }),
  games: z.array(EnrichedGame),
  quarantined: z.array(z.object({ gameId: z.string(), reason: z.string() })),
});
export type EnrichedCatalogue = z.infer<typeof EnrichedCatalogue>;

export interface Inputs {
  games: SourceGame[];
  documents: Map<string, NormalisedDocument[]>;
}

export function loadInputs(feedPath = "data/catalogue/catalogue.raw.json", docsPath = "data/catalogue/documents.json"): Inputs {
  const feed = z.array(RawFeedRecord).parse(JSON.parse(readFileSync(feedPath, "utf8")));
  const docs = z.array(GameDocument).parse(JSON.parse(readFileSync(docsPath, "utf8"))).map(normalisedDocumentFrom);
  return { games: feed.map(sourceGameFrom), documents: Map.groupBy(docs, (d) => d.gameId) };
}

export function selectGames(games: SourceGame[], argv: readonly string[]): SourceGame[] {
  const ids = argValue(argv, "--games", "");
  const picked = ids ? games.filter((g) => ids.split(",").includes(g.id)) : games;
  return picked.slice(0, Number(argValue(argv, "--limit", String(picked.length))));
}

export const costUsd = (model: string, usage: { input: number; output: number }) => {
  const [inPrice, outPrice] = PRICES[model] ?? [0, 0];
  return (usage.input * inPrice + usage.output * outPrice) / 1_000_000;
};

/** One line per game: what was accepted, inferred, rejected and why. */
export function describeOutcome(o: EnrichOutcome): string {
  const provenance = countBy(Object.values(o.game.fields), (f) => f.provenance);
  const rejected = o.game.rejected.map((r) => `${r.field}:${r.reason}`).join(", ") || "none";
  return [
    `${o.game.id} ${o.game.name}${o.cached ? " (cached)" : ""}`,
    `  provenance ${JSON.stringify(provenance)}`,
    `  rejected ${rejected}`,
    `  conflicts ${o.game.conflicts.map((c) => `${c.field}: ${c.detail}`).join(" | ") || "none"}`,
    `  quarantine ${o.quarantine ?? "no"}`,
    `  tokens ${o.usage.input} in / ${o.usage.output} out`,
  ].join("\n");
}

export async function enrichAll(games: SourceGame[], inputs: Inputs, deps: EnrichDeps): Promise<EnrichOutcome[]> {
  const outcomes: EnrichOutcome[] = [];
  for (let i = 0; i < games.length; i += CONCURRENCY) {
    const wave = games.slice(i, i + CONCURRENCY);
    outcomes.push(...(await Promise.all(wave.map((g) => enrichGame(g, inputs.documents.get(g.id) ?? [], {}, deps)))));
  }
  return outcomes;
}

export function toCatalogue(outcomes: EnrichOutcome[], model: string, now: Date): EnrichedCatalogue {
  const usage = outcomes.reduce((u, o) => ({ input: u.input + o.usage.input, output: u.output + o.usage.output }), { input: 0, output: 0 });
  return EnrichedCatalogue.parse({
    meta: { model, promptVersion: PROMPT_VERSION, enrichedAt: now.toISOString(), usage: { ...usage, usd: costUsd(model, usage) } },
    games: outcomes.map((o) => o.game),
    quarantined: outcomes.filter((o) => o.quarantine).map((o) => ({ gameId: o.game.id, reason: o.quarantine! })),
  });
}

export function depsFrom(argv: readonly string[]): EnrichDeps {
  return {
    llm: generateStructured,
    model: argValue(argv, "--model", DEFAULT_ENRICH_MODEL),
    cacheDir: "data/catalogue/.enrich-cache",
    now: () => new Date(),
    log: (m) => console.warn(m),
  };
}

export async function run(argv: readonly string[], deps = depsFrom(argv), inputs = loadInputs(), outPath = ENRICHED_PATH) {
  const games = selectGames(inputs.games, argv);
  const partial = hasFlag(argv, "--games") || hasFlag(argv, "--limit");
  const outcomes = await enrichAll(games, inputs, deps);
  outcomes.forEach((o) => console.log(describeOutcome(o)));
  const catalogue = toCatalogue(outcomes, deps.model, deps.now());
  console.log(`\n${outcomes.length} games; ${catalogue.meta.usage.input} in / ${catalogue.meta.usage.output} out tokens; $${catalogue.meta.usage.usd.toFixed(4)}`);
  if (!partial) writeFileSync(outPath, JSON.stringify(catalogue, null, 2));
  return catalogue;
}

if (isMain(import.meta.url)) await run(process.argv);
