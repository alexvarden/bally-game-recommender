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
import { generateStructured, LlmError } from "../../src/lib/llm.ts";
import { Plan, PLAN_PATH, type PlannedGame } from "./plan.ts";

export const GROUND_TRUTH_PATH = "data/catalogue/ground-truth.json";
const CACHE_DIR = "data/catalogue/.cache";
const PROMPT_VERSION = "gen-v1";
const MODEL = process.env.CATALOGUE_MODEL ?? "openai/gpt-6-luna";
const BATCH_SIZE = 4;
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const FAKE = process.argv.includes("--fake");
const BATCH_LIMIT = process.argv.includes("--batches") ? Number(process.argv[process.argv.indexOf("--batches") + 1]) : Infinity;
const usage = { input: 0, output: 0 };

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

function promptFor(batch: PlannedGame[], usedNames: string[]) {
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

/** Throws on output we must not accept; returns warnings for tags it had to drop. */
function checkGame(plan: PlannedGame, gen: GeneratedGame): string[] {
  const warnings: string[] = [];
  const wantKinds = [...plan.documents].sort().join(",");
  const gotKinds = gen.documents.map((d) => d.kind).sort().join(",");
  if (wantKinds !== gotKinds) throw new Error(`${plan.id}: documents ${gotKinds} != planned ${wantKinds}`);

  const display = displayFacts(plan);
  const allText = gen.documents.flatMap((d) => d.sections.map((s) => s.text)).join("\n");

  // A percentage in any doc that isn't the RTP is a contradicting fact, not a style choice.
  for (const m of allText.matchAll(/\b(\d{2}\.\d{1,2})\s?%/g)) {
    if (`${m[1]}%` !== display.rtp) throw new Error(`${plan.id}: doc states ${m[0]} but RTP is ${display.rtp}`);
  }

  for (const doc of gen.documents) {
    for (const s of doc.sections) {
      s.tags = s.tags.filter((tag) => {
        if (!(NUMERIC_TAGS as readonly string[]).includes(tag)) return true;
        const want = display[tag as (typeof NUMERIC_TAGS)[number]];
        const ok = want !== null && s.text.includes(want);
        if (!ok) warnings.push(`${plan.id}/${doc.kind}: dropped tag ${tag}; section doesn't contain "${want}"`);
        return ok;
      });
      // Add numeric tags the model forgot, so truncation ground truth stays honest.
      for (const tag of NUMERIC_TAGS) {
        const want = display[tag];
        if (want && !s.tags.includes(tag) && s.text.includes(want) && !(tag === "paylines" && want.length < 3)) s.tags.push(tag);
      }
    }
  }

  if (!plan.bonusBuyAllowed && gen.secondaryFeatures.includes("bonus_buy")) {
    gen.secondaryFeatures = gen.secondaryFeatures.filter((f) => f !== "bonus_buy");
    warnings.push(`${plan.id}: removed bonus_buy (not allowed in GB)`);
  }
  return warnings;
}

function assemble(plan: PlannedGame, gen: GeneratedGame) {
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
function batchesOf(games: PlannedGame[]): PlannedGame[][] {
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
function fakeBatch(batch: PlannedGame[]): GeneratedGame[] {
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

async function generateBatch(batch: PlannedGame[], usedNames: string[]) {
  if (FAKE) return { games: fakeBatch(batch), cached: false };
  const key = createHash("sha256").update(JSON.stringify({ PROMPT_VERSION, MODEL, SYSTEM, batch })).digest("hex").slice(0, 16);
  const cachePath = `${CACHE_DIR}/${batch[0]!.id}-${key}.json`;
  if (existsSync(cachePath)) return { games: GeneratedBatch.parse(JSON.parse(readFileSync(cachePath, "utf8"))).games, cached: true };

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await generateStructured({
        schema: GeneratedBatch,
        schemaName: "catalogue_batch",
        model: MODEL,
        maxTokens: 24000,
        system: SYSTEM,
        user: promptFor(batch, usedNames),
      });
      const out = response.data;
      usage.input += response.usage.inputTokens;
      usage.output += response.usage.outputTokens;

      const ids = out.games.map((g) => g.id).sort().join(",");
      const want = batch.map((g) => g.id).sort().join(",");
      if (ids !== want) throw new Error(`returned ids ${ids}, expected ${want}`);
      batch.forEach((p) => checkGame(p, structuredClone(out.games.find((g) => g.id === p.id)!)));

      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(cachePath, JSON.stringify(out, null, 2));
      return { games: out.games, cached: false };
    } catch (err) {
      lastError = err;
      console.warn(`  batch ${batch[0]!.id} attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
      if (err instanceof LlmError && !err.retryable) break;
    }
  }
  throw lastError;
}

async function main() {
  const plan = Plan.parse(JSON.parse(readFileSync(PLAN_PATH, "utf8")));
  const batches = batchesOf(plan.games).slice(0, BATCH_LIMIT);
  console.log(`${plan.games.length} games, running ${batches.length} batches, model ${MODEL}`);

  const generated = new Map<string, GeneratedGame>();
  const usedNames: string[] = [];
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const wave = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(wave.map((b) => generateBatch(b, [...usedNames])));
    results.forEach((r, j) => {
      console.log(`  batch ${i + j + 1}/${batches.length} ${r.cached ? "(cached)" : "done"}: ${r.games.map((g) => g.name).join(" | ")}`);
      for (const g of r.games) {
        generated.set(g.id, g);
        usedNames.push(g.name);
      }
    });
  }

  console.log(`tokens this run: ${usage.input} in / ${usage.output} out`);
  if (Number.isFinite(BATCH_LIMIT)) {
    console.log("partial run: batches cached; ground truth not written. Run without --batches to finish.");
    return;
  }

  const dupes = usedNames.filter((n, i) => usedNames.indexOf(n) !== i);
  if (dupes.length) throw new Error(`duplicate names: ${dupes.join(", ")}. Delete the affected cache files and re-run.`);

  const warnings: string[] = [];
  const games: GroundTruthGame[] = [];
  const documents: GroundTruthDocument[] = [];
  for (const p of plan.games) {
    const gen = structuredClone(generated.get(p.id)!);
    warnings.push(...checkGame(p, gen));
    const a = assemble(p, gen);
    games.push(a.game);
    documents.push(...a.documents);
  }

  const truth: GroundTruth = {
    meta: { model: FAKE ? "fake" : MODEL, promptVersion: PROMPT_VERSION, planSeed: plan.seed, generatedAt: new Date().toISOString() },
    games,
    documents,
    warnings,
  };
  writeFileSync(GROUND_TRUTH_PATH, JSON.stringify(GroundTruth.parse(truth), null, 2));
  console.log(`wrote ${games.length} games and ${documents.length} documents to ${GROUND_TRUTH_PATH} (${warnings.length} warnings)`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
