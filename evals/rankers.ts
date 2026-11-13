/**
 * Which rankers the report compares. Integration point for src/similarity: when the real ranker exists, add it
 * here as the candidate (first entry with `candidate: true`); its gates become the release gates.
 */
import type { EnrichedGame, GroundTruthGame } from "../src/catalogue/schema.ts";
import type { Ranker } from "../src/contracts/ranking.ts";
import { metadataRanker, randomRanker, silverOracle } from "./matching/baselines.ts";

export interface NamedRanker {
  name: string;
  ranker: Ranker;
  /** The ranker whose gates decide release. */
  candidate?: boolean;
  /** Calibration rows prove the scorer works; they are not systems we'd ship. */
  calibration?: boolean;
}

export function rankersFor(games: EnrichedGame[], truth: ReadonlyMap<string, GroundTruthGame>, answerKey: EnrichedGame[]): NamedRanker[] {
  return [
    // TODO(similarity): { name: "aspect embeddings + guardrail", ranker: <real ranker>, candidate: true },
    { name: "metadata (enriched attributes)", ranker: metadataRanker(games), candidate: true },
    { name: "random, filtered", ranker: randomRanker(games) },
    { name: "random, unfiltered", ranker: randomRanker(games, 1, false), calibration: true },
    { name: "silver oracle (answer key)", ranker: silverOracle(answerKey, truth), calibration: true },
  ];
}
