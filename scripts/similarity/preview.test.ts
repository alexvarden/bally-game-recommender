import { describe, expect, it, vi } from "vitest";
import { groundTruthAsEnriched } from "../../src/testing/fixtures.ts";
import { defaultSeeds, describe as describeGame, run } from "./preview.ts";

vi.spyOn(console, "log").mockImplementation(() => {});

describe("preview", () => {
  const games = groundTruthAsEnriched();

  it("picks a varied set of default seeds live on the brand", () => {
    const seeds = defaultSeeds(games, "jackpotjoy");
    expect(seeds.length).toBeGreaterThanOrEqual(4);
    for (const id of seeds) expect(games.find((g) => g.id === id)!.brands).toContain("jackpotjoy");
  });

  it("describes a game by format, theme, mechanic and volatility", () => {
    expect(describeGame(games[0]!)).toMatch(/^.+ \[\w+, \w+, \w+, \w+\]$/);
  });

  it("prints recommendations from the committed embeddings, flagging fallback reasons", () => {
    const lines = run(["--seeds", `${games[0]!.id},NOPE`, "--limit", "3"]);
    expect(lines.filter((l) => /^\s+\d\.\d{3}\s/.test(l))).toHaveLength(3);
    expect(lines.join("\n")).toMatch(/NOPE \(unknown\)\s+→ unknown_game/);
  });

  it("uses default seeds when none are given", () => {
    expect(run([]).filter((l) => l.startsWith("\n")).length).toBeGreaterThanOrEqual(4);
  });
});
