import { z } from "zod";

/**
 * Catalogue schema.
 *
 * The data moves through these shapes:
 *   GroundTruthGame + GroundTruthDocument – complete, clean, generated. Only the generator and the eval see these.
 *   RawFeedRecord + GameDocument          – what the service ingests: a thin structured feed plus unstructured docs.
 *   SourceGame                            – the feed after deterministic normalisation (code, not LLM).
 *   LlmEnrichment                         – what the LLM returns: values with an optional evidence quote.
 *   EnrichedGame                          – after code has checked every quote and assigned provenance.
 *
 * Two different trust rules:
 *   Descriptive fields (theme, mood, mechanics…) may be extracted from a doc or inferred.
 *   Regulated facts (RTP, max win, stakes, volatility, hit frequency) may be extracted with a verified quote, never inferred.
 *
 * See features-list.md for the rationale behind each field.
 */

// ---------- Enums ----------

export const Brand = z.enum([
  "jackpotjoy",
  "virgin_games",
  "monopoly_casino",
  "rainbow_riches_casino",
  "double_bubble_bingo",
  "bally_casino_us",
]);

export const Jurisdiction = z.enum(["GB", "ES", "US-NJ", "US-PA"]);

export const Status = z.enum(["live", "coming_soon", "suspended", "retired"]);

export const SupplyChannel = z.enum(["in_house", "aggregator"]);

export const FamilyRole = z.enum(["base", "variant"]);

export const Format = z.enum([
  "video_slot",
  "classic_slot",
  "slingo",
  "bingo",
  "live_dealer",
  "table",
  "instant_win",
  "crash",
  "game_show",
]);

export const Theme = z.enum([
  "ancient_egypt",
  "irish_luck",
  "norse_myth",
  "greek_myth",
  "fruit_classic",
  "fishing",
  "animals_wildlife",
  "gems_treasure",
  "horror_halloween",
  "asian_fortune",
  "wild_west",
  "tv_gameshow",
  "adventure_exploration",
  "fantasy_magic",
  "space_scifi",
  "food_sweets",
  "music_party",
  "seasonal_festive",
  "luxury_vegas",
  "sport",
]);

export const Mood = z.enum(["cosy", "epic", "spooky", "retro", "glamorous", "comedic", "mysterious", "adrenaline"]);

export const ArtStyle = z.enum(["cartoon", "realistic_3d", "painterly", "retro_pixel", "fruit_machine", "live_video"]);

export const PayStructure = z.enum(["paylines", "ways", "megaways", "cluster_pays", "pay_anywhere", "not_applicable"]);

/** The single trait that defines how the game plays. Secondary features are listed separately. */
export const CoreMechanic = z.enum([
  "hold_and_win",
  "cascades",
  "expanding_wilds",
  "sticky_wilds",
  "multipliers",
  "cash_collect",
  "pick_me_bonus",
  "wheel_bonus",
  "free_spins",
  "slingo_grid",
  "bingo_ball_draw",
  "live_wheel",
  "card_table",
  "scratch_reveal",
  "crash_multiplier",
]);

export const SecondaryFeature = z.enum([
  "free_spins",
  "retriggers",
  "mystery_symbols",
  "respins",
  "random_wilds",
  "symbol_upgrades",
  "gamble_feature",
  "bonus_buy",
  "side_bets",
  "progressive_reels",
]);

export const BonusStyle = z.enum(["frequent_small", "balanced", "rare_big", "none"]);

export const JackpotType = z.enum(["none", "fixed", "local_progressive", "network_progressive"]);

export const Complexity = z.enum(["simple", "moderate", "feature_heavy"]);

export const Pace = z.enum(["relaxed", "steady", "frenetic"]);

export const ExcitementCurve = z.enum(["steady_trickle", "slow_build", "bursty_chase"]);

export const SocialElement = z.enum(["none", "shared_room", "live_host", "community_jackpot"]);

export const Volatility = z.enum(["low", "medium", "high", "very_high"]);

export const RgFlag = z.enum(["may_appeal_to_under_18s", "do_not_promote", "high_intensity"]);

export const DocumentKind = z.enum(["marketing_blurb", "rules_text", "release_note", "editorial"]);

