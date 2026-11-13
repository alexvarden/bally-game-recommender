import { describe, expect, it } from "vitest";
import type { EmbeddingRecord } from "../contracts/storage.ts";
import { groundTruthAsEnriched } from "../testing/fixtures.ts";
import { toRankable } from "./rankable.ts";

describe("toRankable", () => {
  const [a, b] = groundTruthAsEnriched();
  const rec = (gameId: string, aspect: EmbeddingRecord["aspect"], model = "m"): EmbeddingRecord => ({ gameId, aspect, model, profileText: "", inputHash: "h", vector: [1] });

  it("joins games with all three aspect vectors from the model and reports the rest", () => {
    const records = [rec(a!.id, "content"), rec(a!.id, "gameplay"), rec(a!.id, "experience"), rec(b!.id, "content"), rec(b!.id, "gameplay"), rec(b!.id, "experience", "other")];
    const { rankable, missing } = toRankable([a!, b!], records, "m");
    expect(rankable.map((r) => r.game.id)).toEqual([a!.id]);
    expect(rankable[0]!.vectors.experience).toEqual([1]);
    expect(missing).toEqual([b!.id]);
  });
});
