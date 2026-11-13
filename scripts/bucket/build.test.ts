import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bucketObjects, chooseHoldback, feedSourceFor, Holdback, HOLDBACK_PATH, loadInputs, run, withChangedRtp } from "./build.ts";

const { feed, docs, plan } = loadInputs();
const holdback = Holdback.parse(JSON.parse(readFileSync(HOLDBACK_PATH, "utf8")));
const keys = (stage: "initial" | "update" | "all") => bucketObjects(feed, docs, plan, holdback, stage).map((o) => o.key);

describe("holdback", () => {
  it("reproduces the committed holdback (golden)", () => {
    expect(chooseHoldback(plan, docs)).toEqual(holdback);
  });

  it("holds back ten live new titles including a wrong-rules and a volatility-conflict game", () => {
    expect(holdback.newTitles).toHaveLength(10);
    const defects = holdback.newTitles.flatMap((id) => plan.games.find((p) => p.id === id)!.defects);
    expect(defects).toEqual(expect.arrayContaining(["wrong_game_rules", "volatility_conflict"]));
  });

  it("changes the RTP of an existing game, not a new one", () => {
    expect(holdback.newTitles).not.toContain(holdback.rtpChange.gameId);
    expect(holdback.rtpChange.toRtp).not.toBe(holdback.rtpChange.fromRtp);
  });
});

describe("bucketObjects", () => {
  it("splits the catalogue into two drops that together cover everything", () => {
    const initial = keys("initial");
    const update = keys("update");
    expect(initial.filter((k) => update.includes(k))).toEqual([]);
    expect(keys("all")).toEqual([...initial, ...update]);
    const docKeys = (ks: string[]) => ks.filter((k) => k.includes("/documents/") && !k.endsWith(".meta.json"));
    expect(docKeys(initial).length + docKeys(update).length).toBe(docs.length);
  });

  it("puts held-back titles and the late document only in the update drop", () => {
    const initial = keys("initial").join("\n");
    for (const id of holdback.newTitles) expect(initial).not.toContain(`/documents/${id}/`);
    expect(initial).not.toContain(holdback.lateDocument.docId);
    expect(keys("update").join("\n")).toContain(holdback.lateDocument.docId);
  });

  it("writes one feed file per supplier per drop, named by date", () => {
    expect(keys("initial").filter((k) => k.startsWith("incoming/feeds/"))).toEqual([
      "incoming/feeds/in-house/2026-11-10.json",
      "incoming/feeds/reelbridge/2026-11-10.json",
      "incoming/feeds/spinlane-hub/2026-11-10.json",
    ]);
  });

  it("re-states a changed RTP in the supplier's own format", () => {
    expect(withChangedRtp({ id: "a", name: "n", rtp: "96.12%" }, 0.9412).rtp).toBe("94.12%");
    expect(withChangedRtp({ id: "a", name: "n", rtp: 96.12 }, 0.9412).rtp).toBe(94.12);
  });

  it("routes duplicate listings by their own channel", () => {
    expect(feedSourceFor({ id: "BLY-SLT-9001", name: "x", channel: "ReelBridge" }, new Map())).toBe("reelbridge");
    expect(feedSourceFor({ id: "BLY-SLT-9001", name: "x" }, new Map())).toBe("unknown");
  });
});

describe("run", () => {
  it("writes the requested stage and rejects unknown stages", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const bucket = mkdtempSync(join(tmpdir(), "bucket-run-"));
    expect((await run(["--stage", "update", "--bucket", bucket])).length).toBeGreaterThan(0);
    await expect(run(["--stage", "later"])).rejects.toThrow(/unknown stage/);
  });
});
