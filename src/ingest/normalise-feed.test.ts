import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRAND_CODES,
  FORMAT_LABELS,
  JACKPOT_LABELS,
  MARKET_CODES,
  MECHANIC_LABELS,
  STATUS_LABELS,
  THEME_LABELS,
  VOL_LABELS,
} from "../../scripts/catalogue/degrade.ts";
import { loadGroundTruth } from "../testing/fixtures.ts";
import {
  cleanName,
  nameKey,
  normaliseFeedRecord,
  parseDate,
  parseFeatures,
  parseGrid,
  parseHitFrequency,
  parseLines,
  parseMultiplier,
  parseRtp,
  parseStakeRange,
} from "./normalise-feed.ts";
import {
  BRAND_VOCAB,
  CORE_MECHANIC_VOCAB,
  FORMAT_VOCAB,
  JACKPOT_VOCAB,
  lookupFor,
  MARKET_VOCAB,
  SECONDARY_FEATURE_VOCAB,
  STATUS_VOCAB,
  THEME_VOCAB,
  VOLATILITY_VOCAB,
} from "./vocabulary.ts";

describe("field parsers", () => {
  it.each([[96.12, 0.9612], ["96.12%", 0.9612], [0.9612, 0.9612], ["96,12", 0.9612], ["96.12 %", 0.9612], ["abc", null], [50, null], [120, null]])(
    "parseRtp(%s) = %s",
    (raw, want) => expect(parseRtp(raw)).toBe(want),
  );

  it.each([["5000x", 5000], [5000, 5000], ["x5,000", 5000], ["5,000 x stake", 5000], ["none", null], [0, null]])("parseMultiplier(%s) = %s", (raw, want) =>
    expect(parseMultiplier(raw)).toBe(want),
  );

  it.each([
    ["£0.10 - £5.00", { minStake: 0.1, maxStake: 5 }],
    ["0.1-5", { minStake: 0.1, maxStake: 5 }],
    ["10p–£5", { minStake: 0.1, maxStake: 5 }],
    ["$0.1 to $100", { minStake: 0.1, maxStake: 100 }],
    ["min 0.25 / max 5 GBP", { minStake: 0.25, maxStake: 5 }],
    ["£5", null],
    ["£5 - £1", null],
  ])("parseStakeRange(%s)", (raw, want) => expect(parseStakeRange(raw)).toEqual(want));

  it.each([["29.4%", 0.294], [0.294, 0.294], ["1:3.4", 0.294], ["often", null], [1.5, null]])("parseHitFrequency(%s) = %s", (raw, want) =>
    expect(parseHitFrequency(raw)).toBe(want),
  );

  it.each([
    ["2024-03-12", "2024-03-12"],
    ["2024-03-12T00:00:00Z", "2024-03-12"],
    ["12 Mar 2024", "2024-03-12"],
    ["25/03/2024", "2024-03-25"],
    ["03/25/2024", "2024-03-25"],
    ["05/05/2024", "2024-05-05"],
    ["12/03/2024", null],
    ["31 Foo 2024", null],
    ["2024-02-30", null],
    ["soon", null],
  ])("parseDate(%s) = %s", (raw, want) => expect(parseDate(raw)).toBe(want));

  it("parses grids and lines", () => {
    expect(parseGrid("5 x 3")).toEqual({ reels: 5, rows: 3 });
    expect(parseGrid("5-4")).toEqual({ reels: 5, rows: 4 });
    expect(parseGrid("big")).toBeNull();
    expect(parseLines(20)).toEqual({ paylines: 20, payStructure: "paylines" });
    expect(parseLines(117649)).toEqual({ paylines: 117649, payStructure: "megaways" });
    expect(parseLines("243 ways")).toEqual({ paylines: 243, payStructure: "ways" });
    expect(parseLines("117,649")).toEqual({ paylines: 117649, payStructure: "megaways" });
    expect(parseLines("1024")).toEqual({ paylines: 1024, payStructure: null });
    expect(parseLines("lots")).toBeNull();
    expect(parseLines(2.5)).toBeNull();
  });

  it("sets the core mechanic only when exactly one defining mechanic is listed", () => {
    expect(parseFeatures("Lock & Respin, free games")).toEqual({ coreMechanic: "hold_and_win", secondaryFeatures: ["free_spins"], unknown: [] });
    expect(parseFeatures("free games | Respins")).toEqual({ coreMechanic: null, secondaryFeatures: ["free_spins", "respins"], unknown: [] });
    expect(parseFeatures("Tumble;MULTIPLIER;laser beams").coreMechanic).toBeNull();
    expect(parseFeatures("Tumble;laser beams").unknown).toEqual(["laser beams"]);
  });

  it("cleans names and builds duplicate keys", () => {
    expect(cleanName("Frostbound Saga™")).toBe("Frostbound Saga");
    expect(cleanName("Frostbound Saga (UKGC)")).toBe("Frostbound Saga");
    expect(cleanName("FROSTBOUND SAGA-MEGAWAYS")).toBe("Frostbound Saga-Megaways");
    expect(cleanName("777")).toBe("777");
    expect(nameKey("THE ANGLERS BRASS WHEEL")).toBe(nameKey("The Angler's Brass Wheel™"));
  });
});

