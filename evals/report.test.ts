import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { corruptEnrichment, idealEnrichment } from "./enrichment/synthetic.ts";
import { loadReference } from "./lib/data.ts";
import { buildReport, loadEnriched, renderGates, run, table } from "./report.ts";

const ref = loadReference();

describe("report", () => {
  it("says when there is no pipeline output and still shows calibration and matching", () => {
    const { markdown } = buildReport({ ref, enriched: null });
    expect(markdown).toContain("No pipeline output yet");
    expect(markdown).toContain("silver oracle");
    expect(markdown).toContain("Design tension");
  });

  it("scores pipeline output when given, with failure cases by game name", () => {
    const { markdown, gates } = buildReport({ ref, enriched: corruptEnrichment(idealEnrichment(ref), ref) });
    expect(markdown).toContain("pipeline output");
    expect(markdown).toMatch(/\*\*Lantern League\*\* \(`BLY-SLT-0001`\): rtp/);
    expect(gates.some((g) => g.level === "block" && !g.pass)).toBe(true);
  });

  it("renders tables and gate verdicts", () => {
    expect(table(["a"], [[1]])).toBe("| a |\n| --- |\n| 1 |");
    expect(renderGates([{ name: "x", level: "block", value: 1, threshold: 0, comparison: "<=", pass: false }])).toContain("Not releasable");
  });

  it("writes the report and exits non-zero under --strict when a blocking gate fails", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "eval-"));
    const enriched = join(dir, "games.json");
    writeFileSync(enriched, JSON.stringify(corruptEnrichment(idealEnrichment(ref), ref)));
    const out = join(dir, "report.md");
    expect(run(["--enriched", enriched, "--out", out])).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("# Evaluation report");
    expect(run(["--enriched", enriched, "--out", out, "--strict"])).toBe(1);
    expect(loadEnriched(join(dir, "missing.json"))).toBeNull();
  });
});
