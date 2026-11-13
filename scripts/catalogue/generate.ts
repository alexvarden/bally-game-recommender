/**
 * Step 2 of catalogue generation: the LLM writes the creative content around the planned facts.
 *
 * For each planned game the model writes a name, descriptive fields and the game's source documents as
 * tagged sections. Code keeps every regulated number from the plan, checks the model used them verbatim,
 * and drops any tag it can't verify, so the ground truth never contains a number the model made up.
 *
 * Batches are cached by content hash, so re-runs only pay for batches that changed or failed.
 *
 * Usage: node --env-file-if-exists=.env scripts/catalogue/generate.ts [--batches N] [--fake]
 *   --batches N  generate only the first N batches (to check quality before paying for the rest)
 *   --fake       template content, no API calls; for exercising the pipeline only
 * Env:   OPENROUTER_API_KEY or ANTHROPIC_API_KEY, CATALOGUE_MODEL (default openai/gpt-6-luna via OpenRouter)
 * Output: data/catalogue/ground-truth.json
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  ArtStyle,
  BonusStyle,
  Complexity,
  DocumentKind,
  ExcitementCurve,
  ExtractableField,
  GroundTruthDocument,
  GroundTruthGame,
  Mood,
  Pace,
  SecondaryFeature,
  SocialElement,
} from "../../src/catalogue/schema.ts";
import { argValue, hasFlag, isMain } from "../../src/lib/cli.ts";
import { generateStructured, LlmError } from "../../src/lib/llm.ts";
import { Plan, PLAN_PATH, type PlannedGame } from "./plan.ts";

export const GROUND_TRUTH_PATH = "data/catalogue/ground-truth.json";
const CACHE_DIR = "data/catalogue/.cache";
const PROMPT_VERSION = "gen-v1";
const DEFAULT_MODEL = "openai/gpt-6-luna";
const BATCH_SIZE = 4;
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;

// ---------- What the model returns ----------

const GeneratedSection = z.object({
  heading: z.string().nullable(),
  text: z.string(),
  tags: z.array(ExtractableField),
});

const GeneratedGame = z.object({
  id: z.string(),
  name: z.string(),
  licensedIp: z.string().nullable(),
  subThemes: z.array(z.string()),
  mood: Mood,
  artStyle: ArtStyle,
  narrativeHook: z.string(),
  secondaryFeatures: z.array(SecondaryFeature),
  bonusStyle: BonusStyle,
  complexity: Complexity,
  pace: Pace,
  excitementCurve: ExcitementCurve,
  socialElement: SocialElement,
  nostalgia: z.boolean(),
  description: z.string(),
  documents: z.array(z.object({ kind: DocumentKind, sections: z.array(GeneratedSection) })),
});
type GeneratedGame = z.infer<typeof GeneratedGame>;

const GeneratedBatch = z.object({ games: z.array(GeneratedGame) });

export const GroundTruth = z.object({
  meta: z.object({ model: z.string(), promptVersion: z.string(), planSeed: z.number(), generatedAt: z.string() }),
  games: z.array(GroundTruthGame),
  documents: z.array(GroundTruthDocument),
  warnings: z.array(z.string()),
});
export type GroundTruth = z.infer<typeof GroundTruth>;

// ---------- Display strings: the exact text the docs must use for each regulated number ----------

const money = (g: PlannedGame, n: number) => `${g.currency === "GBP" ? "£" : "$"}${n.toFixed(2)}`;
const VOL_TEXT = { low: "Low (2/5)", medium: "Medium (3/5)", high: "High (4/5)", very_high: "Very High (5/5)" };

export function displayFacts(g: PlannedGame) {
  return {
    rtp: `${(g.rtp * 100).toFixed(2)}%`,
    maxWinMultiplier: `${g.maxWinMultiplier.toLocaleString("en-GB")}x`,
    minStake: money(g, g.minStake),
    maxStake: money(g, g.maxStake),
    hitFrequency: g.hitFrequency === null ? null : `1 in ${(1 / g.hitFrequency).toFixed(1)}`,
    paylines: g.paylines === null ? null : g.paylines.toLocaleString("en-GB"),
    volatility: VOL_TEXT[g.volatility],
  };
}

// ---------- Prompt ----------

const SYSTEM = `You write source material for a fictional online casino game catalogue. It is test data for a UK-regulated operator's recommendation system, so it must read like real supplier and operator content.

You receive planned games with fixed facts. For each, write the creative content and the source documents.

Hard rules:
- Use the planned facts exactly. Where a document states a regulated number (RTP, max win, stakes, hit frequency, paylines/ways, volatility), copy the given display string verbatim, e.g. "96.12%", "5,000x", "£0.10", "1 in 3.4". Never state a different value for any of them.
- All names are fictional. Do not use or imitate real game titles, real studios or real licensed brands. Studio names are given; use them.
- If hasLicensedIp is true, invent a fictional licence (e.g. a made-up 1980s TV quiz show) and set licensedIp to its name; otherwise null.
- Variants in a family share the base game's name stem: "Pharaoh's Vault" → "Pharaoh's Vault Megaways".
- Slots and Slingo have 1–3 secondaryFeatures (free_spins is common but not universal); other formats usually have 0–1. Only include bonus_buy when bonusBuyAllowed is true.
- Responsible tone: no "guaranteed wins", no urgency, nothing aimed at under-18s. Cartoon or sweet themes are fine, but describe them plainly.
- The description is the clean, complete reference description: 3–5 sentences covering theme, how it plays and how it feels.

Documents: write exactly the planned document kinds, each as sections. Keep one kind of fact per section where you can, so a section can be removed without losing others.
- marketing_blurb: supplier hype, 1–3 sentences in one section. Theme, mood, the headline feature. At most one number (usually max win). If the game has the "thin_record" or "rg_sensitive_thin" defect, write ONE short generic sentence that names the theme loosely and nothing else.
- rules_text: the dry in-game help page. Sections such as "Game Overview" (grid, paylines/ways), "How to Play", one section for the core mechanic and one per secondary feature, "Game Information" (stakes, max win), and a final "Return to Player" section stating "The theoretical RTP of this game is <rtp>." Procedural, no hype.
- release_note: a supplier launch note to the operator. One section of "Key: value" lines (choose from Volatility, RTP, Max win, Hit frequency, Min bet, Max bet, Release date, Ways/Lines), plus a short prose section on the selling points. Vary the key names between games.
- editorial: the operator content team's lobby copy. 2–3 short paragraphs on mood, pace, who it suits, what it reminds you of. No regulated numbers.

Tags: on each section, list only the fields that section states or clearly shows: ${ExtractableField.options.join(", ")}. Don't tag a field just because it fits the game; it must be readable from that section's text alone. Experience fields (pace, excitementCurve, bonusStyle, complexity) need explicit wording such as "fast-paced" or "frequent small features", not just a general vibe.`;

export function promptFor(batch: PlannedGame[], usedNames: string[]) {
  const games = batch.map((g) => ({
    id: g.id,
    studio: g.studio,
    format: g.format,
    family: g.familyId ? { familyId: g.familyId, role: g.familyRole, variantKind: g.variantKind } : null,
    primaryTheme: g.primaryTheme,
    coreMechanic: g.coreMechanic,
    payStructure: g.payStructure,
    grid: g.grid,
    jackpotType: g.jackpotType,
    display: displayFacts(g),
    hasLicensedIp: g.hasLicensedIp,
    bonusBuyAllowed: g.bonusBuyAllowed,
    documents: g.documents,
    defects: g.defects.filter((d) => d === "thin_record" || d === "rg_sensitive_thin"),
  }));
  return [
    `Planned games:\n${JSON.stringify(games, null, 2)}`,
    usedNames.length ? `Names already used (don't reuse or closely echo them, except for family name stems): ${usedNames.join("; ")}` : "",
    "Return one entry per planned game, with the same id.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------- Validation against the plan ----------

const NUMERIC_TAGS = ["rtp", "maxWinMultiplier", "minStake", "maxStake", "hitFrequency", "paylines"] as const;

type Display = ReturnType<typeof displayFacts>;
type Section = GeneratedGame["documents"][number]["sections"][number];

function assertPlannedDocuments(plan: PlannedGame, gen: GeneratedGame) {
  const want = [...plan.documents].sort().join(",");
  const got = gen.documents.map((d) => d.kind).sort().join(",");
  if (want !== got) throw new Error(`${plan.id}: documents ${got} != planned ${want}`);
}

/** A percentage in any doc that isn't the RTP is a contradicting fact, not a style choice. */
function assertNoConflictingRtp(plan: PlannedGame, gen: GeneratedGame, display: Display) {
  const allText = gen.documents.flatMap((d) => d.sections.map((s) => s.text)).join("\n");
  for (const m of allText.matchAll(/\b(\d{2}\.\d{1,2})\s?%/g)) {
    if (`${m[1]}%` !== display.rtp) throw new Error(`${plan.id}: doc states ${m[0]} but RTP is ${display.rtp}`);
  }
}

