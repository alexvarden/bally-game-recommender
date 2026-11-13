import { describe, expect, it } from "vitest";
import { EnrichedGame } from "../catalogue/schema.ts";
import { OperatorState } from "../contracts/storage.ts";
import { groundTruthAsEnriched, operatorStateFrom } from "./fixtures.ts";

describe("fixtures", () => {
  const games = groundTruthAsEnriched();

  it("produce a valid EnrichedGame for every ground-truth game", () => {
    expect(games).toHaveLength(100);
    for (const g of games) EnrichedGame.parse(g);
  });

  it("produce valid operator state", () => {
    for (const g of games) OperatorState.parse(operatorStateFrom(g));
  });
});
