/**
 * Enrichment eval: scores EnrichedGame[] against the ground truth and per-document truth.
 *
 * Different fields are held to different standards, matching the trust tiers in src/catalogue/schema.ts:
 *   regulated    any wrong, unevidenced or invented value is a release-blocking violation
 *   structural   scored for accuracy where available; must abstain (null) where no source states it
 *   inferable    scored for accuracy everywhere; inference from other facts is allowed, so no abstention metric
 *   free text    subThemes and narrativeHook aren't scored (wording legitimately differs)
 */
import { REGULATED_FIELDS, type EnrichedGame, type ExtractableField, type GroundTruthGame } from "../../src/catalogue/schema.ts";
import { ENRICHMENT_THRESHOLDS as T, gate, type GateResult } from "../gates.ts";
import { availableFacts, type ReferenceData } from "../lib/data.ts";

export const STRUCTURAL_FIELDS = ["format", "payStructure", "grid", "paylines", "jackpotType"] as const;
export const INFERABLE_FIELDS = ["primaryTheme", "mood", "artStyle", "coreMechanic", "secondaryFeatures", "bonusStyle", "complexity", "pace", "excitementCurve", "socialElement", "nostalgia"] as const;
const EVIDENCE_FIELDS: readonly ExtractableField[] = [...REGULATED_FIELDS, ...STRUCTURAL_FIELDS];
const SCORED_FIELDS: readonly ExtractableField[] = [...REGULATED_FIELDS, ...STRUCTURAL_FIELDS, ...INFERABLE_FIELDS];

type Resolved = EnrichedGame["fields"][keyof EnrichedGame["fields"]];

export interface FieldStats {
  available: number;
  correct: number;
  missed: number;
  unavailable: number;
  abstained: number;
}

export interface FailureCase {
  gameId: string;
  name: string;
  kind: string;
  detail: string;
}

export interface DefectStats {
  planted: number;
  detected: number;
  recall: number;
  misses: string[];
}

export interface EnrichmentScore {
  games: number;
  missingGames: string[];
  perField: Record<string, FieldStats>;
  accuracy: number;
  abstentionRate: number;
  regulatedViolations: FailureCase[];
  quoteRejectionRate: number;
  defects: Record<string, DefectStats>;
  volatilityFalseFlags: number;
  failures: FailureCase[];
  gates: GateResult[];
}

// ---------- Value comparison ----------

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(b));

export function jaccard(a: readonly unknown[], b: readonly unknown[]): number {
  const sa = new Set(a.map(String));
  const sb = new Set(b.map(String));
  if (sa.size === 0 && sb.size === 0) return 1;
  const inter = [...sa].filter((x) => sb.has(x)).length;
  return inter / (sa.size + sb.size - inter);
}

/** Whether an enriched value matches the truth. Sets match at Jaccard ≥ 0.5; numbers within a small tolerance. */
export function matches(value: unknown, truth: unknown): boolean {
  if (value === null || value === undefined) return truth === null;
  if (typeof value === "number" && typeof truth === "number") return close(value, truth);
  if (Array.isArray(value) && Array.isArray(truth)) return jaccard(value, truth) >= 0.5;
  if (typeof value === "object" && typeof truth === "object") return JSON.stringify(value) === JSON.stringify(truth);
  return value === truth;
}

// ---------- Per-game checks ----------

const fieldOf = (g: EnrichedGame, f: ExtractableField): Resolved => (g.fields as Record<string, Resolved>)[f]!;

const failure = (g: EnrichedGame, kind: string, detail: string): FailureCase => ({ gameId: g.id, name: g.name, kind, detail });

/** Regulated facts: wrong, inferred, extracted without a quote, or invented where no source states them. */
export function regulatedViolations(g: EnrichedGame, truth: GroundTruthGame, available: Set<ExtractableField>): FailureCase[] {
  const out: FailureCase[] = [];
  for (const f of REGULATED_FIELDS) {
    const r = fieldOf(g, f);
    if (r.value === null) continue;
    const t = truth[f];
    if (!matches(r.value, t)) out.push(failure(g, "regulated_wrong", `${f} = ${JSON.stringify(r.value)}, truth ${JSON.stringify(t)}`));
    else if (r.provenance === "inferred" || r.provenance === "unknown") out.push(failure(g, "regulated_unevidenced", `${f} has provenance ${r.provenance}`));
    else if (r.provenance === "extracted" && r.evidence === null) out.push(failure(g, "regulated_unevidenced", `${f} extracted with no quote`));
    else if (!available.has(f) && r.provenance !== "operator") out.push(failure(g, "regulated_invented", `${f} stated by no source`));
  }
  return out;
}

const emptyStats = (): FieldStats => ({ available: 0, correct: 0, missed: 0, unavailable: 0, abstained: 0 });

function tallyField(stats: FieldStats, f: ExtractableField, r: Resolved, truthValue: unknown, avail: { available: Set<ExtractableField>; partial: Set<ExtractableField> }) {
  if (avail.partial.has(f)) return;
  if (avail.available.has(f) || (INFERABLE_FIELDS as readonly string[]).includes(f)) {
    stats.available++;
    if (matches(r.value, truthValue)) stats.correct++;
    else if (r.value === null) stats.missed++;
    return;
  }
  stats.unavailable++;
  if (r.value === null) stats.abstained++;
}

// ---------- Defects ----------

