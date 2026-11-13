/**
 * `npm run eval`: scores enrichment and matching and writes evals/reports/latest.md.
 *
 * Inputs: the enrichment output at data/enriched/games.json if the pipeline has produced it; otherwise the report
 * says so and shows only the calibration rows. Operator state comes from the ground truth until the pipeline's
 * store is wired in. Offline and deterministic: no LLM calls.
 *
 * Usage: node evals/report.ts [--enriched data/enriched/games.json] [--out evals/reports/latest.md] [--strict]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EnrichedGame } from "../src/catalogue/schema.ts";
import { argValue, hasFlag, isMain } from "../src/lib/cli.ts";
import { groundTruthAsEnriched, operatorStateFrom } from "../src/testing/fixtures.ts";
import { scoreEnrichment, type EnrichmentScore, type FailureCase } from "./enrichment/score.ts";
import { corruptEnrichment, idealEnrichment } from "./enrichment/synthetic.ts";
import { releasable, type GateResult } from "./gates.ts";
import { loadReference, type ReferenceData } from "./lib/data.ts";
import { loadLabels } from "./matching/labels.ts";
import { scoreRanker, type MatchingContext, type RankerScore } from "./matching/score.ts";
import { rankersFor } from "./rankers.ts";

export const ENRICHED_PATH = "data/enriched/games.json";
export const REPORT_PATH = "evals/reports/latest.md";

// ---------- Formatting ----------

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const num = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(3));

export function table(header: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

export function renderGates(gates: GateResult[]): string {
  const rows = gates.map((g) => [g.pass ? "✅" : g.level === "block" ? "❌" : "⚠️", g.level, g.name, num(g.value), `${g.comparison} ${g.threshold}`]);
  return `${table(["", "Level", "Gate", "Value", "Threshold"], rows)}\n\n**${releasable(gates) ? "Releasable" : "Not releasable"}**: every blocking gate ${releasable(gates) ? "passes" : "must pass"}.`;
}

// ---------- Enrichment ----------

function enrichmentRow(label: string, s: EnrichmentScore) {
  const recall = (k: string) => `${s.defects[k]!.detected}/${s.defects[k]!.planted}`;
  return [label, s.games, s.regulatedViolations.length, pct(s.accuracy), pct(s.abstentionRate), pct(s.quoteRejectionRate), recall("volatility_conflict"), recall("wrong_game_rules"), recall("rg_sensitive_thin"), recall("duplicate_listing")];
}

function perFieldTable(s: EnrichmentScore): string {
  const rows = Object.entries(s.perField).map(([f, st]) => [f, st.available, st.available ? pct(st.correct / st.available) : "–", st.missed, st.unavailable, st.unavailable ? pct(st.abstained / st.unavailable) : "–"]);
  return table(["Field", "Scored", "Accuracy", "Missed", "No source", "Abstained"], rows);
}

export function renderEnrichment(primary: { label: string; score: EnrichmentScore } | null, calibration: { label: string; score: EnrichmentScore }[]): string {
  const rows = [...(primary ? [primary] : []), ...calibration].map((r) => enrichmentRow(r.label, r.score));
  const header = ["Output", "Games", "Regulated violations", "Accuracy", "Abstention", "Quote rejection", "Vol. conflict", "Wrong rules", "RG suggest", "Duplicates"];
  return [
    "## Enrichment",
    primary ? "" : "> **No pipeline output yet** (`data/enriched/games.json` is missing). Only calibration rows are shown; gates below are for the ideal calibration output.",
    table(header, rows),
    "### Per field" + (primary ? "" : " (ideal calibration output)"),
    perFieldTable((primary ?? calibration[0]!).score),
    "### Gates",
    renderGates((primary ?? calibration[0]!).score.gates),
  ].filter(Boolean).join("\n\n");
}

// ---------- Matching ----------

function matchingRow(s: RankerScore, flags: { candidate?: boolean; calibration?: boolean }) {
  const label = `${s.name}${flags.candidate ? " **(candidate)**" : ""}${flags.calibration ? " _(calibration)_" : ""}`;
  return [label, s.requests, s.hardViolations.length, num(s.silverNdcg), pct(s.silverPrecision), num(s.handNdcg), pct(s.handPrecision), s.mustNotHits.length, pct(s.siblingShare), pct(s.fallbackRate)];
}

export function renderMatching(scores: { score: RankerScore; candidate?: boolean; calibration?: boolean }[]): string {
  const header = ["Ranker", "Requests", "Hard violations", "nDCG@5 silver", "P@5 silver", "nDCG@5 hand", "P@5 hand", "Must-not hits", "Family share", "Fallback"];
  const candidate = scores.find((s) => s.candidate) ?? scores[0]!;
  return ["## Matching", table(header, scores.map((s) => matchingRow(s.score, s))), `### Gates (${candidate.score.name})`, renderGates(candidate.score.gates)].join("\n\n");
}

// ---------- Failure cases ----------

function enrichmentFailures(s: EnrichmentScore, limit: number): string[] {
  const byKind = (k: string) => s.failures.filter((f) => f.kind === k);
  const fmt = (f: FailureCase) => `- **${f.name}** (\`${f.gameId}\`): ${f.detail}`;
  const missed = Object.entries(s.defects).flatMap(([k, d]) => d.misses.map((id) => `- Missed planted \`${k}\` on \`${id}\``));
  return [...byKind("regulated_wrong"), ...byKind("regulated_unevidenced"), ...byKind("regulated_invented")].slice(0, limit).map(fmt).concat(missed, byKind("field_wrong").slice(0, limit).map(fmt));
}

function matchingFailures(s: RankerScore, ref: ReferenceData, limit: number): string[] {
  const name = (id: string) => ref.truth.get(ref.duplicates[id] ?? id)?.name ?? id;
  const violations = s.hardViolations.slice(0, limit).map((v) => `- ${v.brand}: **${name(v.seedId)}** → ${name(v.gameId)}: ${v.kind} (${v.detail})`);
  const mustNot = s.mustNotHits.slice(0, limit).map((m) => `- ${m.brand}: **${name(m.seedId)}** → ${name(m.gameId)}: ${m.rationale}`);
  const worst = s.seeds
    .filter((r) => r.handNdcg !== null)
    .sort((a, b) => a.handNdcg! - b.handNdcg!)
    .slice(0, 3)
    .map((r) => `- ${r.brand}: **${name(r.seedId)}** nDCG ${num(r.handNdcg!)}: got ${r.items.map(name).join(", ") || "nothing"}${r.reason ? ` (${r.reason})` : ""}`);
  return [...violations, ...mustNot, ...worst];
}

export function renderFailures(enrichment: EnrichmentScore | null, matching: RankerScore, ref: ReferenceData, unknownVolatility: number): string {
  return [
    "## Where it goes wrong",
    "### Enrichment",
    enrichment ? enrichmentFailures(enrichment, 10).join("\n") || "_No failures._" : "_No pipeline output to inspect yet._",
    `### Matching (${matching.name})`,
    matchingFailures(matching, ref, 10).join("\n") || "_No failures._",
    "### Design tension",
    `- ${unknownVolatility} games have no known volatility. The guardrail can't check a step-up it can't measure, so it excludes them; seeds with unknown volatility get no recommendations and fall back. Correct abstention in enrichment therefore costs coverage in matching.`,
  ].join("\n\n");
}

// ---------- Build ----------

export interface ReportInputs {
  ref: ReferenceData;
  enriched: EnrichedGame[] | null;
}

export function buildReport({ ref, enriched }: ReportInputs) {
  const ideal = idealEnrichment(ref);
  const answerKey = groundTruthAsEnriched();
  const primary = enriched ? { label: "pipeline output", score: scoreEnrichment(enriched, ref) } : null;
  const calibration = [
    { label: "ideal _(calibration)_", score: scoreEnrichment(ideal, ref) },
    { label: "corrupted _(calibration)_", score: scoreEnrichment(corruptEnrichment(ideal, ref), ref) },
  ];

  const games = enriched ?? ideal;
  const ctx: MatchingContext = {
    truth: ref.truth,
    operator: new Map([...ref.truth.values()].map((g) => [g.id, operatorStateFrom(g)])),
    duplicates: ref.duplicates,
    labels: loadLabels(),
    k: 5,
    maxVolatilityStepUp: 1,
  };
  const matching = rankersFor(games, ref.truth, answerKey).map((r) => ({ ...r, score: scoreRanker(r.name, r.ranker, ctx) }));
  const candidate = matching.find((m) => m.candidate)!.score;
  const unknownVolatility = games.filter((g) => g.fields.volatility.value === null).length;

  const markdown = [
    "# Evaluation report",
    `Matching rankers run over ${enriched ? "the pipeline's enrichment" : "the **ideal calibration enrichment**"}. Hand labels: ${ctx.labels.seeds.length} seeds. Gates: see \`evals/GATES.md\`.`,
    renderEnrichment(primary, calibration),
    renderMatching(matching),
    renderFailures(primary?.score ?? null, candidate, ref, unknownVolatility),
  ].join("\n\n");
  const gates = [...(primary ?? calibration[0]!).score.gates, ...candidate.gates];
  return { markdown, gates };
}

export function loadEnriched(path: string): EnrichedGame[] | null {
  if (!existsSync(path)) return null;
  return (JSON.parse(readFileSync(path, "utf8")) as unknown[]).map((g) => EnrichedGame.parse(g));
}

export function run(argv: readonly string[]): number {
  const out = argValue(argv, "--out", REPORT_PATH);
  const { markdown, gates } = buildReport({ ref: loadReference(), enriched: loadEnriched(argValue(argv, "--enriched", ENRICHED_PATH)) });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${markdown}\n`);
  console.log(`wrote ${out}; ${releasable(gates) ? "all blocking gates pass" : "a blocking gate FAILS"}`);
  return hasFlag(argv, "--strict") && !releasable(gates) ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(run(process.argv));