const isNumericTag = (tag: string): tag is (typeof NUMERIC_TAGS)[number] => (NUMERIC_TAGS as readonly string[]).includes(tag);

/**
 * Keeps a numeric tag only if the section contains the exact display string, and adds tags the model forgot,
 * so the ground truth never claims a number that isn't there. Returns a warning per dropped tag.
 */
export function verifyNumericTags(section: Section, display: Display, where: string): string[] {
  const warnings: string[] = [];
  section.tags = section.tags.filter((tag) => {
    if (!isNumericTag(tag)) return true;
    const want = display[tag];
    const ok = want !== null && section.text.includes(want);
    if (!ok) warnings.push(`${where}: dropped tag ${tag}; section doesn't contain "${want}"`);
    return ok;
  });
  for (const tag of NUMERIC_TAGS) {
    const want = display[tag];
    // Short paylines like "5" match too easily by accident, so they are never added.
    const findable = want !== null && !(tag === "paylines" && want.length < 3);
    if (findable && !section.tags.includes(tag) && section.text.includes(want)) section.tags.push(tag);
  }
  return warnings;
}

function removeDisallowedBonusBuy(plan: PlannedGame, gen: GeneratedGame): string[] {
  if (plan.bonusBuyAllowed || !gen.secondaryFeatures.includes("bonus_buy")) return [];
  gen.secondaryFeatures = gen.secondaryFeatures.filter((f) => f !== "bonus_buy");
  return [`${plan.id}: removed bonus_buy (not allowed in GB)`];
}