const gamesWith = (ref: ReferenceData, defect: string) => [...ref.plans.values()].filter((p) => p.defects.includes(defect as never)).map((p) => p.id);

function recall(planted: string[], detected: (id: string) => boolean): DefectStats {
  const misses = planted.filter((id) => !detected(id));
  return { planted: planted.length, detected: planted.length - misses.length, recall: planted.length ? 1 - misses.length / planted.length : 1, misses };
}

const usedEvidenceFrom = (g: EnrichedGame, docId: string) =>
  Object.values(g.fields as Record<string, Resolved>).some((r) => r.evidence?.docId === docId && r.provenance === "extracted");

export function defectRecall(byId: Map<string, EnrichedGame>, ref: ReferenceData) {
  const rulesDoc = (id: string) => `${id}-rules_text`;
  const flaggedSuspect = (id: string) => {
    const g = byId.get(id);
    if (!g) return false;
    const doc = rulesDoc(id);
    const flagged = g.rejected.some((r) => r.docId === doc && r.reason === "suspect_doc") || g.conflicts.some((c) => c.docIds.includes(doc));
    return flagged && !usedEvidenceFrom(g, doc);
  };
  return {
    volatility_conflict: recall(gamesWith(ref, "volatility_conflict"), (id) => !!byId.get(id)?.conflicts.some((c) => c.field === "volatility")),
    wrong_game_rules: recall(gamesWith(ref, "wrong_game_rules"), flaggedSuspect),
    rg_sensitive_thin: recall(gamesWith(ref, "rg_sensitive_thin"), (id) => {
      const g = byId.get(id);
      return !!g && (g.rgFlags.includes("may_appeal_to_under_18s") || g.suggestedRgFlags.some((s) => s.flag === "may_appeal_to_under_18s"));
    }),
    // A duplicate is handled when it doesn't survive as a separate live game.
    duplicate_listing: recall(Object.keys(ref.duplicates), (dupId) => !(byId.get(dupId)?.status === "live")),
  };
}

// ---------- Score ----------

const ratio = (num: number, den: number) => (den === 0 ? 1 : num / den);

function quoteRejectionRate(games: EnrichedGame[]) {
  const rejected = games.reduce((n, g) => n + g.rejected.length, 0);
  const extracted = games.reduce((n, g) => n + Object.values(g.fields as Record<string, Resolved>).filter((r) => r.provenance === "extracted").length, 0);
  return ratio(rejected, rejected + extracted);
}

function fieldFailures(g: EnrichedGame, truth: GroundTruthGame, avail: ReturnType<typeof availableFacts>): FailureCase[] {
  return SCORED_FIELDS.filter((f) => !REGULATED_FIELDS.includes(f as never) && avail.available.has(f))
    .filter((f) => fieldOf(g, f).value !== null && !matches(fieldOf(g, f).value, truth[f]))
    .map((f) => failure(g, "field_wrong", `${f} = ${JSON.stringify(fieldOf(g, f).value)}, truth ${JSON.stringify(truth[f])}`));
}

export function scoreEnrichment(games: EnrichedGame[], ref: ReferenceData): EnrichmentScore {
  const byId = new Map(games.map((g) => [g.id, g]));
  const perField: Record<string, FieldStats> = Object.fromEntries(SCORED_FIELDS.map((f) => [f, emptyStats()]));
  const violations: FailureCase[] = [];
  const failures: FailureCase[] = [];

  for (const truth of ref.truth.values()) {
    const g = byId.get(truth.id);
    if (!g) continue;
    const avail = availableFacts(truth.id, ref);
    for (const f of SCORED_FIELDS) tallyField(perField[f]!, f, fieldOf(g, f), truth[f], avail);
    violations.push(...regulatedViolations(g, truth, avail.available));
    failures.push(...fieldFailures(g, truth, avail));
  }

  const sum = (fields: readonly string[], k: keyof FieldStats) => fields.reduce((n, f) => n + perField[f]![k], 0);
  const accuracy = ratio(sum(SCORED_FIELDS, "correct"), sum(SCORED_FIELDS, "available"));
  const abstentionRate = ratio(sum(EVIDENCE_FIELDS, "abstained"), sum(EVIDENCE_FIELDS, "unavailable"));
  const defects = defectRecall(byId, ref);
  const conflictGames = new Set(gamesWith(ref, "volatility_conflict"));
  const volatilityFalseFlags = games.filter((g) => !conflictGames.has(g.id) && g.conflicts.some((c) => c.field === "volatility")).length;
  const rejectionRate = quoteRejectionRate(games);
  const worstRecall = Math.min(...Object.values(defects).map((d) => d.recall));

  return {
    games: games.length,
    missingGames: [...ref.truth.keys()].filter((id) => !byId.has(id)),
    perField,
    accuracy,
    abstentionRate,
    regulatedViolations: violations,
    quoteRejectionRate: rejectionRate,
    defects,
    volatilityFalseFlags,
    failures: [...violations, ...failures],
    gates: [
      gate("Regulated facts wrong, unevidenced or invented", "block", violations.length, "<=", T.regulatedViolations),
      gate("Quote rejection rate", "warn", rejectionRate, "<=", T.quoteRejectionRate),
      gate("Accuracy on available facts", "warn", accuracy, ">=", T.accuracy),
      gate("Abstention where no source states the fact", "warn", abstentionRate, ">=", T.abstentionRate),
      gate("Worst planted-defect recall", "warn", worstRecall, ">=", T.defectRecall),
    ],
  };
}
