import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LlmError } from "../../src/lib/llm.ts";
import {
  batchesOf,
  buildGroundTruth,
  cachePathFor,
  checkGame,
  displayFacts,
  fakeBatch,
  generateBatch,
  GroundTruth,
  GROUND_TRUTH_PATH,
  optionsFrom,
  promptFor,
  run,
  verifyNumericTags,
  type GenerateDeps,
} from "./generate.ts";
import { Plan, PLAN_PATH, type PlannedGame } from "./plan.ts";

const plan = Plan.parse(JSON.parse(readFileSync(PLAN_PATH, "utf8")));
const game = (id: string) => plan.games.find((g) => g.id === id)!;
const slot = plan.games.find((g) => g.format === "video_slot" && g.hitFrequency !== null && g.documents.includes("rules_text"))!;
const meta = { model: "fake", promptVersion: "test", planSeed: plan.seed, generatedAt: "2026-11-13T00:00:00.000Z" };

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const deps = (over: Partial<GenerateDeps> = {}): GenerateDeps => ({
  llm: vi.fn(),
  model: "test-model",
  cacheDir: mkdtempSync(join(tmpdir(), "gen-cache-")),
  fake: false,
  ...over,
});

const llmReturning = (games: ReturnType<typeof fakeBatch>) =>
  vi.fn().mockResolvedValue({ data: { games }, provider: "openrouter", model: "m", usage: { inputTokens: 10, outputTokens: 20 } });

describe("displayFacts", () => {
  it("formats regulated numbers the way documents must state them", () => {
    const d = displayFacts({ ...slot, rtp: 0.9612, maxWinMultiplier: 5000, minStake: 0.1, maxStake: 5, hitFrequency: 0.294, paylines: 243, currency: "GBP", volatility: "high" });
    expect(d).toEqual({ rtp: "96.12%", maxWinMultiplier: "5,000x", minStake: "£0.10", maxStake: "£5.00", hitFrequency: "1 in 3.4", paylines: "243", volatility: "High (4/5)" });
    expect(displayFacts({ ...slot, currency: "USD", hitFrequency: null, paylines: null })).toMatchObject({ minStake: expect.stringMatching(/^\$/), hitFrequency: null, paylines: null });
  });
});

describe("promptFor", () => {
  it("includes the display facts, used names, and only the content-shaping defects", () => {
    const thin = plan.games.find((g) => g.defects.includes("thin_record"))!;
    const prompt = promptFor([slot, thin], ["Used Name"]);
    expect(prompt).toContain(displayFacts(slot).rtp);
    expect(prompt).toContain("Used Name");
    expect(prompt).toContain('"thin_record"');
    expect(prompt).not.toContain("truncated_rules");
  });
});

describe("batchesOf", () => {
  it("covers every game once and never splits a family", () => {
    const batches = batchesOf(plan.games);
    expect(batches.flat().map((g) => g.id)).toEqual(plan.games.map((g) => g.id));
    for (const b of batches) {
      for (const g of b.filter((x) => x.familyRole === "variant")) expect(b.some((x) => x.familyId === g.familyId && x.familyRole === "base")).toBe(true);
    }
  });
});

describe("verifyNumericTags", () => {
  const display = displayFacts(slot);

  it("drops numeric tags whose value isn't in the section and keeps the rest", () => {
    const section = { heading: null, text: "Choose a stake within the limits.", tags: ["minStake", "mood"] as never[] };
    expect(verifyNumericTags(section, display, "here")).toEqual([expect.stringContaining("dropped tag minStake")]);
    expect(section.tags).toEqual(["mood"]);
  });

  it("adds numeric tags the model forgot when the value is present", () => {
    const section = { heading: null, text: `The theoretical RTP of this game is ${display.rtp}.`, tags: [] as never[] };
    verifyNumericTags(section, display, "here");
    expect(section.tags).toEqual(["rtp"]);
  });

  it("never adds short paylines, which match by accident", () => {
    const section = { heading: null, text: "Pays on 5 lines.", tags: [] as never[] };
    verifyNumericTags(section, { ...display, paylines: "5" }, "here");
    expect(section.tags).toEqual([]);
  });
});

describe("checkGame", () => {
  const generated = () => fakeBatch([slot])[0]!;

  it("accepts consistent output", () => expect(checkGame(slot, generated())).toEqual([]));

  it("rejects missing or extra documents", () => {
    const gen = { ...generated(), documents: [] };
    expect(() => checkGame(slot, gen)).toThrow(/documents/);
  });

  it("rejects any document stating a different RTP", () => {
    const gen = generated();
    gen.documents[0]!.sections[0]!.text += " RTP 91.00%.";
    expect(() => checkGame(slot, gen)).toThrow(/91.00%/);
  });

  it("removes bonus buy from games available in GB", () => {
    const gen = { ...generated(), secondaryFeatures: ["bonus_buy", "free_spins"] as never[] };
    expect(checkGame({ ...slot, bonusBuyAllowed: false }, gen)).toEqual([expect.stringContaining("bonus_buy")]);
    expect(gen.secondaryFeatures).toEqual(["free_spins"]);
  });
});