/** Throws on output we must not accept; fixes what it safely can and returns a warning for each fix. */
export function checkGame(plan: PlannedGame, gen: GeneratedGame): string[] {
  assertPlannedDocuments(plan, gen);
  const display = displayFacts(plan);
  assertNoConflictingRtp(plan, gen, display);
  const tagWarnings = gen.documents.flatMap((doc) => doc.sections.flatMap((s) => verifyNumericTags(s, display, `${plan.id}/${doc.kind}`)));
  return [...tagWarnings, ...removeDisallowedBonusBuy(plan, gen)];
}

export function assemble(plan: PlannedGame, gen: GeneratedGame) {
  const game: GroundTruthGame = GroundTruthGame.parse({
    id: plan.id,
    supplierGameCode: plan.supplierGameCode,
    name: gen.name,
    studio: plan.studio,
    supplyChannel: plan.supplyChannel,
    familyId: plan.familyId,
    familyRole: plan.familyRole,
    licensedIp: plan.hasLicensedIp ? gen.licensedIp : null,
    brands: plan.brands,
    jurisdictions: plan.jurisdictions,
    status: plan.status,
    releaseDate: plan.releaseDate,
    rgFlags: plan.rgFlags,
    format: plan.format,
    payStructure: plan.payStructure,
    grid: plan.grid,
    paylines: plan.paylines,
    jackpotType: plan.jackpotType,
    volatility: plan.volatility,
    rtp: plan.rtp,
    maxWinMultiplier: plan.maxWinMultiplier,
    minStake: plan.minStake,
    maxStake: plan.maxStake,
    hitFrequency: plan.hitFrequency,
    description: gen.description,
    primaryTheme: plan.primaryTheme,
    subThemes: gen.subThemes.slice(0, 6),
    mood: gen.mood,
    artStyle: gen.artStyle,
    narrativeHook: gen.narrativeHook.slice(0, 160),
    coreMechanic: plan.coreMechanic,
    secondaryFeatures: gen.secondaryFeatures,
    bonusStyle: gen.bonusStyle,
    complexity: gen.complexity,
    pace: gen.pace,
    excitementCurve: gen.excitementCurve,
    socialElement: gen.socialElement,
    nostalgia: gen.nostalgia,
    plantedDefects: plan.defects.map((kind) => ({ kind, detail: "", relatedGameId: plan.relatedGameId, docId: null })),
  });

  const documents = gen.documents.map((d) =>
    GroundTruthDocument.parse({
      docId: `${plan.id}-${d.kind}`,
      gameId: plan.id,
      kind: d.kind,
      source: d.kind === "editorial" ? "Operator CMS" : plan.aggregator ? `${plan.aggregator} / ${plan.studio}` : plan.studio,
      receivedAt: plan.releaseDate,
      sections: d.sections.map((s) => ({ heading: s.heading, text: s.text, facts: [...new Set(s.tags)] })),
    }),
  );
  return { game, documents };
}

