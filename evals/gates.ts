/**
 * Release gates, evaluated in code. evals/GATES.md explains each one; keep the two in step.
 *
 * "block" gates must pass before a prompt, model or ranker change ships. "warn" gates are reported and need a
 * written justification in the PR if they fail.
 */

export type GateLevel = "block" | "warn";

export interface GateResult {
  name: string;
  level: GateLevel;
  value: number;
  threshold: number;
  comparison: "<=" | ">=";
  pass: boolean;
}

export function gate(name: string, level: GateLevel, value: number, comparison: "<=" | ">=", threshold: number): GateResult {
  const pass = comparison === "<=" ? value <= threshold : value >= threshold;
  return { name, level, value, threshold, comparison, pass };
}

/** True when every blocking gate passes. */
export const releasable = (gates: GateResult[]) => gates.every((g) => g.pass || g.level === "warn");

export const ENRICHMENT_THRESHOLDS = {
  regulatedViolations: 0,
  quoteRejectionRate: 0.05,
  accuracy: 0.8,
  abstentionRate: 0.9,
  defectRecall: 0.66,
} as const;

export const MATCHING_THRESHOLDS = {
  hardViolations: 0,
  silverNdcg: 0.6,
  handNdcg: 0.5,
  mustNotHits: 0,
  fallbackRate: 0.2,
} as const;
