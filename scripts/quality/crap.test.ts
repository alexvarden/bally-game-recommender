import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { crapReport, crapScore, formatRows, functionComplexities, functionCoverage, main, type FileCoverage } from "./crap.ts";

const byName = (source: string) => Object.fromEntries(functionComplexities(source).map((f) => [f.name, f]));

describe("functionComplexities", () => {
  it("scores a straight-line function as 1", () => {
    expect(byName("function f(a: number) { return a + 1; }").f!.complexity).toBe(1);
  });

  it("adds one per branch, loop, catch, case and short-circuit", () => {
    const src = `
      function f(xs: number[], m?: string) {
        if (xs.length === 0) return 0;          // +1
        for (const x of xs) {                    // +1
          while (x > 0) break;                   // +1
        }
        const y = m ?? "a";                      // +1
        const z = xs[0] && xs[1] || 0;           // +2
        switch (y) { case "a": break; default: } // +1 (default doesn't count)
        try { JSON.parse(y); } catch { }         // +1
        return z > 1 ? 1 : 2;                    // +1
      }`;
    expect(byName(src).f!.complexity).toBe(10);
  });

  it("doesn't count arithmetic or comparison operators", () => {
    expect(byName("const f = (a: number, b: number) => a > b && a + b === 3;").f!.complexity).toBe(2);
  });

  it("names arrows, methods and callbacks, and keeps nested complexity separate", () => {
    const src = `
      const outer = () => [1, 2].map((x) => (x > 1 ? x : 0));
      class C { method(a: boolean) { return a ? 1 : 2; } }
      const obj = { prop: function () { return 1; } };`;
    const fns = byName(src);
    expect(fns.outer!.complexity).toBe(1);
    expect(fns["<callback@2>"]!.complexity).toBe(2);
    expect(fns.method!.complexity).toBe(2);
    expect(fns.prop!.complexity).toBe(1);
    expect(fns.outer!.nested).toHaveLength(1);
  });
});

describe("functionCoverage", () => {
  const fn = { name: "f", start: { line: 1, column: 0 }, end: { line: 10, column: 1 }, complexity: 1, nested: [{ start: { line: 5, column: 0 }, end: { line: 6, column: 0 } }] };
  const stmt = (line: number) => ({ start: { line, column: 2 }, end: { line, column: 10 } });

  it("counts only the function's own statements", () => {
    const file: FileCoverage = { statementMap: { a: stmt(2), b: stmt(3), nested: stmt(5), outside: stmt(12) }, s: { a: 1, b: 0, nested: 0, outside: 0 } };
    expect(functionCoverage(fn, file)).toBe(0.5);
  });

  it("returns null when the function has no statements", () => {
    expect(functionCoverage(fn, { statementMap: {}, s: {} })).toBeNull();
  });
});

describe("crapScore", () => {
  it("equals complexity when fully covered", () => expect(crapScore(7, 1)).toBe(7));
  it("is complexity² + complexity when uncovered", () => expect(crapScore(5, 0)).toBe(30));
});

describe("crapReport and main", () => {
  const source = "export function f(a: boolean) {\n  if (a) return 1;\n  return 2;\n}\n";
  const coverage = (hit: number): Record<string, FileCoverage> => ({
    "/repo/src/f.ts": {
      statementMap: { "0": { start: { line: 2, column: 2 }, end: { line: 2, column: 18 } }, "1": { start: { line: 3, column: 2 }, end: { line: 3, column: 11 } } },
      s: { "0": hit, "1": hit },
    },
  });

  it("reports each function with its file, line and score", () => {
    const [row] = crapReport(coverage(1), () => source, "/repo");
    expect(row).toEqual({ file: "src/f.ts", name: "f", line: 1, complexity: 2, coverage: 1, crap: 2 });
    expect(formatRows([row!])).toContain("src/f.ts:1 f");
  });

  it("exits non-zero only when a function is over the threshold", () => {
    const dir = mkdtempSync(join(tmpdir(), "crap-"));
    const src = join(dir, "f.ts");
    writeFileSync(src, source);
    const write = (hit: number) => {
      const cov = { [src]: coverage(hit)["/repo/src/f.ts"]! };
      writeFileSync(join(dir, "cov.json"), JSON.stringify(cov));
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    write(0);
    expect(main(["--coverage", join(dir, "cov.json"), "--threshold", "5"])).toBe(1);
    write(1);
    expect(main(["--coverage", join(dir, "cov.json"), "--threshold", "5"])).toBe(0);
  });
});
