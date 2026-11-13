import { describe, expect, it } from "vitest";
import { amountsIn, frequenciesIn, isRegulatedField, multipliersIn, percentagesIn, quoteFound, rejectionFor, volatilityIn } from "./evidence.ts";

describe("quoteFound", () => {
  it("matches across case, whitespace, typographic quotes and dashes", () => {
    expect(quoteFound("it's a 5-reel slot", "It’s a\n5–reel  slot.")).toBe(true);
    expect(quoteFound("6-reel", "It's a 5-reel slot")).toBe(false);
    expect(quoteFound("a", "a")).toBe(false);
  });
});

describe("number parsing", () => {
  it("reads percentages in any supplier form", () => {
    expect(percentagesIn("RTP 96.12% (96,5 %)")).toEqual([0.9612, 0.965]);
  });

  it("reads multipliers before or after the x", () => {
    expect(multipliersIn("Max win: 5,000x; up to x2500 or 300 × stake")).toEqual([5000, 300, 2500]);
  });

  it("reads money with symbols, pence and currency codes", () => {
    expect(amountsIn("£0.10 to $1,000, 10p or 5 GBP")).toEqual([0.1, 1000, 0.1, 5]);
  });

  it("reads hit frequency as ratio or percentage", () => {
    expect(frequenciesIn("1 in 4 or 1:2")).toEqual([0.25, 0.5]);
    expect(frequenciesIn("29.4%")).toEqual([0.294]);
  });

  it("reads volatility words and scores, refusing ambiguous ones", () => {
    expect(volatilityIn("Volatility: Very High (5/5)")).toBe("very_high");
    expect(volatilityIn("High (4/5)")).toBe("high");
    expect(volatilityIn("Medium (3/5)")).toBe("medium");
    expect(volatilityIn("a relaxed, low volatility game")).toBe("low");
    expect(volatilityIn("Vol: Med-High")).toBeNull();
    expect(volatilityIn("no level here")).toBeNull();
  });
});

describe("rejectionFor", () => {
  const docs = new Map([["d1", { docId: "d1", text: "Game Information\nVolatility: High (4/5)\nThe theoretical RTP of this game is 96.12%." }]]);
  const none = new Set<string>();

  it("accepts a quote that is in the doc and states the value", () => {
    expect(rejectionFor("rtp", 0.9612, { docId: "d1", quote: "RTP of this game is 96.12%" }, docs, none)).toBeNull();
    expect(rejectionFor("volatility", "high", { docId: "d1", quote: "Volatility: High (4/5)" }, docs, none)).toBeNull();
    expect(rejectionFor("mood", "epic", { docId: "d1", quote: "Game Information" }, docs, none)).toBeNull();
  });

  it("rejects a quote that isn't in the doc, or cites a missing doc", () => {
    expect(rejectionFor("rtp", 0.9612, { docId: "d1", quote: "RTP is 96.12%" }, docs, none)).toBe("quote_not_found");
    expect(rejectionFor("rtp", 0.9612, { docId: "nope", quote: "96.12%" }, docs, none)).toBe("quote_not_found");
  });

  it("rejects a real quote that doesn't state the claimed regulated value", () => {
    expect(rejectionFor("rtp", 0.97, { docId: "d1", quote: "RTP of this game is 96.12%" }, docs, none)).toBe("value_not_in_quote");
    expect(rejectionFor("volatility", "low", { docId: "d1", quote: "Volatility: High (4/5)" }, docs, none)).toBe("value_not_in_quote");
  });

  it("rejects evidence from a doc flagged as describing another game", () => {
    expect(rejectionFor("rtp", 0.9612, { docId: "d1", quote: "96.12%" }, docs, new Set(["d1"]))).toBe("suspect_doc");
  });

  it("knows which fields are regulated", () => {
    expect(isRegulatedField("maxStake")).toBe(true);
    expect(isRegulatedField("mood")).toBe(false);
  });
});
