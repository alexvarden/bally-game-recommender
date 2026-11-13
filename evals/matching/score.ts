/**
 * Matching eval: runs any Ranker over every (brand, live seed) request and scores the top k.
 *
 * Hard violations use the ground truth, because they are about real harm (a non-live or wrong-brand game on a
 * player's page, a big volatility step up), not about what the pipeline believed.
 */
import type { z } from "zod";
import { Brand, type GroundTruthGame } from "../../src/catalogue/schema.ts";
import type { Ranker, RankResult } from "../../src/contracts/ranking.ts";
import type { OperatorState } from "../../src/contracts/storage.ts";
import { gate, MATCHING_THRESHOLDS as T, type GateResult } from "../gates.ts";
import type { HandLabels, SeedLabels } from "./labels.ts";
import { silverGrade, VOLATILITY_LEVEL } from "./silver.ts";

type BrandId = z.infer<typeof Brand>;

export interface MatchingContext {
  truth: ReadonlyMap<string, GroundTruthGame>;
  operator: ReadonlyMap<string, OperatorState>;
  /** Duplicate listing id → original id. */
  duplicates: Readonly<Record<string, string>>;
  labels: HandLabels;
  k: number;
  maxVolatilityStepUp: number;
}

export interface MatchRequest {
  brand: BrandId;
  seedId: string;
}

export interface Violation extends MatchRequest {
  gameId: string;
  kind: "not_live_on_brand" | "quarantined" | "seed_itself" | "duplicate_listing" | "volatility_step_up" | "unknown_game";
  detail: string;
}

export interface MustNotHit extends MatchRequest {
  gameId: string;
  rationale: string;
}

export interface SeedResult extends MatchRequest {
  items: string[];
  reason: RankResult["reason"];
  handNdcg: number | null;
}

export interface RankerScore {
  name: string;
  requests: number;
  hardViolations: Violation[];
  silverNdcg: number;
  silverPrecision: number;
  handNdcg: number;
  handPrecision: number;
  mustNotHits: MustNotHit[];
  siblingShare: number;
  fallbackRate: number;
  seeds: SeedResult[];
  gates: GateResult[];
}

// ---------- Eligibility ----------

const liveOn = (s: OperatorState | undefined, brand: BrandId) => !!s && s.status === "live" && s.brands.includes(brand) && !s.quarantined;

export function requestsFor(ctx: MatchingContext): MatchRequest[] {
  return Brand.options.flatMap((brand) =>
    [...ctx.truth.keys()].filter((id) => liveOn(ctx.operator.get(id), brand)).map((seedId) => ({ brand, seedId })),
  );
}

/** The real game behind an id, resolving duplicate listings to their original. */
const truthOf = (id: string, ctx: MatchingContext) => ctx.truth.get(ctx.duplicates[id] ?? id);

const stepUp = (seed: GroundTruthGame, c: GroundTruthGame) => VOLATILITY_LEVEL[c.volatility] - VOLATILITY_LEVEL[seed.volatility];

export function violationsFor(req: MatchRequest, gameId: string, ctx: MatchingContext): Violation[] {
  const v = (kind: Violation["kind"], detail: string): Violation => ({ ...req, gameId, kind, detail });
  const seed = ctx.truth.get(req.seedId)!;
  const game = truthOf(gameId, ctx);
  if (!game) return [v("unknown_game", "not in the catalogue")];
  const out: Violation[] = [];
  if (gameId === req.seedId) out.push(v("seed_itself", "recommended the seed"));
  if (ctx.duplicates[gameId]) out.push(v("duplicate_listing", `duplicate of ${ctx.duplicates[gameId]}`));
  const state = ctx.operator.get(gameId);
  if (state?.quarantined) out.push(v("quarantined", state.quarantineReason ?? "quarantined"));
  else if (!liveOn(state, req.brand)) out.push(v("not_live_on_brand", `${state?.status ?? "no state"} / brands ${state?.brands.join(",") ?? "none"}`));
  if (stepUp(seed, game) > ctx.maxVolatilityStepUp) out.push(v("volatility_step_up", `${seed.volatility} → ${game.volatility}`));
  return out;
}

/** Candidates a perfect ranker could return for this request. */
export function eligibleFor(req: MatchRequest, ctx: MatchingContext): GroundTruthGame[] {
  return [...ctx.truth.values()].filter((g) => violationsFor(req, g.id, ctx).length === 0);
}

// ---------- Metrics ----------

