import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EmbeddingRecord } from "../../src/contracts/storage.ts";
import { HashEmbedder, LocalEmbedder } from "../../src/similarity/embedders.ts";
import { groundTruthAsEnriched } from "../../src/testing/fixtures.ts";
import { BaselineRecord, BASELINE_EMBEDDINGS_PATH, EMBEDDINGS_PATH, embedderFor, embedProfiles, planEmbeddings, rawTextByGame, run } from "./embed.ts";

const games = groundTruthAsEnriched().slice(0, 4);
const embedder = new HashEmbedder(16);

vi.spyOn(console, "log").mockImplementation(() => {});

describe("embedProfiles", () => {
  it("embeds three aspects per game, then reuses unchanged profiles", async () => {
    const first = await embedProfiles(games, [], embedder);
    expect(first).toMatchObject({ embedded: 12, reused: 0 });
    expect(first.records.map((r) => r.aspect).slice(0, 3)).toEqual(["content", "experience", "gameplay"]);

    const second = await embedProfiles(games, first.records, embedder);
    expect(second).toMatchObject({ embedded: 0, reused: 12 });
    expect(second.records).toEqual(first.records);
  });

  it("re-embeds only the profiles whose text changed", () => {
    const changed = games.map((g, i) => (i === 0 ? { ...g, fields: { ...g.fields, mood: { ...g.fields.mood, value: "spooky" as const } } } : g));
    const existing = planEmbeddings(games, [], embedder.model).pending.map((p) => ({ ...p, model: embedder.model, vector: [0] }));
    const { pending } = planEmbeddings(changed, existing, embedder.model);
    expect(pending.map((p) => `${p.gameId}/${p.aspect}`)).toEqual([`${games[0]!.id}/experience`]);
  });

  it("ignores stored vectors from a different model", () => {
    const existing = planEmbeddings(games, [], "other").pending.map((p) => ({ ...p, model: "other", vector: [0] }));
    expect(planEmbeddings(games, existing, embedder.model).pending).toHaveLength(12);
  });
});

describe("rawTextByGame", () => {
  it("concatenates a game's documents with tags and entities removed", () => {
    const doc = (gameId: string, text: string) => ({ docId: "d", gameId, kind: "rules_text" as const, format: "cms_html" as const, contentType: "text/html", source: "s", receivedAt: "2025-01-01", text });
    const texts = rawTextByGame([doc("a", "<p>Norse&nbsp;slot</p>"), doc("a", "Vikings"), doc("b", "Bingo")]);
    expect(texts.get("a")).toBe("Norse slot Vikings");
    expect(texts.get("b")).toBe("Bingo");
  });
});

describe("run", () => {
  it("writes aspect and baseline embeddings for the committed catalogue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-"));
    const gamesPath = join(dir, "games.json");
    writeFileSync(gamesPath, JSON.stringify(games));
    const paths = { games: gamesPath, documents: "data/catalogue/documents.json", out: join(dir, "e.json"), baselineOut: join(dir, "b.json") };

    const result = await run([], paths, embedder);
    expect(z.array(EmbeddingRecord).parse(JSON.parse(readFileSync(paths.out, "utf8")))).toHaveLength(12);
    expect(z.array(BaselineRecord).parse(JSON.parse(readFileSync(paths.baselineOut, "utf8"))).length).toBeGreaterThan(90);
    expect((await run([], paths, embedder)).reused).toBe(12);
    expect(result.embedded).toBe(12);
  });

  it("defaults to the ground-truth fixtures when no games file is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-"));
    const result = await run([], { games: null, documents: "data/catalogue/documents.json", out: join(dir, "e.json"), baselineOut: join(dir, "b.json") }, embedder);
    expect(result.records).toHaveLength(300);
  });

  it("chooses embedders by name", () => {
    expect(embedderFor("hash")).toBeInstanceOf(HashEmbedder);
    expect(embedderFor("local")).toBeInstanceOf(LocalEmbedder);
    expect(() => embedderFor("gpt")).toThrow(/unknown embedder/);
  });
});

describe("committed embeddings (golden)", () => {
  it("cover every game and aspect with the local model, and match the current profiles", () => {
    if (!existsSync(EMBEDDINGS_PATH)) return;
    const records = z.array(EmbeddingRecord).parse(JSON.parse(readFileSync(EMBEDDINGS_PATH, "utf8")));
    const all = groundTruthAsEnriched();
    expect(records).toHaveLength(all.length * 3);
    // If profiles.ts changes, the committed vectors are stale: re-run `node scripts/similarity/embed.ts`.
    expect(planEmbeddings(all, records, records[0]!.model).pending).toEqual([]);
    expect(z.array(BaselineRecord).parse(JSON.parse(readFileSync(BASELINE_EMBEDDINGS_PATH, "utf8"))).length).toBeGreaterThan(90);
  });
});
