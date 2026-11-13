import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalisedDocumentFrom, parseDate, parseHitFrequency, parseMaxWin, parseRtp, parseStakes, parseVolatility, sourceGameFrom } from "./adapter.ts";

describe("feed parsers", () => {
  it("reads RTP in every supplier form", () => {
    for (const raw of [96.12, "96.12%", 0.9612, "96,12", "96.12 %"]) expect(parseRtp(raw)).toBe(0.9612);
    expect(parseRtp(undefined)).toBeUndefined();
    expect(parseRtp("n/a")).toBeUndefined();
  });

  it("reads volatility labels and refuses ambiguous ones", () => {
    expect(parseVolatility("M")).toBe("medium");
    expect(parseVolatility("4/5")).toBe("high");
    expect(parseVolatility("V.High")).toBe("very_high");
    expect(parseVolatility("Med-High")).toBeUndefined();
    expect(parseVolatility(undefined)).toBeUndefined();
  });

  it("reads max win, stakes and hit frequency", () => {
    expect(parseMaxWin("x5,000")).toBe(5000);
    expect(parseMaxWin(1200)).toBe(1200);
    expect(parseMaxWin(undefined)).toBeUndefined();
    expect(parseStakes("10p–£5")).toEqual({ minStake: 0.1, maxStake: 5 });
    expect(parseStakes("min 0.1 / max 5 GBP")).toEqual({ minStake: 0.1, maxStake: 5 });
    expect(parseStakes("£0.10 - £5.00")).toEqual({ minStake: 0.1, maxStake: 5 });
    expect(parseStakes("varies")).toEqual({});
    expect(parseStakes(undefined)).toEqual({});
    expect(parseHitFrequency("1:4")).toBe(0.25);
    expect(parseHitFrequency(0.3)).toBe(0.3);
    expect(parseHitFrequency(undefined)).toBeUndefined();
  });

  it("reads dates in UK, US and written forms", () => {
    expect(parseDate("2024-03-12T00:00:00Z")).toBe("2024-03-12");
    expect(parseDate("12/03/2024")).toBe("2024-03-12");
    expect(parseDate("03/25/2024")).toBe("2024-03-25");
    expect(parseDate("16 Sept 2026")).toBe("2026-09-16");
    expect(parseDate("someday")).toBeNull();
    expect(parseDate(undefined)).toBeNull();
  });
});

describe("sourceGameFrom on the committed feed", () => {
  const feed = JSON.parse(readFileSync("data/catalogue/catalogue.raw.json", "utf8"));
  const truth = new Map((JSON.parse(readFileSync("data/catalogue/ground-truth.json", "utf8")).games as { id: string; brands: string[]; jurisdictions: string[]; status: string; name: string }[]).map((g) => [g.id, g]));

  it("recovers operator-owned fields exactly for every game", () => {
    for (const r of feed) {
      const t = truth.get(r.id);
      if (!t) continue;
      const s = sourceGameFrom(r);
      expect({ brands: s.brands, jurisdictions: s.jurisdictions, status: s.status }, r.id).toEqual({ brands: t.brands, jurisdictions: t.jurisdictions, status: t.status });
    }
  });

  it("cleans names and maps the supply channel", () => {
    const s = sourceGameFrom({ id: "BLY-SLT-0001", name: "Frost Saga™", channel: "INTERNAL", studio: "Fjord Games Ltd" });
    expect(s).toMatchObject({ name: "Frost Saga", supplyChannel: "in_house", studio: "Fjord Games", status: null, brands: [], feedValues: {} });
  });

  it("normalises documents and records where they came from", () => {
    const d = normalisedDocumentFrom({ docId: "d", gameId: "g", kind: "rules_text", format: "cms_html", contentType: "text/html", source: "s", receivedAt: "2025-01-01", text: "<p>RTP &pound;</p>" });
    expect(d).toMatchObject({ text: "RTP £", rawKey: "documents.json#d" });
  });
});