describe("normaliseFeedRecord", () => {
  it("normalises a messy aggregator record and reports what it couldn't parse", () => {
    const { game, unparsed } = normaliseFeedRecord({
      id: "BLY-SLT-0041",
      supplier_code: "BLU9556",
      name: "Wild Canopy™",
      studio: "Bluefin Interactive Ltd",
      channel: "ReelBridge",
      type: "slot",
      features: "Lock & Respin, free games",
      reels: "5-4",
      lines: "1024 ways",
      jackpot: "Mini/Minor/Major/Grand",
      volatility: "Med-High",
      rtp: "95,61",
      stake_range: "min 0.1 / max 5 GBP",
      brands: "Rainbow Riches;MON;BALLY-US;Mystery Casino",
      markets: "GB | US-NJ | PA",
      status: "Disabled",
      release_date: "12/03/2024",
      rg_flags: "high_intensity,loud",
    });
    expect(game).toMatchObject({
      name: "Wild Canopy",
      studio: "Bluefin Interactive",
      supplyChannel: "aggregator",
      brands: ["rainbow_riches_casino", "monopoly_casino", "bally_casino_us"],
      jurisdictions: ["GB", "US-NJ", "US-PA"],
      status: "suspended",
      releaseDate: null,
      rgFlags: ["high_intensity"],
      feedValues: { rtp: 0.9561, minStake: 0.1, maxStake: 5, grid: { reels: 5, rows: 4 }, paylines: 1024, payStructure: "ways", jackpotType: "fixed", coreMechanic: "hold_and_win", secondaryFeatures: ["free_spins"] },
    });
    expect(game.feedValues).not.toHaveProperty("volatility");
    expect(game.feedValues).not.toHaveProperty("format");
    expect(unparsed).toEqual(expect.arrayContaining(["type: slot", "volatility: Med-High", "brands: Mystery Casino", "release_date: 12/03/2024", "rg_flags: loud"]));
  });

  it("handles a thin record with only identity and operator fields", () => {
    const { game, unparsed } = normaliseFeedRecord({ id: "BLY-SLT-0044", name: "Mossglade Neighbours", brands: "RRC", markets: "UK", status: "1" });
    expect(game).toMatchObject({ studio: null, supplyChannel: null, status: "live", brands: ["rainbow_riches_casino"], jurisdictions: ["GB"], feedValues: {} });
    expect(unparsed).toEqual([]);
  });

  it("recognises in-house channels", () => {
    expect(normaliseFeedRecord({ id: "BLY-SLT-0001", name: "X", channel: "INTERNAL" }).game.supplyChannel).toBe("in_house");
  });

  it("rejects a record without the required id and name", () => {
    expect(() => normaliseFeedRecord({ name: "no id" })).toThrow();
  });
});

describe("against the committed catalogue", () => {
  const feed = JSON.parse(readFileSync("data/catalogue/catalogue.raw.json", "utf8")) as Record<string, unknown>[];
  const truth = new Map(loadGroundTruth().games.map((g) => [g.id, g]));
  const results = feed.filter((r) => truth.has(r.id as string)).map((r) => ({ ...normaliseFeedRecord(r), truth: truth.get(r.id as string)! }));

  it("never parses a regulated or operator fact to a wrong value", () => {
    // Abstaining is fine; a wrong value is not.
    for (const { game, truth: t } of results) {
      for (const k of ["rtp", "maxWinMultiplier", "minStake", "maxStake", "volatility"] as const) {
        if (game.feedValues[k] !== undefined) expect(game.feedValues[k], `${t.id}.${k}`).toEqual(t[k]);
      }
      const hit = game.feedValues.hitFrequency;
      if (hit !== undefined && hit !== null) expect(Math.abs(hit - t.hitFrequency!), t.id).toBeLessThan(0.005);
      if (game.status !== null) expect(game.status, t.id).toBe(t.status);
      if (game.releaseDate !== null) expect(game.releaseDate, t.id).toBe(t.releaseDate);
      expect(game.brands, t.id).toEqual(t.brands);
      expect(game.jurisdictions, t.id).toEqual(t.jurisdictions);
    }
  });

  it("never parses a descriptive or structural value wrongly", () => {
    for (const { game, truth: t } of results) {
      for (const k of ["format", "primaryTheme", "coreMechanic", "jackpotType", "paylines", "grid"] as const) {
        if (game.feedValues[k] !== undefined) expect(game.feedValues[k], `${t.id}.${k}`).toEqual(t[k]);
      }
      for (const f of game.feedValues.secondaryFeatures ?? []) expect([t.coreMechanic, ...t.secondaryFeatures], t.id).toContain(f);
    }
  });

  it("parses the large majority of present values", () => {
    const present = feed.reduce((n, r) => n + Object.keys(r).length, 0);
    const unparsed = results.reduce((n, r) => n + r.unparsed.length, 0);
    expect(unparsed / present).toBeLessThan(0.05);
  });
});

describe("vocabulary covers every label the generator emits", () => {
  const cases: [string, Record<string, string[]>, Parameters<typeof lookupFor>[0]][] = [
    ["format", FORMAT_LABELS, FORMAT_VOCAB],
    ["theme", THEME_LABELS, THEME_VOCAB],
    ["jackpot", JACKPOT_LABELS, JACKPOT_VOCAB],
    ["brand", BRAND_CODES, BRAND_VOCAB],
    ["market", MARKET_CODES, MARKET_VOCAB],
    ["status", STATUS_LABELS, STATUS_VOCAB],
    ["volatility", VOL_LABELS, VOLATILITY_VOCAB],
    ["mechanic", MECHANIC_LABELS, { ...CORE_MECHANIC_VOCAB, ...SECONDARY_FEATURE_VOCAB }],
  ];

  it.each(cases)("%s labels map to the right value or are deliberately ambiguous/unknown", (_, emitted, vocab) => {
    const lookup = lookupFor(vocab);
    for (const [value, labels] of Object.entries(emitted)) {
      for (const label of labels) {
        const hit = lookup(label);
        // Deliberate gaps: "slot" is ambiguous between video and classic; "Med-High" is unknown.
        if (hit.value !== null) expect(hit.value, label).toBe(value);
        else expect(["slot", "med-high"]).toContain(label.toLowerCase());
      }
    }
  });
});