/** Wire format a doc arrives in. Rendered by the messy-docs skill; normalised to text before extraction. */
export const DocumentFormat = z.enum(["cms_html", "aggregator_xml", "markdown", "email", "pdf_text"]);

/** How a resolved value was obtained. Assigned by code after checking evidence, never by the LLM. */
export const Provenance = z.enum(["feed", "extracted", "inferred", "operator", "unknown"]);

/** Defects planted by the generator so the eval can check each one is handled. */
export const DefectKind = z.enum([
  "thin_record", // name and blurb only: enrichment should abstain rather than guess
  "truncated_rules", // rules text cut off before the bonus section
  "wrong_game_rules", // rules text copy-pasted from another game
  "volatility_conflict", // blurb and release note disagree on volatility
  "feed_omits_feature", // rules describe a mechanic the feed's features field leaves out
  "theme_only_in_prose", // no theme field; theme appears only in a document
  "duplicate_listing", // same game supplied twice under different ids
  "rg_sensitive_thin", // content that could appeal to under-18s, with only a one-line description
]);

// ---------- Field groups ----------

/** Content and experience: may be extracted or inferred, and feed the embedding. */
const descriptiveFields = {
  primaryTheme: Theme,
  subThemes: z.array(z.string().min(1)).max(6),
  mood: Mood,
  artStyle: ArtStyle,
  narrativeHook: z.string().max(160),
  coreMechanic: CoreMechanic,
  secondaryFeatures: z.array(SecondaryFeature),
  bonusStyle: BonusStyle,
  complexity: Complexity,
  pace: Pace,
  excitementCurve: ExcitementCurve,
  socialElement: SocialElement,
  nostalgia: z.boolean(),
};

/** Game structure: may be extracted or inferred from documents (e.g. "243 ways" → ways). */
const structuralFields = {
  format: Format,
  payStructure: PayStructure,
  grid: z.object({ reels: z.number().int().positive(), rows: z.number().int().positive() }).nullable(),
  paylines: z.number().int().positive().nullable(),
  jackpotType: JackpotType,
};

/** Regulated or certified facts: extracted with a verified quote, never inferred. */
const regulatedFields = {
  volatility: Volatility,
  rtp: z.number().min(0.8).max(0.995),
  maxWinMultiplier: z.number().positive(),
  minStake: z.number().positive(),
  maxStake: z.number().positive(),
  hitFrequency: z.number().min(0).max(1).nullable(),
};

/** Operator-owned facts: come only from the feed. Neither extracted nor inferred. */
const operatorFields = {
  id: z.string().regex(/^BLY-[A-Z]{3}-\d{4}$/),
  supplierGameCode: z.string(),
  name: z.string().min(1),
  studio: z.string(),
  supplyChannel: SupplyChannel,
  familyId: z.string().nullable(),
  familyRole: FamilyRole.nullable(),
  licensedIp: z.string().nullable(),
  brands: z.array(Brand).min(1),
  jurisdictions: z.array(Jurisdiction).min(1),
  status: Status,
  releaseDate: z.iso.date(),
  rgFlags: z.array(RgFlag),
};

export const ExtractableField = z.enum([
  ...(Object.keys(descriptiveFields) as (keyof typeof descriptiveFields)[]),
  ...(Object.keys(structuralFields) as (keyof typeof structuralFields)[]),
  ...(Object.keys(regulatedFields) as (keyof typeof regulatedFields)[]),
]);
export type ExtractableField = z.infer<typeof ExtractableField>;

export const REGULATED_FIELDS = Object.keys(regulatedFields) as (keyof typeof regulatedFields)[];

/** Descriptive values an operator has set by hand. They win over feed and LLM values and survive re-enrichment. */
export const DescriptiveOverrides = z.object(descriptiveFields).partial();
export type DescriptiveOverrides = z.infer<typeof DescriptiveOverrides>;

// ---------- Ground truth (generator output, eval reference) ----------

export const PlantedDefect = z.object({
  kind: DefectKind,
  detail: z.string(),
  relatedGameId: z.string().nullable(),
  docId: z.string().nullable(),
});

