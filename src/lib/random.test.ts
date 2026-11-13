import { describe, expect, it } from "vitest";
import { between, chance, intBetween, mulberry32, pick, sample, shuffle } from "./random.ts";

describe("mulberry32", () => {
  it("is deterministic for a seed and differs across seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    const c = mulberry32(2);
    const seqA = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seqA);
    expect([c(), c(), c()]).not.toEqual(seqA);
  });

  it("stays in [0, 1)", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("helpers", () => {
  const fixed = (x: number) => () => x;

  it("pick indexes by the draw", () => {
    expect(pick(fixed(0), ["a", "b", "c"])).toBe("a");
    expect(pick(fixed(0.99), ["a", "b", "c"])).toBe("c");
  });

  it("chance compares the draw to p", () => {
    expect(chance(fixed(0.2), 0.3)).toBe(true);
    expect(chance(fixed(0.3), 0.3)).toBe(false);
  });

  it("between and intBetween scale into the range, inclusive for ints", () => {
    expect(between(fixed(0.5), 10, 20)).toBe(15);
    expect(intBetween(fixed(0), 2, 4)).toBe(2);
    expect(intBetween(fixed(0.999), 2, 4)).toBe(4);
  });

  it("shuffle permutes without mutating; sample takes distinct items", () => {
    const xs = [1, 2, 3, 4, 5];
    const out = shuffle(mulberry32(3), xs);
    expect(out.sort()).toEqual(xs);
    expect(xs).toEqual([1, 2, 3, 4, 5]);
    const s = sample(mulberry32(3), xs, 3);
    expect(new Set(s).size).toBe(3);
  });
});
