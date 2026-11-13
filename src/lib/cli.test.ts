import { describe, expect, it } from "vitest";
import { argValue, countBy, hasFlag, isMain } from "./cli.ts";

describe("cli helpers", () => {
  const argv = ["node", "/repo/x.ts", "--seed", "7", "--fake"];

  it("reads flag values with a fallback", () => {
    expect(argValue(argv, "--seed", "1")).toBe("7");
    expect(argValue(argv, "--missing", "1")).toBe("1");
    expect(argValue(["--seed"], "--seed", "1")).toBe("1");
  });

  it("detects flags and the main module", () => {
    expect(hasFlag(argv, "--fake")).toBe(true);
    expect(hasFlag(argv, "--batches")).toBe(false);
    expect(isMain("file:///repo/x.ts", argv)).toBe(true);
    expect(isMain("file:///repo/y.ts", argv)).toBe(false);
  });

  it("counts single and multiple keys per item", () => {
    expect(countBy(["a", "b", "a"], (x) => x)).toEqual({ a: 2, b: 1 });
    expect(countBy([["x", "y"], ["y"]], (x) => x)).toEqual({ x: 1, y: 2 });
  });
});
