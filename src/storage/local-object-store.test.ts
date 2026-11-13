import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeKey, etagOf, LocalObjectStore } from "./local-object-store.ts";

const store = () => new LocalObjectStore(mkdtempSync(join(tmpdir(), "bucket-")));

describe("LocalObjectStore", () => {
  it("puts and gets objects with a content-hash etag", async () => {
    const s = store();
    const put = await s.put("incoming/feeds/a/2026-01-01.json", "[]");
    expect(put).toMatchObject({ key: "incoming/feeds/a/2026-01-01.json", etag: etagOf("[]") });
    expect((await s.get(put.key)).toString()).toBe("[]");
  });

  it("lists by prefix in key order", async () => {
    const s = store();
    await s.put("incoming/documents/G2/d.html", "x");
    await s.put("incoming/documents/G1/d.html", "y");
    await s.put("incoming/feeds/a.json", "z");
    expect((await s.list("incoming/documents/")).map((o) => o.key)).toEqual(["incoming/documents/G1/d.html", "incoming/documents/G2/d.html"]);
  });

  it("changes the etag when content changes", async () => {
    const s = store();
    const a = await s.put("k.json", "1");
    const b = await s.put("k.json", "2");
    expect(a.etag).not.toBe(b.etag);
  });

  it("returns an empty list for a missing root", async () => {
    expect(await new LocalObjectStore(join(tmpdir(), "does-not-exist-xyz")).list("")).toEqual([]);
  });

  it("rejects keys that escape the root", async () => {
    for (const bad of ["", "/abs", "a/../b", "a//b"]) expect(() => assertSafeKey(bad)).toThrow(/invalid object key/);
    await expect(store().get("../x")).rejects.toThrow(/invalid/);
  });
});