export const GroundTruthGame = z.object({
  ...operatorFields,
  ...structuralFields,
  ...regulatedFields,
  ...descriptiveFields,
  /** The clean reference description; the eval compares enriched descriptions against it. */
  description: z.string().min(40),
  plantedDefects: z.array(PlantedDefect),
});
export type GroundTruthGame = z.infer<typeof GroundTruthGame>;

/**
 * Documents are generated as tagged sections, so the degrade step can truncate a doc
 * and still know exactly which facts survived. That separates a correct `null` from a missed extraction.
 */
export const GroundTruthDocument = z.object({
  docId: z.string(),
  gameId: z.string(),
  kind: DocumentKind,
  source: z.string(),
  receivedAt: z.string(),
  sections: z
    .array(z.object({ heading: z.string().nullable(), text: z.string().min(1), facts: z.array(ExtractableField) }))
    .min(1),
});
export type GroundTruthDocument = z.infer<typeof GroundTruthDocument>;

// ---------- What the service ingests ----------

/**
 * A thin structured feed. Feeds disagree on naming, units and formats:
 * rtp may be 96.5, "96.5%", "0.965" or "96,5"; volatility may be "Med", "4/5" or missing.
 */
export const RawFeedRecord = z
  .object({
    id: z.string(),
    supplier_code: z.string().optional(),
    name: z.string(),
    studio: z.string().optional(),
    channel: z.string().optional(),
    family: z.string().optional(),
    type: z.string().optional(),
    theme: z.string().optional(),
    features: z.string().optional(),
    licensed_ip: z.string().optional(),
    reels: z.string().optional(),
    lines: z.union([z.string(), z.number()]).optional(),
    jackpot: z.string().optional(),
    volatility: z.string().optional(),
    rtp: z.union([z.string(), z.number()]).optional(),
    max_win: z.union([z.string(), z.number()]).optional(),
    stake_range: z.string().optional(),
    hit_freq: z.union([z.string(), z.number()]).optional(),
    brands: z.string().optional(),
    markets: z.string().optional(),
    status: z.string().optional(),
    release_date: z.string().optional(),
    rg_flags: z.string().optional(),
  })
  .loose();
export type RawFeedRecord = z.infer<typeof RawFeedRecord>;

/** An unstructured document as received. The ground-truth section tags are removed. */
export const GameDocument = z.object({
  docId: z.string(),
  gameId: z.string(),
  kind: DocumentKind,
  format: DocumentFormat,
  contentType: z.string(),
  source: z.string(),
  receivedAt: z.string(),
  /** Raw bytes as received: HTML, XML, Markdown, email or PDF-extracted text. */
  text: z.string(),
});
export type GameDocument = z.infer<typeof GameDocument>;

// ---------- Normalised feed ----------

/** Every field is nullable: unknown is a valid answer, a guess is not. */
export const SourceGame = z.object({
  id: operatorFields.id,
  name: operatorFields.name,
  supplierGameCode: operatorFields.supplierGameCode.nullable(),
  studio: operatorFields.studio.nullable(),
  supplyChannel: SupplyChannel.nullable(),
  familyId: operatorFields.familyId,
  familyRole: operatorFields.familyRole,
  licensedIp: operatorFields.licensedIp,
  brands: z.array(Brand),
  jurisdictions: z.array(Jurisdiction),
  status: Status.nullable(),
  releaseDate: operatorFields.releaseDate.nullable(),
  rgFlags: z.array(RgFlag),
  /** Whatever the feed supplied for structure, regulated facts and descriptive fields that normalised cleanly. */
  feedValues: z
    .object({ ...structuralFields, ...regulatedFields, ...descriptiveFields })
    .partial(),
});
export type SourceGame = z.infer<typeof SourceGame>;

// ---------- LLM enrichment output ----------

const Confidence = z.number().min(0).max(1);

export const Evidence = z.object({
  docId: z.string(),
  /** Must appear verbatim in the doc after whitespace normalisation, or the value is rejected. */
  quote: z.string().min(3).max(300),
});
export type Evidence = z.infer<typeof Evidence>;

