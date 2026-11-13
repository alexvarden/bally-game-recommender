/**
 * Silver relevance labels, computed from ground-truth attributes for every (seed, candidate) pair.
 *
 * Cheap and complete, but circular: they reward the same attributes the ranker matches on. That's why the report
 * shows them beside the hand labels rather than instead of them.
 */
import type { z } from "zod";
import type { Format, GroundTruthGame, Volatility } from "../../src/catalogue/schema.ts";

const FORMAT_FAMILY: Record<z.infer<typeof Format>, string> = {
  video_slot: "reels",
  classic_slot: "reels",
  slingo: "reels",
  bingo: "rooms",
  live_dealer: "live",
  game_show: "live",
  table: "live",
  instant_win: "instant",
  crash: "instant",
};

export const VOLATILITY_LEVEL: Record<z.infer<typeof Volatility>, number> = { low: 0, medium: 1, high: 2, very_high: 3 };

export const formatFamily = (f: z.infer<typeof Format>) => FORMAT_FAMILY[f];

/** Points for shared attributes: theme 2, mechanic 1, format family 1, volatility within a step 0.5, mood 0.5. */
export function affinity(seed: GroundTruthGame, c: GroundTruthGame): number {
  let points = 0;
  if (seed.primaryTheme === c.primaryTheme) points += 2;
  if (seed.coreMechanic === c.coreMechanic) points += 1;
  if (formatFamily(seed.format) === formatFamily(c.format)) points += 1;
  if (Math.abs(VOLATILITY_LEVEL[seed.volatility] - VOLATILITY_LEVEL[c.volatility]) <= 1) points += 0.5;
  if (seed.mood === c.mood) points += 0.5;
  return points;
}

/** Graded relevance 0–3 from affinity points (max 5). */
export function silverGrade(seed: GroundTruthGame, c: GroundTruthGame): number {
  if (seed.id === c.id) return 0;
  const points = affinity(seed, c);
  if (points >= 3.5) return 3;
  if (points >= 2.5) return 2;
  return points >= 1.5 ? 1 : 0;
}