describe("generateBatch", () => {
  const batch = [slot];

  it("returns fake content without calling the model", async () => {
    const d = deps({ fake: true });
    const r = await generateBatch(batch, [], d);
    expect(r.games[0]!.id).toBe(slot.id);
    expect(d.llm).not.toHaveBeenCalled();
  });

  it("calls the model once, caches the result, then serves from cache", async () => {
    const d = deps({ llm: llmReturning(fakeBatch(batch)) });
    const first = await generateBatch(batch, [], d);
    expect(first).toMatchObject({ cached: false, usage: { input: 10, output: 20 } });
    expect(existsSync(cachePathFor(batch, d))).toBe(true);
    const second = await generateBatch(batch, [], d);
    expect(second.cached).toBe(true);
    expect(d.llm).toHaveBeenCalledTimes(1);
  });

  it("retries retryable failures, including bad ids, and gives up on non-retryable ones", async () => {
    const good = { data: { games: fakeBatch(batch) }, provider: "openrouter", model: "m", usage: { inputTokens: 1, outputTokens: 1 } };
    const wrongIds = { ...good, data: { games: fakeBatch([game("BLY-SLT-0001")]) } };
    const flaky = deps({ llm: vi.fn().mockRejectedValueOnce(new LlmError("timeout", true)).mockResolvedValueOnce(wrongIds).mockResolvedValueOnce(good) });
    await expect(generateBatch(batch, [], flaky)).resolves.toMatchObject({ cached: false });
    expect(flaky.llm).toHaveBeenCalledTimes(3);

    const broke = deps({ llm: vi.fn().mockRejectedValue(new LlmError("402 no credit", false)) });
    await expect(generateBatch(batch, [], broke)).rejects.toThrow(/no credit/);
    expect(broke.llm).toHaveBeenCalledTimes(1);
  });
});

describe("buildGroundTruth", () => {
  const small: Plan = { ...plan, games: plan.games.slice(0, 3) as PlannedGame[] };

  it("assembles a valid ground truth from generated games, keeping regulated facts from the plan", () => {
    const generated = new Map(fakeBatch(small.games).map((g) => [g.id, g]));
    const truth = buildGroundTruth(small, generated, meta);
    expect(truth.games.map((g) => g.rtp)).toEqual(small.games.map((g) => g.rtp));
    expect(truth.documents.length).toBeGreaterThan(0);
  });

  it("rejects duplicate names", () => {
    const generated = new Map(fakeBatch(small.games).map((g) => [g.id, { ...g, name: "Same" }]));
    expect(() => buildGroundTruth(small, generated, meta)).toThrow(/duplicate names/);
  });
});

describe("run", () => {
  const options = (over: object) => ({ ...optionsFrom(["--fake"], {}), outPath: join(mkdtempSync(join(tmpdir(), "gen-")), "gt.json"), ...over });

  it("writes a ground truth in fake mode", async () => {
    const opts = options({});
    const truth = await run(opts);
    expect(GroundTruth.parse(JSON.parse(readFileSync(opts.outPath, "utf8"))).games).toHaveLength(100);
    expect(truth!.meta.model).toBe("fake");
  });

  it("stops after N batches without writing when asked", async () => {
    const opts = options({ batchLimit: 1 });
    expect(await run(opts)).toBeNull();
    expect(existsSync(opts.outPath)).toBe(false);
  });

  it("reads batch limit and model from arguments and environment", () => {
    const o = optionsFrom(["--batches", "2"], { CATALOGUE_MODEL: "x/y" });
    expect(o.batchLimit).toBe(2);
    expect(o.deps.model).toBe("x/y");
    expect(o.deps.fake).toBe(false);
  });
});

describe("committed ground truth (golden)", () => {
  const truth = GroundTruth.parse(JSON.parse(readFileSync(GROUND_TRUTH_PATH, "utf8")));
  const plans = new Map(plan.games.map((p) => [p.id, p]));

  it("keeps every regulated and operator fact exactly as planned", () => {
    for (const g of truth.games) {
      const p = plans.get(g.id)!;
      for (const k of ["rtp", "maxWinMultiplier", "minStake", "maxStake", "hitFrequency", "volatility", "brands", "jurisdictions", "status"] as const) {
        expect(g[k], `${g.id}.${k}`).toEqual(p[k]);
      }
    }
  });

  it("only tags a numeric fact on a section that states it verbatim", () => {
    for (const doc of truth.documents) {
      const display = displayFacts(plans.get(doc.gameId)!);
      for (const s of doc.sections) {
        for (const tag of s.facts.filter((f) => f in display && f !== "volatility")) {
          expect(s.text, `${doc.docId} ${tag}`).toContain(display[tag as keyof typeof display]!);
        }
      }
    }
  });
});
