import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LlmError } from "../lib/llm.ts";
import { enrichGame, sourceHash, type EnrichDeps } from "./enrich.ts";
import { PROMPT_VERSION, userPrompt } from "./prompt.ts";
import { documents, llmResponse, quote, source } from "./testing.ts";

const response = (data = llmResponse()) => ({ data, provider: "openrouter" as const, model: "m", usage: { inputTokens: 100, outputTokens: 50 } });

const deps = (llm: EnrichDeps["llm"]): EnrichDeps => ({
  llm,
  model: "test-model",
  cacheDir: mkdtempSync(join(tmpdir(), "enrich-")),
  now: () => new Date("2026-11-13T12:00:00Z"),
  log: () => {},
});

describe("enrichGame", () => {
  it("calls the model once, caches the raw response, and serves repeats from cache", async () => {
    const d = deps(vi.fn().mockResolvedValue(response()));
    const first = await enrichGame(source(), documents, {}, d);
    expect(first).toMatchObject({ cached: false, usage: { input: 100, output: 50 }, quarantine: null });
    expect(first.game.meta).toEqual({ sourceHash: sourceHash("test-model", source(), documents), promptVersion: PROMPT_VERSION, model: "test-model", enrichedAt: "2026-11-13T12:00:00.000Z" });
    const second = await enrichGame(source(), documents, {}, d);
    expect(second).toMatchObject({ cached: true, usage: { input: 0, output: 0 } });
    expect(d.llm).toHaveBeenCalledTimes(1);
    expect(readdirSync(d.cacheDir)).toHaveLength(1);
  });

  it("re-calls the model when the game's inputs change", async () => {
    const d = deps(vi.fn().mockResolvedValue(response()));
    await enrichGame(source(), documents, {}, d);
    await enrichGame(source({ rtp: 0.95 }), documents, {}, d);
    expect(d.llm).toHaveBeenCalledTimes(2);
  });

  it("retries retryable failures and fails fast on non-retryable ones", async () => {
    const flaky = deps(vi.fn().mockRejectedValueOnce(new LlmError("timeout", true)).mockResolvedValueOnce(response()));
    await expect(enrichGame(source(), documents, {}, flaky)).resolves.toMatchObject({ cached: false });
    expect(flaky.llm).toHaveBeenCalledTimes(2);

    const broke = deps(vi.fn().mockRejectedValue(new LlmError("402 no credit", false)));
    await expect(enrichGame(source(), documents, {}, broke)).rejects.toThrow(/no credit/);
    expect(broke.llm).toHaveBeenCalledTimes(1);

    const down = deps(vi.fn().mockRejectedValue(new Error("network")));
    await expect(enrichGame(source(), documents, {}, down)).rejects.toThrow(/network/);
    expect(down.llm).toHaveBeenCalledTimes(3);
  });

  it("verifies the model's evidence and signals quarantine on a regulated conflict", async () => {
    const llm = llmResponse({ regulated: { rtp: { value: 0.9612, evidence: quote("rules", "RTP of this game is 96.12%"), confidence: 1 } } });
    const outcome = await enrichGame(source({ rtp: 0.95 }), documents, {}, deps(vi.fn().mockResolvedValue(response(llm))));
    expect(outcome.quarantine).toMatch(/^rtp: feed 0.95/);
  });
});

describe("sourceHash and prompt", () => {
  it("is stable regardless of document order and changes with the model", () => {
    expect(sourceHash("m", source(), documents)).toBe(sourceHash("m", source(), [...documents].reverse()));
    expect(sourceHash("m", source(), documents)).not.toBe(sourceHash("other", source(), documents));
  });

  it("gives the model the feed facts and every document, but not operator-owned fields", () => {
    const prompt = userPrompt(source({ rtp: 0.95 }), documents);
    expect(prompt).toContain('docId="rules"');
    expect(prompt).toContain("Max win: 5,000x");
    expect(prompt).toContain('"rtp": 0.95');
    expect(prompt).not.toContain("jackpotjoy");
    expect(userPrompt(source(), [])).toContain("(no documents)");
  });
});
