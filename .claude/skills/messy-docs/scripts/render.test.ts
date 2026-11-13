import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../../../src/lib/random.ts";
import { DAMAGES, FORMATS, paginate, parseCliArgs, pickFormat, render, wrapParagraph, type CleanDoc } from "./render.ts";

const doc: CleanDoc = {
  docId: "DOC-1",
  title: "Pharaoh's Vault",
  source: "Sandstone Studios",
  sections: [
    { heading: "Overview", text: "A 5-reel slot with 20 paylines. It's set in a tomb - full of gold.", tags: ["grid", "paylines"] },
    { heading: "Game Information", text: "Volatility: High\nMax bet: £5.00\nMax win: 5,000x", tags: ["volatility", "maxStake", "maxWinMultiplier"] },
    { heading: "Feature", text: "Landing six coins triggers the Hold & Win feature with three respins.", tags: ["coreMechanic"] },
    { heading: "Return to Player", text: "The theoretical RTP of this game is 96.12%.", tags: ["rtp"] },
  ],
};

const allTags = doc.sections.flatMap((s) => s.tags).sort();

describe("render", () => {
  it.each(FORMATS)("renders %s deterministically with every tag surviving", (format) => {
    const a = render(doc, { format, seed: 1 });
    const b = render(doc, { format, seed: 1 });
    expect(a.text).toBe(b.text);
    expect(a.survivingTags).toEqual(allTags);
    expect(a.partialTags).toEqual([]);
    expect(a.text).toContain("96.12%");
  });

  it("varies output across seeds", () => {
    const texts = new Set([1, 2, 3, 4, 5].map((seed) => render(doc, { format: "cms_html", seed }).text));
    expect(texts.size).toBeGreaterThan(1);
  });

  it("produces the format's characteristic structure", () => {
    expect(render(doc, { format: "cms_html", seed: 1 }).text).toMatch(/<div class="game-content"/);
    expect(render(doc, { format: "aggregator_xml", seed: 1 }).text).toMatch(/^<\?xml/);
    expect(render(doc, { format: "email", seed: 1 }).text).toMatch(/^From: .*\nTo: content-ops@/);
    expect(render(doc, { format: "pdf_text", seed: 1 }).text).toMatch(/Page 1 of \d/);
    expect(render(doc, { format: "markdown", seed: 1 }).contentType).toBe("text/markdown");
  });

  it("truncation keeps at least half the sections and reports cut and dropped tags", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const r = render(doc, { format: "markdown", seed, damage: ["truncate"] });
      expect(r.text).not.toContain("96.12%");
      expect(r.partialTags.length).toBeGreaterThan(0);
      expect(r.survivingTags).not.toContain("rtp");
      expect(r.survivingTags.length + r.partialTags.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("applies mojibake, boilerplate and whitespace damage without touching tags", () => {
    const r = render(doc, { format: "markdown", seed: 4, damage: ["mojibake", "boilerplate", "whitespace"] });
    expect(r.text).toMatch(/â€|Â£/);
    expect(r.text).toMatch(/18\+|subject to change|illustrative/);
    expect(r.survivingTags).toEqual(allTags);
    expect(r.appliedDamage).toEqual(["mojibake", "boilerplate", "whitespace"]);
  });

  it("places boilerplate inside HTML and XML documents", () => {
    expect(render(doc, { format: "cms_html", seed: 2, damage: ["boilerplate"] }).text).toMatch(/<p class="legal">[\s\S]*<\/div>$/);
    expect(render(doc, { format: "aggregator_xml", seed: 2, damage: ["boilerplate"] }).text).toMatch(/<!-- .* -->\n\s*<\/\w+:Content>/);
  });

  it("leaves a single-section doc whole when truncating", () => {
    const single = { ...doc, sections: [doc.sections[0]!] };
    expect(render(single, { format: "pdf_text", seed: 1, damage: ["truncate"] }).survivingTags).toEqual(["grid", "paylines"]);
  });
});

describe("helpers", () => {
  it("wrapParagraph never exceeds the width except for hyphen-split words", () => {
    const lines = wrapParagraph("The theoretical return to player of this extraordinarily volatile game is high.", 20, mulberry32(1));
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(24);
    expect(lines.join(" ").replace(/-\s/g, "")).toContain("theoretical");
  });

  it("paginate drops blank pages", () => {
    expect(paginate(["a", "", "b", "", "", ""], 2)).toEqual([["a", ""], ["b", ""]]);
  });

  it("pickFormat is stable per doc id", () => {
    expect(pickFormat(FORMATS, 3, "DOC-1")).toBe(pickFormat(FORMATS, 3, "DOC-1"));
  });
});

describe("parseCliArgs", () => {
  const read = () => doc;

  it("parses format, seed and damage", () => {
    const { options } = parseCliArgs(["--in", "x.json", "--format", "email", "--seed", "9", "--damage", "mojibake,truncate"], read);
    expect(options).toEqual({ format: "email", seed: 9, damage: ["mojibake", "truncate"] });
  });

  it("picks a format when asked for random", () => {
    expect(FORMATS).toContain(parseCliArgs(["--in", "x.json"], read).options.format);
  });

  it("rejects missing input, unknown formats and unknown damage", () => {
    expect(() => parseCliArgs([], read)).toThrow(/usage/);
    expect(() => parseCliArgs(["--in", "x", "--format", "docx"], read)).toThrow(/unknown format/);
    expect(() => parseCliArgs(["--in", "x", "--damage", "fire"], read)).toThrow(/unknown damage/);
    expect(DAMAGES).toContain("truncate");
  });
});
