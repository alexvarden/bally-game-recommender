/** Hand labels for the matching eval: schema, loading and validation against the catalogue. */
import { readFileSync } from "node:fs";
import { z } from "zod";

export const LABELS_PATH = "evals/matching/labels.json";

const Judgement = z.object({ gameId: z.string(), rationale: z.string().min(5) });

export const HandLabels = z.object({
  about: z.string(),
  seeds: z.array(
    z.object({
      seedId: z.string(),
      why: z.string(),
      relevant: z.array(Judgement.extend({ grade: z.number().int().min(1).max(3) })).min(1),
      mustNot: z.array(Judgement),
    }),
  ),
});
export type HandLabels = z.infer<typeof HandLabels>;
export type SeedLabels = HandLabels["seeds"][number];

export function loadLabels(path = LABELS_PATH): HandLabels {
  return HandLabels.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Every id a label mentions must exist, and no game may be both relevant and must-not for one seed. */
export function labelProblems(labels: HandLabels, knownIds: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const s of labels.seeds) {
    const ids = [s.seedId, ...s.relevant.map((r) => r.gameId), ...s.mustNot.map((m) => m.gameId)];
    for (const id of ids) if (!knownIds.has(id)) problems.push(`${s.seedId}: unknown game ${id}`);
    const relevant = new Set(s.relevant.map((r) => r.gameId));
    for (const m of s.mustNot) if (relevant.has(m.gameId)) problems.push(`${s.seedId}: ${m.gameId} is both relevant and must-not`);
    if (relevant.has(s.seedId)) problems.push(`${s.seedId}: labelled relevant to itself`);
  }
  return problems;
}
