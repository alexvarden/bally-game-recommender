import { describe, expect, it, vi } from "vitest";
import { cosine, HashEmbedder, LocalEmbedder, normalise, tokenise, type ExtractorLoader } from "./embedders.ts";

describe("vector helpers", () => {
  it("normalise gives unit length and leaves zero vectors alone", () => {
    const [x, y] = normalise([3, 4]);
    expect(x).toBeCloseTo(0.6);
    expect(y).toBeCloseTo(0.8);
    expect(normalise([0, 0])).toEqual([0, 0]);
  });

  it("cosine is 1 for parallel, 0 for orthogonal or zero vectors", () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it("tokenise lowercases words and numbers", () => expect(tokenise("Hold & Win, 243 Ways!")).toEqual(["hold", "win", "243", "ways"]));
});

describe("HashEmbedder", () => {
  it("is deterministic, unit length, and closer for shared words", async () => {
    const e = new HashEmbedder(32);
    const [a, b, c] = await e.embed(["norse vikings runes", "norse vikings fjord", "candy sweets bakery"]);
    expect(await e.embed(["norse vikings runes"])).toEqual([a]);
    expect(Math.hypot(...a!)).toBeCloseTo(1);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
    expect(e.model).toBe("hash-bow-32");
    expect(e.dimensions).toBe(32);
  });
});

describe("LocalEmbedder", () => {
  it("loads the model once, lazily, and mean-pools with normalisation", async () => {
    const extractor = vi.fn(async (texts: string[]) => ({ tolist: () => texts.map(() => [1, 0]) }));
    const load = vi.fn<ExtractorLoader>(async () => extractor);
    const e = new LocalEmbedder("some/model", load, "/tmp/cache");

    expect(await e.embed([])).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    expect(await e.embed(["a", "b"])).toEqual([[1, 0], [1, 0]]);
    await e.embed(["c"]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("some/model", "/tmp/cache");
    expect(extractor).toHaveBeenCalledWith(["a", "b"], { pooling: "mean", normalize: true });
    expect(e.model).toBe("some/model");
  });
});
