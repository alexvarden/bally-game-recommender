/**
 * Baseline rankers for the comparison table. The real ranker (src/similarity) must beat these to justify itself.
 *
 *   random (unfiltered)  calibration: shows the hard-violation gate fires
 *   random               hard filters and guardrail, random order: the floor
 *   metadata             hard filters and guardrail, ranked on shared enriched attributes (no embeddings)
 *   silver oracle        ranks by the silver labels: an upper bound, not a real system
 */
import type { z } from "zod";
import type { Brand, EnrichedGame, GroundTruthGame, Volatility } from "../../src/catalogue/schema.ts";
import type { RankedItem, Ranker } from "../../src/contracts/ranking.ts";
import type { OperatorState } from "../../src/contracts/storage.ts";
import { mulberry32, shuffle } from "../../src/lib/random.ts";
import { silverGrade, VOLATILITY_LEVEL } from "./silver.ts";

type BrandId = z.infer<typeof Brand>;
type Fields = EnrichedGame["fields"];

const value = <K extends keyof Fields>(g: EnrichedGame, k: K) => g.fields[k].value;

function level(g: EnrichedGame): number | null {
  const v = value(g, "volatility") as z.infer<typeof Volatility> | null;
  return v === null ? null : VOLATILITY_LEVEL[v];
}

/** Hard filters every real ranker must apply, plus the volatility guardrail (unknown volatility is excluded). */
export function candidatesFor(seed: EnrichedGame, brand: BrandId, games: EnrichedGame[], operator: ReadonlyMap<string, OperatorState>, maxStepUp = 1): EnrichedGame[] {
  const seedLevel = level(seed);
  return games.filter((g) => {
    const s = operator.get(g.id);
    if (g.id === seed.id || !s || s.status !== "live" || s.quarantined || !s.brands.includes(brand)) return false;
    const l = level(g);
    return seedLevel !== null && l !== null && l - seedLevel <= maxStepUp;
  });
}

const top = (scored: { id: string; score: number }[], limit: number): RankedItem[] =>
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit).map((s) => ({ gameId: s.id, score: s.score }));

function rankerFrom(games: EnrichedGame[], scoreFn: (seed: EnrichedGame, c: EnrichedGame, i: number) => number, filtered = true): Ranker {
  const byId = new Map(games.map((g) => [g.id, g]));
  return {
    rank(seedId, brand, limit, operator) {
      const seed = byId.get(seedId);
      if (!seed) return { items: [], reason: "unknown_game" };
      const pool = filtered ? candidatesFor(seed, brand, games, operator) : games;
      const items = top(pool.map((c, i) => ({ id: c.id, score: scoreFn(seed, c, i) })), limit);
      return { items, reason: items.length < limit ? "below_floor" : null };
    },
  };
}

export function randomRanker(games: EnrichedGame[], seed = 1, filtered = true): Ranker {
  const order = new Map(shuffle(mulberry32(seed), games.map((g) => g.id)).map((id, i) => [id, i]));
  return rankerFrom(games, (_, c) => -order.get(c.id)!, filtered);
}

/** Shared attributes from enrichment only: theme, mechanic, format, mood, pace. */
export function metadataScore(seed: EnrichedGame, c: EnrichedGame): number {
  const same = <K extends keyof Fields>(k: K) => value(seed, k) !== null && value(seed, k) === value(c, k);
  return (same("primaryTheme") ? 2 : 0) + (same("coreMechanic") ? 1 : 0) + (same("format") ? 1 : 0) + (same("mood") ? 0.5 : 0) + (same("pace") ? 0.25 : 0);
}

export const metadataRanker = (games: EnrichedGame[]) => rankerFrom(games, metadataScore);

export function silverOracle(games: EnrichedGame[], truth: ReadonlyMap<string, GroundTruthGame>): Ranker {
  return rankerFrom(games, (seed, c) => silverGrade(truth.get(seed.id)!, truth.get(c.id)!));
}
