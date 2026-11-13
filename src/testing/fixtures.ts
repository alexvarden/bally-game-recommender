/**
 * Test and development fixtures built from the committed ground truth.
 *
 * `groundTruthAsEnriched()` turns each ground-truth game into an EnrichedGame as if enrichment were perfect. Use it
 * to build and test similarity, the service and the evals before (or independently of) real enrichment output.
 * Never use it as eval *output*: it is the answer key.
 */
import { readFileSync } from "node:fs";
import type { EnrichedGame, GroundTruthGame } from "../catalogue/schema.ts";
import type { OperatorState } from "../contracts/storage.ts";
import { GroundTruth, GROUND_TRUTH_PATH } from "../../scripts/catalogue/generate.ts";

const RESOLVED_FIELDS = [
  "primaryTheme", "subThemes", "mood", "artStyle", "narrativeHook", "coreMechanic", "secondaryFeatures", "bonusStyle",
  "complexity", "pace", "excitementCurve", "socialElement", "nostalgia",
  "format", "payStructure", "grid", "paylines", "jackpotType",
  "volatility", "rtp", "maxWinMultiplier", "minStake", "maxStake", "hitFrequency",
] as const;

export function loadGroundTruth(path = GROUND_TRUTH_PATH) {
  return GroundTruth.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function enrichedFromTruth(g: GroundTruthGame): EnrichedGame {
  const fields = Object.fromEntries(
    RESOLVED_FIELDS.map((k) => [k, { value: g[k], provenance: "feed", evidence: null, confidence: 1 }]),
  ) as EnrichedGame["fields"];
  return {
    id: g.id,
    name: g.name,
    supplierGameCode: g.supplierGameCode,
    studio: g.studio,
    supplyChannel: g.supplyChannel,
    familyId: g.familyId,
    familyRole: g.familyRole,
    licensedIp: g.licensedIp,
    brands: g.brands,
    jurisdictions: g.jurisdictions,
    status: g.status,
    releaseDate: g.releaseDate,
    rgFlags: g.rgFlags,
    description: g.description,
    fields,
    suggestedRgFlags: [],
    conflicts: [],
    rejected: [],
    meta: { sourceHash: "ground-truth", promptVersion: "none", model: "ground-truth", enrichedAt: "2026-11-13T00:00:00.000Z" },
  };
}

export const groundTruthAsEnriched = (path?: string) => loadGroundTruth(path).games.map(enrichedFromTruth);

export function operatorStateFrom(g: Pick<EnrichedGame, "id" | "status" | "brands" | "rgFlags">): OperatorState {
  // A game whose status is unknown is never served, so it defaults to suspended.
  return { gameId: g.id, status: g.status ?? "suspended", brands: g.brands, rgFlags: g.rgFlags, quarantined: false, quarantineReason: null, overrides: {}, updatedAt: "2026-11-13T00:00:00.000Z" };
}
