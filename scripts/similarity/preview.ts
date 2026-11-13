/**
 * Prints the top recommendations for a handful of seed games, as a quick human sanity check of the embeddings.
 *
 * Usage: node scripts/similarity/preview.ts [--brand jackpotjoy] [--limit 5] [--seeds BLY-SLT-0013,BLY-LIV-0066]
 * Without --seeds it picks one Norse slot, one Egyptian slot, one live dealer game, one bingo game and one family base.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Brand, EnrichedGame } from "../../src/catalogue/schema.ts";
import { DEFAULT_RANKER_CONFIG, type Ranker } from "../../src/contracts/ranking.ts";
import { EmbeddingRecord, type OperatorState } from "../../src/contracts/storage.ts";
import { argValue, isMain } from "../../src/lib/cli.ts";
import { DEFAULT_LOCAL_MODEL } from "../../src/similarity/embedders.ts";
import { createRanker } from "../../src/similarity/ranker.ts";
import { toRankable } from "../../src/similarity/rankable.ts";
import { groundTruthAsEnriched, operatorStateFrom } from "../../src/testing/fixtures.ts";
import { EMBEDDINGS_PATH } from "./embed.ts";

type BrandId = z.infer<typeof Brand>;

const field = (g: EnrichedGame, k: "primaryTheme" | "format" | "coreMechanic" | "volatility") => g.fields[k].value;

/** A small, varied default set of seeds that are live on the brand. */
export function defaultSeeds(games: readonly EnrichedGame[], brand: BrandId): string[] {
  const live = games.filter((g) => g.status === "live" && g.brands.includes(brand));
  const first = (pred: (g: EnrichedGame) => boolean) => live.find(pred)?.id;
  return [
    first((g) => field(g, "primaryTheme") === "norse_myth" && field(g, "format") === "video_slot"),
    first((g) => field(g, "primaryTheme") === "ancient_egypt"),
    first((g) => field(g, "format") === "live_dealer"),
    first((g) => field(g, "format") === "bingo"),
    first((g) => g.familyRole === "base"),
  ].filter((id): id is string => !!id);
}

export function describe(g: EnrichedGame) {
  return `${g.name} [${field(g, "format")}, ${field(g, "primaryTheme")}, ${field(g, "coreMechanic")}, ${field(g, "volatility")}]`;
}

export function previewLines(ranker: Ranker, games: readonly EnrichedGame[], seeds: readonly string[], brand: BrandId, limit: number, operator: ReadonlyMap<string, OperatorState>) {
  const byId = new Map(games.map((g) => [g.id, g]));
  return seeds.flatMap((seed) => {
    const result = ranker.rank(seed, brand, limit, operator);
    const header = `\n${seed} ${byId.has(seed) ? describe(byId.get(seed)!) : "(unknown)"}${result.reason ? `  → ${result.reason}` : ""}`;
    return [header, ...result.items.map((i) => `  ${i.score.toFixed(3)}  ${i.gameId} ${describe(byId.get(i.gameId)!)}`)];
  });
}

export function run(argv: readonly string[], embeddingsPath = EMBEDDINGS_PATH): string[] {
  const brand = argValue(argv, "--brand", "jackpotjoy") as BrandId;
  const limit = Number(argValue(argv, "--limit", "5"));
  const games = groundTruthAsEnriched();
  const records = z.array(EmbeddingRecord).parse(JSON.parse(readFileSync(embeddingsPath, "utf8")));
  const model = argValue(argv, "--model", DEFAULT_LOCAL_MODEL);
  const ranker = createRanker(toRankable(games, records, model).rankable, DEFAULT_RANKER_CONFIG);
  const operator = new Map(games.map((g) => [g.id, operatorStateFrom(g)]));
  const seedArg = argValue(argv, "--seeds", "");
  const seeds = seedArg ? seedArg.split(",") : defaultSeeds(games, brand);
  const lines = previewLines(ranker, games, seeds, brand, limit, operator);
  console.log(lines.join("\n"));
  return lines;
}

if (isMain(import.meta.url)) run(process.argv);
