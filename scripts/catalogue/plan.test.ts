import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mulberry32 } from "../../src/lib/random.ts";
import { brandsFor, buildPlan, cycler, documentsFor, gameId, jurisdictionsFor, Plan, PLAN_PATH, planVariant, run, summarise } from "./plan.ts";

const committed = Plan.parse(JSON.parse(readFileSync(PLAN_PATH, "utf8")));
const plan = buildPlan(committed.seed);
const slots = plan.games.filter((g) => ["video_slot", "classic_slot", "slingo"].includes(g.format));

describe("buildPlan", () => {
  it("reproduces the committed plan exactly (golden)", () => {
    // If this fails, the order of random draws changed and the committed catalogue no longer matches its plan.
    expect(plan.games).toEqual(committed.games);
  });

  it("plans 100 games with unique ids", () => {
    expect(plan.games).toHaveLength(100);
    expect(new Set(plan.games.map((g) => g.id)).size).toBe(100);
  });

  it("respects the UK £5 slot stake limit and keeps bonus buy out of GB", () => {
    for (const g of slots.filter((s) => s.jurisdictions.includes("GB"))) expect(g.maxStake).toBeLessThanOrEqual(5);
    for (const g of plan.games.filter((x) => x.bonusBuyAllowed)) expect(g.jurisdictions).not.toContain("GB");
  });

  it("only lists US-only games on the US brand", () => {
    for (const g of plan.games.filter((x) => !x.jurisdictions.includes("GB"))) expect(g.brands).toEqual(["bally_casino_us"]);
  });

  it("keeps family members contiguous, with the base first", () => {
    const families = Map.groupBy(plan.games.filter((g) => g.familyId), (g) => g.familyId!);
    for (const members of families.values()) {
      expect(members[0]!.familyRole).toBe("base");
      const idx = members.map((m) => plan.games.indexOf(m));
      expect(idx).toEqual(idx.map((_, i) => idx[0]! + i));
    }
  });

  it("plants each defect on at most one per game, and wrong-game rules point at another game", () => {
    for (const g of plan.games) expect(g.defects.length).toBeLessThanOrEqual(1);
    for (const g of plan.games.filter((x) => x.defects.includes("wrong_game_rules"))) {
      expect(g.relatedGameId).not.toBe(g.id);
      expect(g.relatedGameId).toBeTruthy();
    }
  });
});

describe("building blocks", () => {
  it("gameId uses a format prefix and 1-based index", () => {
    expect(gameId("video_slot", 0)).toBe("BLY-SLT-0001");
    expect(gameId("live_dealer", 41)).toBe("BLY-LIV-0042");
  });

  it("cycler spreads values evenly before repeating", () => {
    const next = cycler(mulberry32(1), ["a", "b", "c"]);
    expect([next(), next(), next()].sort()).toEqual(["a", "b", "c"]);
  });

  it("brands and jurisdictions follow the market", () => {
    expect(brandsFor("video_slot", "us", mulberry32(1))).toEqual(["bally_casino_us"]);
    expect(brandsFor("bingo", "gb", mulberry32(1))[0]).toBe("double_bubble_bingo");
    expect(brandsFor("slingo", "both", mulberry32(1))).toContain("bally_casino_us");
    expect(jurisdictionsFor("us", mulberry32(1))).toEqual(["US-NJ", "US-PA"]);
    expect(jurisdictionsFor("gb", mulberry32(1))).toContain("GB");
  });

  it("in-house games always have rules text and every game has a document", () => {
    for (let seed = 0; seed < 20; seed++) {
      expect(documentsFor("in_house", mulberry32(seed))).toContain("rules_text");
      expect(documentsFor("aggregator", mulberry32(seed)).length).toBeGreaterThan(0);
    }
    expect(documentsFor("aggregator", () => 0.99)).toEqual(["marketing_blurb"]);
  });

  it("variants change one dimension of the base", () => {
    const base = plan.games.find((g) => g.familyRole === "base")!;
    const rng = mulberry32(1);
    expect(planVariant(base, "megaways", "X", rng)).toMatchObject({ payStructure: "megaways", volatility: "very_high", familyRole: "variant", defects: [] });
    expect(planVariant(base, "jackpot", "X", rng).jackpotType).toBe("network_progressive");
    expect(planVariant({ ...base, volatility: "low" }, "deluxe", "X", rng).volatility).toBe("medium");
  });
});

describe("run", () => {
  it("writes a valid plan and summarises it", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const out = join(mkdtempSync(join(tmpdir(), "plan-")), "plan.json");
    const written = run(["--seed", String(committed.seed)], out);
    expect(Plan.parse(JSON.parse(readFileSync(out, "utf8"))).games).toEqual(written.games);
    expect(summarise(written).formats.video_slot).toBe(58);
  });
});