export function ndcg(grades: number[], idealGrades: number[], k: number): number {
  const dcg = (gs: number[]) => gs.slice(0, k).reduce((sum, g, i) => sum + (2 ** g - 1) / Math.log2(i + 2), 0);
  const ideal = dcg([...idealGrades].sort((a, b) => b - a));
  return ideal === 0 ? 1 : dcg(grades) / ideal;
}

/** Share of the k slots filled with a game graded 2 or more. Empty slots count as misses. */
export const precisionAtK = (grades: number[], k: number) => grades.slice(0, k).filter((g) => g >= 2).length / k;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function handGrades(items: string[], labels: SeedLabels) {
  const grade = new Map(labels.relevant.map((r) => [r.gameId, r.grade]));
  return items.map((id) => grade.get(id) ?? 0);
}

function handIdeal(req: MatchRequest, labels: SeedLabels, ctx: MatchingContext) {
  const eligible = new Set(eligibleFor(req, ctx).map((g) => g.id));
  return labels.relevant.filter((r) => eligible.has(r.gameId)).map((r) => r.grade);
}

// ---------- Score ----------

interface Evaluated {
  result: SeedResult;
  violations: Violation[];
  mustNot: MustNotHit[];
  silverNdcg: number;
  silverPrecision: number;
  handPrecision: number | null;
  siblings: number;
}

function evaluate(ranker: Ranker, req: MatchRequest, ctx: MatchingContext): Evaluated {
  const res = ranker.rank(req.seedId, req.brand, ctx.k, ctx.operator);
  const items = res.items.slice(0, ctx.k).map((i) => i.gameId);
  const seed = ctx.truth.get(req.seedId)!;
  const silver = items.map((id) => (truthOf(id, ctx) && !ctx.duplicates[id] ? silverGrade(seed, truthOf(id, ctx)!) : 0));
  const labels = ctx.labels.seeds.find((s) => s.seedId === req.seedId);
  const hand = labels ? handGrades(items, labels) : null;
  return {
    result: { ...req, items, reason: res.reason, handNdcg: labels ? ndcg(hand!, handIdeal(req, labels, ctx), ctx.k) : null },
    violations: items.flatMap((id) => violationsFor(req, id, ctx)),
    mustNot: labels ? labels.mustNot.filter((m) => items.includes(m.gameId)).map((m) => ({ ...req, gameId: m.gameId, rationale: m.rationale })) : [],
    silverNdcg: ndcg(silver, eligibleFor(req, ctx).map((g) => silverGrade(seed, g)), ctx.k),
    silverPrecision: precisionAtK(silver, ctx.k),
    handPrecision: hand ? precisionAtK(hand, ctx.k) : null,
    siblings: items.filter((id) => seed.familyId !== null && truthOf(id, ctx)?.familyId === seed.familyId).length,
  };
}

export function scoreRanker(name: string, ranker: Ranker, ctx: MatchingContext): RankerScore {
  const all = requestsFor(ctx).map((req) => evaluate(ranker, req, ctx));
  const labelled = all.filter((e) => e.result.handNdcg !== null);
  const totalItems = all.reduce((n, e) => n + e.result.items.length, 0);
  const hardViolations = all.flatMap((e) => e.violations);
  const mustNotHits = all.flatMap((e) => e.mustNot);
  const handNdcg = mean(labelled.map((e) => e.result.handNdcg!));
  const silverNdcg = mean(all.map((e) => e.silverNdcg));
  const fallbackRate = all.length ? all.filter((e) => e.result.reason !== null).length / all.length : 0;
  return {
    name,
    requests: all.length,
    hardViolations,
    silverNdcg,
    silverPrecision: mean(all.map((e) => e.silverPrecision)),
    handNdcg,
    handPrecision: mean(labelled.map((e) => e.handPrecision!)),
    mustNotHits,
    siblingShare: totalItems ? all.reduce((n, e) => n + e.siblings, 0) / totalItems : 0,
    fallbackRate,
    seeds: all.map((e) => e.result),
    gates: [
      gate("Hard violations (wrong brand, not live, quarantined, seed, duplicate, volatility step-up)", "block", hardViolations.length, "<=", T.hardViolations),
      gate("Hand-label must-not hits", "warn", mustNotHits.length, "<=", T.mustNotHits),
      gate("nDCG@5, silver labels", "warn", silverNdcg, ">=", T.silverNdcg),
      gate("nDCG@5, hand labels", "warn", handNdcg, ">=", T.handNdcg),
      gate("Fallback rate", "warn", fallbackRate, "<=", T.fallbackRate),
    ],
  };
}