/** Descriptive or structural value: evidence optional. With no evidence, the value is treated as inferred. */
const llmField = <T extends z.ZodType>(value: T) =>
  z.object({ value: value.nullable(), evidence: Evidence.nullable(), confidence: Confidence });

/** Regulated value: evidence required. The only way to abstain is a null field. */
const llmRegulatedField = <T extends z.ZodType>(value: T) =>
  z.object({ value, evidence: Evidence, confidence: Confidence }).nullable();

/**
 * The only shape the enrichment LLM may return. Operator-owned facts (brands, jurisdictions, status) are absent
 * by construction, so the model can't write them.
 */
export const LlmEnrichment = z.object({
  cleanDescription: z.string().min(40).max(600),
  descriptive: z.object({
    primaryTheme: llmField(Theme),
    subThemes: llmField(descriptiveFields.subThemes),
    mood: llmField(Mood),
    artStyle: llmField(ArtStyle),
    narrativeHook: llmField(descriptiveFields.narrativeHook),
    coreMechanic: llmField(CoreMechanic),
    secondaryFeatures: llmField(descriptiveFields.secondaryFeatures),
    bonusStyle: llmField(BonusStyle),
    complexity: llmField(Complexity),
    pace: llmField(Pace),
    excitementCurve: llmField(ExcitementCurve),
    socialElement: llmField(SocialElement),
    nostalgia: llmField(z.boolean()),
  }),
  structural: z.object({
    format: llmField(Format),
    payStructure: llmField(PayStructure),
    grid: llmField(z.object({ reels: z.number().int().positive(), rows: z.number().int().positive() })),
    paylines: llmField(z.number().int().positive()),
    jackpotType: llmField(JackpotType),
  }),
  regulated: z.object({
    volatility: llmRegulatedField(Volatility),
    rtp: llmRegulatedField(regulatedFields.rtp),
    maxWinMultiplier: llmRegulatedField(regulatedFields.maxWinMultiplier),
    minStake: llmRegulatedField(regulatedFields.minStake),
    maxStake: llmRegulatedField(regulatedFields.maxStake),
    hitFrequency: llmRegulatedField(z.number().min(0).max(1)),
  }),
  /** Suggested only. A human reviews these before they become filters. */
  suggestedRgFlags: z.array(z.object({ flag: RgFlag, reason: z.string() })),
  /** Disagreements between sources, e.g. blurb says "low volatility" but the release note says 5/5. */
  conflicts: z.array(z.object({ field: ExtractableField, docIds: z.array(z.string()), detail: z.string() })),
  /** A doc that appears to describe a different game, e.g. copy-pasted rules. Its evidence is ignored. */
  suspectDocs: z.array(z.object({ docId: z.string(), reason: z.string() })),
});
export type LlmEnrichment = z.infer<typeof LlmEnrichment>;

// ---------- Verified, merged record (what the index is built from) ----------

const resolvedField = <T extends z.ZodType>(value: T) =>
  z.object({
    value: value.nullable(),
    provenance: Provenance,
    evidence: Evidence.nullable(),
    confidence: Confidence,
  });

const resolvedFields = <S extends Record<string, z.ZodType>>(shape: S) =>
  z.object(
    Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, resolvedField(v)])) as {
      [K in keyof S]: ReturnType<typeof resolvedField<S[K]>>;
    },
  );

export const RejectedEvidence = z.object({
  field: ExtractableField,
  docId: z.string(),
  quote: z.string(),
  reason: z.enum(["quote_not_found", "value_not_in_quote", "suspect_doc", "regulated_without_evidence"]),
});

export const EnrichedGame = z.object({
  ...SourceGame.omit({ feedValues: true }).shape,
  description: z.string(),
  fields: resolvedFields({ ...descriptiveFields, ...structuralFields, ...regulatedFields }),
  suggestedRgFlags: LlmEnrichment.shape.suggestedRgFlags,
  conflicts: LlmEnrichment.shape.conflicts,
  rejected: z.array(RejectedEvidence),
  meta: z.object({
    sourceHash: z.string(),
    promptVersion: z.string(),
    model: z.string(),
    enrichedAt: z.iso.datetime(),
  }),
});
export type EnrichedGame = z.infer<typeof EnrichedGame>;
