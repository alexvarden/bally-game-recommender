/** Builders for enrichment tests: a small game, its documents, and LLM responses with every field abstaining. */
import type { LlmEnrichment, SourceGame } from "../catalogue/schema.ts";
import type { NormalisedDocument } from "../contracts/storage.ts";

export const source = (feedValues: SourceGame["feedValues"] = {}): SourceGame => ({
  id: "BLY-SLT-0001",
  name: "Frost Saga",
  supplierGameCode: "FJO1234",
  studio: "Fjord Games",
  supplyChannel: "aggregator",
  familyId: null,
  familyRole: null,
  licensedIp: null,
  brands: ["jackpotjoy"],
  jurisdictions: ["GB"],
  status: "live",
  releaseDate: "2025-01-01",
  rgFlags: [],
  feedValues,
});

export const documents: NormalisedDocument[] = [
  {
    docId: "rules",
    gameId: "BLY-SLT-0001",
    kind: "rules_text",
    format: "cms_html",
    contentType: "text/html",
    source: "Fjord Games",
    receivedAt: "2025-01-01",
    rawKey: "k",
    text: "Frost Saga\nA Norse winter slot on a 5-reel, 3-row grid.\nVolatility: High (4/5)\nMax win: 5,000x\nMin bet: £0.10\nThe theoretical RTP of this game is 96.12%.",
  },
  { docId: "blurb", gameId: "BLY-SLT-0001", kind: "marketing_blurb", format: "aggregator_xml", contentType: "application/xml", source: "Hub", receivedAt: "2025-01-01", rawKey: "k2", text: "Big pirate wins on the high seas! RTP 97.50%." },
];

const nothing = { value: null, evidence: null, confidence: 0 };

export function llmResponse(over: Partial<{ descriptive: Partial<LlmEnrichment["descriptive"]>; structural: Partial<LlmEnrichment["structural"]>; regulated: Partial<LlmEnrichment["regulated"]> }> & Partial<Pick<LlmEnrichment, "suspectDocs" | "conflicts" | "suggestedRgFlags">> = {}): LlmEnrichment {
  return {
    cleanDescription: "A Norse winter slot with free spins and a steady pace for relaxed play.",
    descriptive: {
      primaryTheme: nothing, subThemes: nothing, mood: nothing, artStyle: nothing, narrativeHook: nothing, coreMechanic: nothing,
      secondaryFeatures: nothing, bonusStyle: nothing, complexity: nothing, pace: nothing, excitementCurve: nothing,
      socialElement: nothing, nostalgia: nothing,
      ...over.descriptive,
    },
    structural: { format: nothing, payStructure: nothing, grid: nothing, paylines: nothing, jackpotType: nothing, ...over.structural },
    regulated: { volatility: null, rtp: null, maxWinMultiplier: null, minStake: null, maxStake: null, hitFrequency: null, ...over.regulated },
    suggestedRgFlags: over.suggestedRgFlags ?? [],
    conflicts: over.conflicts ?? [],
    suspectDocs: over.suspectDocs ?? [],
  };
}

export const quote = (docId: string, text: string) => ({ docId, quote: text });
