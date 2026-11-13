import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FORMATS, render, type CleanDoc, type Damage } from "../../.claude/skills/messy-docs/scripts/render.ts";
import {
  decodeEntities,
  expandLigatures,
  fixMojibake,
  matchKey,
  normaliseDocument,
  normaliseEmail,
  normaliseMarkdown,
  normalisePdfText,
  normaliseXml,
  stripTags,
  tidyWhitespace,
} from "./normalise.ts";

const doc: CleanDoc = {
  docId: "DOC-1",
  title: "Pharaoh's Vault",
  source: "Sandstone Studios",
  sections: [
    { heading: "Overview", text: "Pharaoh's Vault is a 5-reel, 3-row video slot with 20 paylines. It's set in a tomb - full of gold.", tags: [] },
    { heading: "Game Information", text: "Volatility: High (4/5)\nMin bet: £0.20\nMax bet: £5.00\nMax win: 5,000x\nHit frequency: 1 in 3.4", tags: [] },
    { heading: "Hold & Win Feature", text: "Landing six Scarab coins triggers the Hold & Win feature with three respins. Extraordinarily rewarding multipliers follow.", tags: [] },
    { heading: "Return to Player", text: "The theoretical RTP of this game is 96.12%.", tags: [] },
  ],
};

const factLines = doc.sections.flatMap((s) => s.text.split("\n"));
const DAMAGE_SETS: Damage[][] = [[], ["mojibake"], ["boilerplate"], ["whitespace"], ["mojibake", "boilerplate", "whitespace"]];

describe("normaliseDocument: the property evidence verification relies on", () => {
  for (const format of FORMATS) {
    it(`keeps every fact line findable in ${format} across seeds and damage`, () => {
      for (let seed = 1; seed <= 15; seed++) {
        for (const damage of DAMAGE_SETS) {
          const raw = render(doc, { format, seed, damage }).text;
          const text = matchKey(normaliseDocument(raw, format));
          for (const line of factLines) expect(text, `${format} seed ${seed} ${damage.join("+")}`).toContain(matchKey(line));
        }
      }
    });
  }

  it("holds for every committed document that wasn't truncated or swapped", () => {
    const docs = JSON.parse(readFileSync("data/catalogue/documents.json", "utf8")) as { docId: string; format: never; text: string }[];
    const truth = JSON.parse(readFileSync("data/catalogue/documents.truth.json", "utf8")) as { docId: string; damage: string[]; describesGameId: string | null }[];
    const sources = JSON.parse(readFileSync("data/catalogue/ground-truth.json", "utf8")).documents as { docId: string; sections: { text: string }[] }[];
    let checked = 0;
    for (const d of docs) {
      const t = truth.find((x) => x.docId === d.docId)!;
      const src = sources.find((x) => x.docId === d.docId);
      if (!src || t.damage.includes("truncate") || t.describesGameId) continue;
      const text = matchKey(normaliseDocument(d.text, d.format));
      for (const line of src.sections.flatMap((s) => s.text.split(/\n+/)).filter((l) => l.trim())) {
        expect(text, d.docId).toContain(matchKey(line));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(700);
  });

  it("removes markup and noise", () => {
    const html = render(doc, { format: "cms_html", seed: 3, damage: ["boilerplate"] }).text;
    const text = normaliseDocument(html, "cms_html");
    expect(text).not.toMatch(/<|dataLayer|MsoNormal|&[a-z]+;/);
    const pdf = normaliseDocument(render(doc, { format: "pdf_text", seed: 2 }).text, "pdf_text");
    expect(pdf).not.toMatch(/CONFIDENTIAL|Page \d+ of|\f|ﬁ/);
    const email = normaliseDocument(render(doc, { format: "email", seed: 2 }).text, "email");
    expect(email).not.toMatch(/^From:|^> |confidential and intended/m);
  });
});

describe("building blocks", () => {
  it("decodes named and numeric entities and leaves unknown ones", () => {
    expect(decodeEntities("&pound;5 &#163;5 &#xA3;5 &rsquo; &amp; &bogus;")).toBe("£5 £5 £5 ’ & &bogus;");
  });

  it("repairs mojibake and ligatures", () => {
    expect(fixMojibake("Itâ€™s Â£5")).toBe("It’s £5");
    expect(expandLigatures("ﬁxed ﬂoor")).toBe("fixed floor");
  });

  it("turns table cells into label: value and drops scripts", () => {
    expect(tidyWhitespace(stripTags('<script>x()</script><table><tr><td class="lbl">RTP</td><td>96%</td></tr></table>'))).toBe("RTP: 96%");
  });

  it("reads XML attributes, leaf elements, CDATA and escaped HTML", () => {
    const xml = `<?xml version="1.0"?><a:GameAsset><a:Section name="Info"><a:Attr key="min_bet" value="£0.20"/><a:max_win>5,000x</a:max_win></a:Section><a:Section><![CDATA[<p>Hello</p>]]></a:Section><a:Section>&lt;p&gt;Escaped &amp; ok&lt;/p&gt;</a:Section></a:GameAsset>`;
    expect(tidyWhitespace(normaliseXml(xml))).toBe("Info\n\nmin bet: £0.20\n\nmax win: 5,000x\n\nHello\n\nEscaped & ok");
  });

  it("turns markdown tables and bullets into label: value", () => {
    const md = "# T\n| Item | Value |\n|---|---|\n| RTP |96% \n- **Max win:** 5,000x\n• Volatility - High\n[a](http://x) **bold**<br>\n[1]: http://y";
    expect(tidyWhitespace(normaliseMarkdown(md))).toBe("T\nRTP: 96%\nMax win: 5,000x\nVolatility: High\na bold");
  });

  it("drops email headers, quote markers and the signature", () => {
    expect(tidyWhitespace(normaliseEmail("From: a@b\nSubject: x\n\n> *Info*\n> RTP: 96%\n--\nSam\nlegal"))).toBe("Info\nRTP: 96%");
  });

  it("rejoins hyphenated words and drops PDF running headers", () => {
    expect(tidyWhitespace(normalisePdfText("S — Game Rules v1    CONFIDENTIAL\nextra-\nordinary win\nPage 1 of 2\n\f"))).toBe("extraordinary win");
  });

  it("matchKey folds case, quotes, dashes and whitespace", () => {
    expect(matchKey("It’s  a\n“BIG” – win")).toBe(`it's a "big" - win`);
  });
});
