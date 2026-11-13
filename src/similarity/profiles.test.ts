import { describe, expect, it } from "vitest";
import type { EnrichedGame } from "../catalogue/schema.ts";
import { groundTruthAsEnriched } from "../testing/fixtures.ts";
import { aspectProfile, isThin, knownCoreFields, phrase, profiles, valueOf, withoutName } from "./profiles.ts";

const games = groundTruthAsEnriched();
const norse = games.find((g) => g.fields.primaryTheme.value === "norse_myth" && g.fields.format.value === "video_slot")!;

/** A copy of a game with the given fields set to unknown. */
function withUnknown(game: EnrichedGame, keys: (keyof EnrichedGame["fields"])[]): EnrichedGame {
  const fields = { ...game.fields };
  for (const k of keys) fields[k] = { value: null, provenance: "unknown", evidence: null, confidence: 0 } as never;
  return { ...game, fields };
}

describe("profiles", () => {
  it("uses readable phrases instead of enum ids", () => {
    const p = profiles(norse);
    expect(p.content).toContain("Norse mythology, Vikings and runes");
    expect(p.gameplay).toContain("Format: video slot.");
    expect(p.content).not.toMatch(/norse_myth/);
  });

  it("leaves out names, numbers and brands", () => {
    for (const g of games.slice(0, 30)) {
      const text = Object.values(profiles(g)).join(" ");
      expect(text).not.toContain(g.name);
      expect(text).not.toMatch(/\d+(\.\d+)?%|£|\$|\d{2,}x/);
      for (const b of g.brands) expect(text).not.toContain(b);
    }
  });

  it("omits unknown fields rather than writing 'null'", () => {
    const p = aspectProfile(withUnknown(norse, ["mood", "pace", "nostalgia"]), "experience");
    expect(p).not.toMatch(/Mood|Pace|Feel|null/);
  });

  it("lets operator overrides win over enrichment", () => {
    expect(aspectProfile(norse, "content", { primaryTheme: "irish_luck" })).toContain("Irish luck");
    expect(valueOf(norse, "mood", { mood: "spooky" })).toBe("spooky");
  });

  it("describes absent jackpots, solo play and modern feel explicitly", () => {
    const g = { ...norse, fields: { ...norse.fields, jackpotType: { ...norse.fields.jackpotType, value: "none" }, socialElement: { ...norse.fields.socialElement, value: "none" }, nostalgia: { ...norse.fields.nostalgia, value: false } } } as EnrichedGame;
    expect(aspectProfile(g, "gameplay")).toContain("Jackpot: no jackpot.");
    expect(aspectProfile(g, "experience")).toMatch(/Social: played alone\..*Feel: modern\./);
  });

  it("falls back to spaced ids for phrases it doesn't know", () => expect(phrase("brand_new_thing")).toBe("brand new thing"));

  it("strips the game's own name from the narrative hook", () => {
    expect(withoutName("Join Frostbound Saga's heroes in FROSTBOUND SAGA", "Frostbound Saga")).toBe("Join the game's heroes in the game");
  });
});

describe("isThin", () => {
  it("is false for a fully known game and true when core fields are unknown", () => {
    expect(isThin(norse)).toBe(false);
    const thin = withUnknown(norse, ["primaryTheme", "coreMechanic", "mood", "pace"]);
    expect(knownCoreFields(thin)).toBe(2);
    expect(isThin(thin)).toBe(true);
    expect(isThin(thin, { primaryTheme: "norse_myth" })).toBe(false);
  });

  it("treats an empty sub-theme list as unknown", () => {
    const g = withUnknown(norse, ["primaryTheme", "coreMechanic", "mood", "pace"]);
    expect(knownCoreFields({ ...g, fields: { ...g.fields, subThemes: { ...g.fields.subThemes, value: [] } } })).toBe(1);
  });
});
