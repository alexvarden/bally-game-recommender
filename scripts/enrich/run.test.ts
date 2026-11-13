import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EnrichDeps } from "../../src/enrich/enrich.ts";
import { documents, llmResponse, quote, source } from "../../src/enrich/testing.ts";
import { costUsd, depsFrom, EnrichedCatalogue, loadInputs, run, selectGames, type Inputs } from "./run.ts";

vi.spyOn(console, "log").mockImplementation(() => {});

const inputs: Inputs = {
  games: [source(), { ...source({ rtp: 0.95 }), id: "BLY-SLT-0002", name: "Other" }],
  documents: new Map([["BLY-SLT-0001", documents]]),
};

const deps = (): EnrichDeps => ({
  llm: vi.fn().mockResolvedValue({
    data: llmResponse({ regulated: { rtp: { value: 0.9612, evidence: quote("rules", "RTP of this game is 96.12%"), confidence: 1 } } }),
    provider: "openrouter",
    model: "m",
    usage: { inputTokens: 1000, outputTokens: 500 },
  }),
  model: "openai/gpt-6.1-terra",
  cacheDir: mkdtempSync(join(tmpdir(), "enrich-run-")),
  now: () => new Date("2026-11-13T12:00:00Z"),
  log: () => {},
});

describe("run", () => {
  it("writes the enriched catalogue on a full run, with usage, cost and quarantines", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "enriched-")), "enriched.json");
    const catalogue = await run([], deps(), inputs, out);
    const written = EnrichedCatalogue.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(written.games).toHaveLength(2);
    expect(catalogue.meta.usage).toEqual({ input: 2000, output: 1000, usd: 0.007 });
    // The second game has no documents, so its rtp claim can't be verified and it isn't quarantined.
    expect(written.quarantined).toEqual([]);
  });

  it("quarantines a game whose verified document contradicts its feed", async () => {
    const withDocs: Inputs = { ...inputs, documents: new Map([["BLY-SLT-0001", documents], ["BLY-SLT-0002", documents.map((d) => ({ ...d, gameId: "BLY-SLT-0002" }))]]) };
    const catalogue = await run(["--games", "BLY-SLT-0002"], deps(), withDocs, "unused");
    expect(catalogue.quarantined).toEqual([{ gameId: "BLY-SLT-0002", reason: "rtp: feed 0.95 vs rules 0.9612" }]);
  });

  it("writes nothing on a partial run", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "enriched-")), "enriched.json");
    await run(["--limit", "1"], deps(), inputs, out);
    expect(existsSync(out)).toBe(false);
  });
});

describe("helpers", () => {
  it("selects games by id and limit", () => {
    expect(selectGames(inputs.games, ["--games", "BLY-SLT-0002"]).map((g) => g.id)).toEqual(["BLY-SLT-0002"]);
    expect(selectGames(inputs.games, ["--limit", "1"])).toHaveLength(1);
    expect(selectGames(inputs.games, [])).toHaveLength(2);
  });

  it("prices known models and treats unknown ones as free", () => {
    expect(costUsd("openai/gpt-6.1-terra", { input: 1_000_000, output: 1_000_000 })).toBe(6);
    expect(costUsd("mystery", { input: 1, output: 1 })).toBe(0);
  });

  it("loads the committed feed and documents", () => {
    const loaded = loadInputs();
    expect(loaded.games).toHaveLength(102);
    expect(loaded.documents.get("BLY-SLT-0013")!.length).toBeGreaterThan(0);
  });

  it("builds default dependencies from arguments", () => {
    expect(depsFrom(["--model", "x/y"]).model).toBe("x/y");
    expect(depsFrom([]).model).toBe("openai/gpt-6.1-terra");
  });
});