// ---------- Batching, caching, calling ----------

/** Groups games into batches without splitting a family, so variants can share the base's name. */
export function batchesOf(games: PlannedGame[]): PlannedGame[][] {
  const batches: PlannedGame[][] = [];
  let current: PlannedGame[] = [];
  for (let i = 0; i < games.length; i++) {
    const g = games[i]!;
    const familySize = g.familyRole === "base" ? games.filter((o) => o.familyId === g.familyId).length : 1;
    if (g.familyRole !== "variant" && current.length > 0 && current.length + familySize > BATCH_SIZE) {
      batches.push(current);
      current = [];
    }
    current.push(g);
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Template content with no API call, for exercising the pipeline end to end. Never commit its output. */
export function fakeBatch(batch: PlannedGame[]): GeneratedGame[] {
  return batch.map((p) => {
    const d = displayFacts(p);
    const name = `Fake ${p.primaryTheme.replace(/_/g, " ")} ${p.id.slice(-4)}`;
    const sections: Record<string, GeneratedGame["documents"][number]["sections"]> = {
      marketing_blurb: [{ heading: null, text: `Spin into a ${p.primaryTheme.replace(/_/g, " ")} adventure with wins up to ${d.maxWinMultiplier}!`, tags: ["primaryTheme", "maxWinMultiplier"] }],
      rules_text: [
        { heading: "Game Overview", text: `${name} is a ${p.format.replace(/_/g, " ")}${d.paylines ? ` with ${d.paylines} ${p.payStructure === "paylines" ? "paylines" : "ways"}` : ""}.`, tags: ["format", ...(d.paylines ? (["paylines", "payStructure"] as const) : [])] },
        { heading: "Feature", text: `The ${p.coreMechanic.replace(/_/g, " ")} feature is the heart of the game.`, tags: ["coreMechanic"] },
        { heading: "Game Information", text: `Min bet: ${d.minStake}\nMax bet: ${d.maxStake}\nMax win: ${d.maxWinMultiplier}`, tags: ["minStake", "maxStake", "maxWinMultiplier"] },
        { heading: "Return to Player", text: `The theoretical RTP of this game is ${d.rtp}.`, tags: ["rtp"] },
      ],
      release_note: [
        { heading: "Key facts", text: `Volatility: ${d.volatility}\nRTP: ${d.rtp}${d.hitFrequency ? `\nHit frequency: ${d.hitFrequency}` : ""}`, tags: ["volatility", "rtp", ...(d.hitFrequency ? (["hitFrequency"] as const) : [])] },
        { heading: null, text: `A strong ${p.primaryTheme.replace(/_/g, " ")} release from ${p.studio}.`, tags: ["primaryTheme"] },
      ],
      editorial: [{ heading: null, text: `A steady, cosy game that suits a relaxed evening.`, tags: ["pace", "mood"] }],
    };
    return {
      id: p.id,
      name,
      licensedIp: p.hasLicensedIp ? "Fake Licence" : null,
      subThemes: [p.primaryTheme],
      mood: "cosy",
      artStyle: "cartoon",
      narrativeHook: "A fake hook.",
      secondaryFeatures: ["free_spins"],
      bonusStyle: "balanced",
      complexity: "moderate",
      pace: "steady",
      excitementCurve: "slow_build",
      socialElement: "none",
      nostalgia: false,
      description: `Fake description for ${name}. It exists only to exercise the pipeline without calling an LLM.`,
      documents: p.documents.map((kind) => ({ kind, sections: sections[kind]! })),
    };
  });
}

export interface GenerateDeps {
  llm: typeof generateStructured;
  model: string;
  cacheDir: string;
  fake: boolean;
}

export interface BatchResult {
  games: GeneratedGame[];
  cached: boolean;
  usage: { input: number; output: number };
}

const NO_USAGE = { input: 0, output: 0 };

function assertBatchIds(batch: PlannedGame[], out: z.infer<typeof GeneratedBatch>) {
  const got = out.games.map((g) => g.id).sort().join(",");
  const want = batch.map((g) => g.id).sort().join(",");
  if (got !== want) throw new Error(`returned ids ${got}, expected ${want}`);
  // Validate on copies: checkGame fixes tags in place, and the cache should hold the raw response.
  batch.forEach((p) => checkGame(p, structuredClone(out.games.find((g) => g.id === p.id)!)));
}

async function callModel(batch: PlannedGame[], usedNames: string[], deps: GenerateDeps): Promise<BatchResult> {
  const response = await deps.llm({
    schema: GeneratedBatch,
    schemaName: "catalogue_batch",
    model: deps.model,
    maxTokens: 24000,
    system: SYSTEM,
    user: promptFor(batch, usedNames),
  });
  assertBatchIds(batch, response.data);
  return { games: response.data.games, cached: false, usage: { input: response.usage.inputTokens, output: response.usage.outputTokens } };
}

export function cachePathFor(batch: PlannedGame[], deps: Pick<GenerateDeps, "model" | "cacheDir">) {
  const key = createHash("sha256").update(JSON.stringify({ PROMPT_VERSION, MODEL: deps.model, SYSTEM, batch })).digest("hex").slice(0, 16);
  return `${deps.cacheDir}/${batch[0]!.id}-${key}.json`;
}

/** One batch: from cache if present, otherwise the model with retries on retryable failures. */
export async function generateBatch(batch: PlannedGame[], usedNames: string[], deps: GenerateDeps): Promise<BatchResult> {
  if (deps.fake) return { games: fakeBatch(batch), cached: false, usage: NO_USAGE };
  const cachePath = cachePathFor(batch, deps);
  if (existsSync(cachePath)) return { games: GeneratedBatch.parse(JSON.parse(readFileSync(cachePath, "utf8"))).games, cached: true, usage: NO_USAGE };

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await callModel(batch, usedNames, deps);
      mkdirSync(deps.cacheDir, { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ games: result.games }, null, 2));
      return result;
    } catch (err) {
      lastError = err;
      console.warn(`  batch ${batch[0]!.id} attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
      if (err instanceof LlmError && !err.retryable) break;
    }
  }
  throw lastError;
}

/** Runs batches in waves; each wave sees the names used by earlier waves. */
export async function generateAll(batches: PlannedGame[][], deps: GenerateDeps) {
  const generated = new Map<string, GeneratedGame>();
  const usedNames: string[] = [];
  const usage = { input: 0, output: 0 };
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const results = await Promise.all(batches.slice(i, i + CONCURRENCY).map((b) => generateBatch(b, [...usedNames], deps)));
    results.forEach((r, j) => {
      console.log(`  batch ${i + j + 1}/${batches.length} ${r.cached ? "(cached)" : "done"}: ${r.games.map((g) => g.name).join(" | ")}`);
      r.games.forEach((g) => (generated.set(g.id, g), usedNames.push(g.name)));
      usage.input += r.usage.input;
      usage.output += r.usage.output;
    });
  }
  return { generated, usedNames, usage };
}

/** Checks every generated game against its plan and assembles the ground truth. */
export function buildGroundTruth(plan: Plan, generated: Map<string, GeneratedGame>, meta: GroundTruth["meta"]): GroundTruth {
  const names = plan.games.map((p) => generated.get(p.id)!.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) throw new Error(`duplicate names: ${dupes.join(", ")}. Delete the affected cache files and re-run.`);

  const warnings: string[] = [];
  const games: GroundTruthGame[] = [];
  const documents: GroundTruthDocument[] = [];
  for (const p of plan.games) {
    const gen = structuredClone(generated.get(p.id)!);
    warnings.push(...checkGame(p, gen));
    const assembled = assemble(p, gen);
    games.push(assembled.game);
    documents.push(...assembled.documents);
  }
  return GroundTruth.parse({ meta, games, documents, warnings });
}

export interface RunOptions {
  planPath: string;
  outPath: string;
  batchLimit: number;
  deps: GenerateDeps;
}

export function optionsFrom(argv: readonly string[], env: NodeJS.ProcessEnv): RunOptions {
  return {
    planPath: PLAN_PATH,
    outPath: GROUND_TRUTH_PATH,
    batchLimit: hasFlag(argv, "--batches") ? Number(argValue(argv, "--batches", "1")) : Infinity,
    deps: { llm: generateStructured, model: env.CATALOGUE_MODEL ?? DEFAULT_MODEL, cacheDir: CACHE_DIR, fake: hasFlag(argv, "--fake") },
  };
}

export async function run(opts: RunOptions): Promise<GroundTruth | null> {
  const plan = Plan.parse(JSON.parse(readFileSync(opts.planPath, "utf8")));
  const batches = batchesOf(plan.games).slice(0, opts.batchLimit);
  console.log(`${plan.games.length} games, running ${batches.length} batches, model ${opts.deps.model}`);

  const { generated, usage } = await generateAll(batches, opts.deps);
  console.log(`tokens this run: ${usage.input} in / ${usage.output} out`);
  if (Number.isFinite(opts.batchLimit)) {
    console.log("partial run: batches cached; ground truth not written. Run without --batches to finish.");
    return null;
  }

  const meta = { model: opts.deps.fake ? "fake" : opts.deps.model, promptVersion: PROMPT_VERSION, planSeed: plan.seed, generatedAt: new Date().toISOString() };
  const truth = buildGroundTruth(plan, generated, meta);
  writeFileSync(opts.outPath, JSON.stringify(truth, null, 2));
  console.log(`wrote ${truth.games.length} games and ${truth.documents.length} documents to ${opts.outPath} (${truth.warnings.length} warnings)`);
  return truth;
}

if (isMain(import.meta.url)) await run(optionsFrom(process.argv, process.env));
