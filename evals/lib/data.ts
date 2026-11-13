/**
 * Reference data the evals score against. Everything here is answer key: the pipeline must never read it.
 */
import { readFileSync } from "node:fs";
import { RawFeedRecord, type ExtractableField, type GroundTruthGame } from "../../src/catalogue/schema.ts";
import { DocumentTruth, Manifest } from "../../scripts/catalogue/degrade.ts";
import { GroundTruth, GROUND_TRUTH_PATH } from "../../scripts/catalogue/generate.ts";
import { Plan, PLAN_PATH, type PlannedGame } from "../../scripts/catalogue/plan.ts";

export const CATALOGUE_DIR = "data/catalogue";

export interface ReferenceData {
  truth: Map<string, GroundTruthGame>;
  plans: Map<string, PlannedGame>;
  docTruth: DocumentTruth[];
  feed: Map<string, RawFeedRecord>;
  /** Duplicate listing id → the original game id. */
  duplicates: Record<string, string>;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

export function loadReference(dir = CATALOGUE_DIR): ReferenceData {
  const truth = GroundTruth.parse(readJson(dir === CATALOGUE_DIR ? GROUND_TRUTH_PATH : `${dir}/ground-truth.json`));
  const plan = Plan.parse(readJson(dir === CATALOGUE_DIR ? PLAN_PATH : `${dir}/plan.json`));
  const docTruth = (readJson(`${dir}/documents.truth.json`) as unknown[]).map((d) => DocumentTruth.parse(d));
  const feed = (readJson(`${dir}/catalogue.raw.json`) as unknown[]).map((r) => RawFeedRecord.parse(r));
  const manifest = Manifest.parse(readJson(`${dir}/manifest.json`));
  return {
    truth: new Map(truth.games.map((g) => [g.id, g])),
    plans: new Map(plan.games.map((p) => [p.id, p])),
    docTruth,
    feed: new Map(feed.map((r) => [r.id, r])),
    duplicates: manifest.duplicates,
  };
}

/** Which feed keys carry which extractable facts, when the key is present at all. */
const FEED_FIELDS: Partial<Record<keyof RawFeedRecord, ExtractableField[]>> = {
  type: ["format"],
  theme: ["primaryTheme"],
  features: ["secondaryFeatures"],
  reels: ["grid"],
  lines: ["paylines", "payStructure"],
  jackpot: ["jackpotType"],
  volatility: ["volatility"],
  rtp: ["rtp"],
  max_win: ["maxWinMultiplier"],
  stake_range: ["minStake", "maxStake"],
  hit_freq: ["hitFrequency"],
};

/**
 * Facts a perfect pipeline could know for a game: present in the feed, or stated in full in a document that
 * really describes this game. Facts only in a truncated section (partialFacts) are neither required nor penalised.
 */
export function availableFacts(gameId: string, ref: ReferenceData): { available: Set<ExtractableField>; partial: Set<ExtractableField> } {
  const available = new Set<ExtractableField>();
  const partial = new Set<ExtractableField>();
  const record = ref.feed.get(gameId);
  for (const [key, fields] of Object.entries(FEED_FIELDS)) {
    if (record && record[key as keyof RawFeedRecord] !== undefined) fields!.forEach((f) => available.add(f));
  }
  // The feed lists features; the core mechanic is in it unless the feed_omits_feature defect removed it.
  if (record?.features && !ref.plans.get(gameId)?.defects.includes("feed_omits_feature")) available.add("coreMechanic");
  for (const doc of ref.docTruth.filter((d) => d.gameId === gameId)) {
    doc.survivingFacts.forEach((f) => available.add(f));
    doc.partialFacts.forEach((f) => partial.add(f));
  }
  for (const f of available) partial.delete(f);
  return { available, partial };
}
