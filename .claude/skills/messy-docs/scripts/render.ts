/**
 * Deterministic messy-document renderer.
 *
 * Takes a clean document made of tagged sections and renders it into a realistic, messy source format
 * (CMS HTML, aggregator XML, Markdown release notes, forwarded email, PDF-extracted text), optionally damaged.
 * Returns the raw text plus which tags survived, so an eval can tell a correct abstention from a missed extraction.
 *
 * No dependencies; seeded, so the same input + seed always gives the same bytes.
 *
 * CLI:  node render.ts --in doc.json [--format cms_html|aggregator_xml|markdown|email|pdf_text|random]
 *                      [--seed 42] [--damage truncate,mojibake,boilerplate,whitespace]
 */

export const FORMATS = ["cms_html", "aggregator_xml", "markdown", "email", "pdf_text"] as const;
export type Format = (typeof FORMATS)[number];

export const DAMAGES = ["truncate", "mojibake", "boilerplate", "whitespace"] as const;
export type Damage = (typeof DAMAGES)[number];

export interface CleanSection {
  heading?: string;
  /** Prose, or "Key: value" lines. Key/value lines render as tables, bullets or definition rows depending on format. */
  text: string;
  /** Facts this section states. Opaque to the renderer; reported back as surviving or partial. */
  tags: string[];
}

export interface CleanDoc {
  docId: string;
  title: string;
  source?: string;
  sections: CleanSection[];
}

export interface RenderOptions {
  format: Format;
  seed: number;
  damage?: Damage[];
}

export interface RenderedDoc {
  docId: string;
  format: Format;
  contentType: string;
  text: string;
  /** Tags whose section is fully present. */
  survivingTags: string[];
  /** Tags whose section was cut mid-way. Exclude from scoring: the fact may or may not still be readable. */
  partialTags: string[];
  appliedDamage: Damage[];
}

const CONTENT_TYPES: Record<Format, string> = {
  cms_html: "text/html",
  aggregator_xml: "application/xml",
  markdown: "text/markdown",
  email: "message/rfc822",
  pdf_text: "text/plain",
};

// ---------- Seeded randomness ----------

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const chance = (rng: Rng, p: number) => rng() < p;

// ---------- Text helpers ----------

const KV_LINE = /^\s*([A-Za-z][\w /().%-]{0,40}):\s+(.+)$/;

function splitLines(text: string) {
  return text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
}

function isKvBlock(text: string) {
  const lines = splitLines(text);
  return lines.length > 0 && lines.every((l) => KV_LINE.test(l));
}

function kvPairs(text: string): [string, string][] {
  return splitLines(text).map((l) => {
    const m = l.match(KV_LINE)!;
    return [m[1]!, m[2]!];
  });
}

/** Typographic quotes and dashes, as a CMS or word processor would produce. */
function smarten(s: string) {
  return s
    .replace(/(^|[\s(])'/g, "$1‘")
    .replace(/'/g, "’")
    .replace(/(^|[\s(])"/g, "$1“")
    .replace(/"/g, "”")
    .replace(/ - /g, " – ");
}

function escapeHtml(s: string, rng: Rng) {
  let out = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // CMSs are inconsistent: sometimes named entities, sometimes raw UTF-8, sometimes numeric.
  if (chance(rng, 0.6)) out = out.replace(/’/g, "&rsquo;").replace(/‘/g, "&lsquo;");
  if (chance(rng, 0.5)) out = out.replace(/“/g, "&ldquo;").replace(/”/g, "&rdquo;");
  if (chance(rng, 0.5)) out = out.replace(/£/g, "&pound;");
  else if (chance(rng, 0.3)) out = out.replace(/£/g, "&#163;");
  if (chance(rng, 0.4)) out = out.replace(/–/g, "&ndash;");
  if (chance(rng, 0.3)) out = out.replace(/ (?=\d)/g, "&nbsp;");
  return out;
}

// ---------- Format renderers ----------

function renderCmsHtml(doc: CleanDoc, rng: Rng): string {
  const wordExport = chance(rng, 0.5);
  const p = (inner: string) => {
    const style = wordExport ? ` class="MsoNormal" style="margin:0cm 0cm 8pt;line-height:107%"` : "";
    // Some CMS exports leave paragraphs unclosed.
    return chance(rng, 0.15) ? `<p${style}>${inner}` : `<p${style}>${inner}</p>`;
  };
  const heading = (h: string) =>
    pick(rng, [
      `<h2>${h}</h2>`,
      `<h3 class="section-title">${h}</h3>`,
      `<p><strong>${h}</strong></p>`,
      `<p><b><span style="font-size:14.0pt;font-family:'Arial',sans-serif">${h}</span></b></p>`,
      `<div class="hdr"><font color="#c8102e"><b>${h.toUpperCase()}</b></font></div>`,
    ]);

  const body = doc.sections.map((s) => {
    const parts: string[] = [];
    if (s.heading) parts.push(heading(escapeHtml(s.heading, rng)));
    if (isKvBlock(s.text)) {
      const rows = kvPairs(s.text)
        .map(([k, v]) => `  <tr><td class="lbl">${escapeHtml(k, rng)}</td><td>${escapeHtml(v, rng)}</td></tr>`)
        .join("\n");
      parts.push(`<table border="0" cellpadding="2" style="width:100%">\n<tbody>\n${rows}\n</tbody>\n</table>`);
    } else {
      for (const para of splitLines(s.text)) {
        const html = escapeHtml(para, rng);
        parts.push(chance(rng, 0.2) ? `${html}<br><br>` : p(html));
      }
    }
    return parts.join("\n");
  });

  return [
    `<!-- Exported from ${doc.source ?? "StudioCMS"} ${pick(rng, ["v3.2.1", "v2.9", "build 4471"])} -->`,
    `<div class="game-content" id="gc-${doc.docId}" style="font-family:Arial;color:#333">`,
    chance(rng, 0.4) ? `<style>.lbl{font-weight:bold}.hdr{margin-top:12px}</style>` : "",
    `<h1>${escapeHtml(doc.title, rng)}</h1>`,
    ...body,
    chance(rng, 0.5)
      ? `<script type="text/javascript">window.dataLayer=window.dataLayer||[];dataLayer.push({event:"rules_view",gid:"${doc.docId}"});</script>`
      : "",
    `<div class="footer"><small>&copy; ${pick(rng, ["2023", "2024", "2025"])} All rights reserved. 18+ BeGambleAware.org</small></div>`,
    `</div>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderAggregatorXml(doc: CleanDoc, rng: Rng): string {
  const ns = pick(rng, ["agg", "gf", "ns2"]);
  // Aggregators can't agree whether rich text is CDATA, escaped HTML, or plain text.
  const encodeBody = (text: string) => {
    const html = splitLines(text).map((l) => `<p>${l}</p>`).join("");
    const mode = rng();
    if (mode < 0.4) return `<![CDATA[${html}]]>`;
    if (mode < 0.75) return html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  };

  const sections = doc.sections.map((s, i) => {
    const name = s.heading ? ` name="${s.heading.replace(/"/g, "&quot;").replace(/&/g, "&amp;")}"` : "";
    if (isKvBlock(s.text) && chance(rng, 0.7)) {
      const attrStyle = chance(rng, 0.5);
      const items = kvPairs(s.text)
        .map(([k, v]) => {
          const key = k.toLowerCase().replace(/[^a-z0-9]+/g, "_");
          const val = v.replace(/&/g, "&amp;").replace(/</g, "&lt;");
          return attrStyle
            ? `      <${ns}:Attr key="${key}" value="${val.replace(/"/g, "&quot;")}"/>`
            : `      <${ns}:${key}>${val}</${ns}:${key}>`;
        })
        .join("\n");
      return `    <${ns}:Section idx="${i}"${name}>\n${items}\n    </${ns}:Section>`;
    }
    return `    <${ns}:Section idx="${i}"${name} type="text/html">${encodeBody(s.text)}</${ns}:Section>`;
  });

  return [
    `<?xml version="1.0" encoding="${pick(rng, ["UTF-8", "utf-8", "ISO-8859-1"])}"?>`,
    `<${ns}:GameAsset xmlns:${ns}="urn:aggregator:gamefeed:${pick(rng, ["2.1", "2.0", "3"])}" assetId="${doc.docId}" lang="${pick(rng, ["en-GB", "en", "EN_gb"])}">`,
    `  <${ns}:Title><![CDATA[${doc.title}]]></${ns}:Title>`,
    chance(rng, 0.5) ? `  <${ns}:Provider>${doc.source ?? ""}</${ns}:Provider>` : `  <${ns}:Provider/>`,
    `  <${ns}:Content>`,
    ...sections,
    `  </${ns}:Content>`,
    `</${ns}:GameAsset>`,
  ].join("\n");
}

function markdownKv(pairs: [string, string][], bullet: string, rng: Rng): string[] {
  if (chance(rng, 0.4)) {
    // Hand-written tables with misaligned pipes.
    return [`| Item | Value |\n|---|---|`, ...pairs.map(([k, v]) => `| ${k} |${v} ${chance(rng, 0.3) ? "" : "|"}`)];
  }
  return pairs.map(([k, v]) => `${bullet} ${chance(rng, 0.6) ? `**${k}:**` : `${k} -`} ${v}`);
}

function markdownSection(s: CleanSection, bullet: string, rng: Rng): string[] {
  const out: string[] = [];
  if (s.heading) out.push(pick(rng, [`## ${s.heading}`, `### ${s.heading}`, `**${s.heading}**`, `${s.heading}:`]));
  if (isKvBlock(s.text)) out.push(...markdownKv(kvPairs(s.text), bullet, rng));
  else for (const para of splitLines(s.text)) out.push(chance(rng, 0.15) ? `${para}<br>` : para);
  out.push("");
  return out;
}

function renderMarkdown(doc: CleanDoc, rng: Rng): string {
  const bullet = pick(rng, ["-", "*", "•"]);
  const out: string[] = [];
  out.push(chance(rng, 0.5) ? `# ${doc.title}` : `${doc.title}\n${"=".repeat(doc.title.length)}`);
  if (chance(rng, 0.4)) out.push(`_${pick(rng, ["DRAFT", "v2 – updated", "FINAL (2)"])}_ ${pick(rng, ["🎰", "🚀", ""])}`);
  for (const s of doc.sections) out.push(...markdownSection(s, bullet, rng));
  if (chance(rng, 0.5)) out.push(`[Assets](https://cdn.example.invalid/${doc.docId}/assets.zip) | [Paytable PDF][1]\n\n[1]: https://cdn.example.invalid/${doc.docId}/paytable.pdf`);
  return out.join("\n");
}

function renderEmail(doc: CleanDoc, rng: Rng): string {
  const from = (doc.source ?? "studio").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const quote = chance(rng, 0.6);
  const body = doc.sections
    .map((s) => {
      const lines = [s.heading ? (chance(rng, 0.5) ? s.heading.toUpperCase() : `*${s.heading}*`) : "", ...splitLines(s.text)]
        .filter(Boolean)
        .map((l) => (quote ? `> ${l}` : l));
      return lines.join("\n");
    })
    .join(quote ? "\n>\n" : "\n\n");

  return [
    `From: ${pick(rng, ["releases", "account.management", "no-reply"])}@${from}.example`,
    `To: content-ops@operator.example`,
    `Subject: ${pick(rng, ["FW: ", "Fwd: RE: ", "RE: "])}Launch pack – ${doc.title}`,
    `Date: ${pick(rng, ["Tue, 4 Mar 2025 09:14:02 +0000", "Thu, 12 Jun 2025 16:40:11 +0100", "Mon, 3 Nov 2025 11:02:57 +0000"])}`,
    `Content-Type: text/plain; charset="${pick(rng, ["utf-8", "windows-1252"])}"`,
    ``,
    pick(rng, ["Hi team,", "Hi all,", "Morning,", "FYI see below from the studio."]),
    ``,
    quote ? `---------- Forwarded message ---------\nFrom: Product Team <product@${from}.example>\n` : "",
    body,
    ``,
    pick(rng, ["Thanks,\nSam", "Kind regards,\nAccount Management", "Cheers\nJ"]),
    `--`,
    `This email and any attachments are confidential and intended solely for the addressee. If you have received this email in error please notify the sender.`,
    chance(rng, 0.3) ? `\nSent from my iPhone` : "",
  ].join("\n");
}

/** Hard wraps with hyphenation, as text extraction from a PDF produces. */
export function wrapParagraph(para: string, width: number, rng: Rng): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of para.split(/\s+/)) {
    if ((line + " " + word).trim().length <= width) {
      line = (line + " " + word).trim();
    } else if (word.length > 7 && chance(rng, 0.35)) {
      const cut = Math.max(3, Math.floor(word.length / 2));
      lines.push(`${line} ${word.slice(0, cut)}-`.trim());
      line = word.slice(cut);
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Splits lines into pages of 30, dropping pages with nothing on them. */
export function paginate(lines: string[], perPage = 30): string[][] {
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) {
    const page = lines.slice(i, i + perPage);
    if (page.some((l) => l.trim())) pages.push(page);
  }
  return pages;
}

function renderPdfText(doc: CleanDoc, rng: Rng): string {
  const width = 58 + Math.floor(rng() * 18);
  const ligatures = chance(rng, 0.6);
  const lines: string[] = [doc.title.toUpperCase(), ""];
  for (const s of doc.sections) {
    if (s.heading) lines.push(s.heading.toUpperCase(), "");
    for (const para of splitLines(s.text)) lines.push(...wrapParagraph(para, width, rng), "");
  }

  const pages = paginate(lines);
  const header = `${doc.source ?? "Studio"} — Game Rules ${pick(rng, ["v1.0", "v1.3", "rev. B"])}    CONFIDENTIAL`;
  const text = pages.map((p, i) => [header, "", ...p, "", `Page ${i + 1} of ${pages.length}`, "\f"].join("\n")).join("\n");
  return ligatures ? text.replace(/fi/g, "\ufb01").replace(/fl/g, "\ufb02") : text;
}

const RENDERERS: Record<Format, (doc: CleanDoc, rng: Rng) => string> = {
  cms_html: renderCmsHtml,
  aggregator_xml: renderAggregatorXml,
  markdown: renderMarkdown,
  email: renderEmail,
  pdf_text: renderPdfText,
};

// ---------- Damage ----------

/** Drops trailing sections and cuts the last kept one mid-sentence. Its tags become partial. */
function truncate(doc: CleanDoc, rng: Rng): { doc: CleanDoc; partial: Set<number>; dropped: Set<number> } {
  const n = doc.sections.length;
  if (n < 2) return { doc, partial: new Set(), dropped: new Set() };
  // Keep at least half: real truncation loses the tail (bonus rules, RTP footer), not the whole doc.
  const minKeep = Math.ceil(n / 2);
  const keep = minKeep + Math.floor(rng() * (n - minKeep));
  const sections = doc.sections.slice(0, keep).map((s) => ({ ...s }));
  const last = sections[keep - 1]!;
  const cutAt = Math.floor(last.text.length * (0.4 + rng() * 0.3));
  last.text = last.text.slice(0, cutAt).replace(/\s+\S*$/, "");
  const dropped = new Set(Array.from({ length: n - keep }, (_, i) => keep + i));
  return { doc: { ...doc, sections }, partial: new Set([keep - 1]), dropped };
}

/** UTF-8 bytes read as Windows-1252: the classic "â€™" corruption. */
function mojibake(text: string, rng: Rng) {
  const map: Record<string, string> = {
    "’": "â€™",
    "‘": "â€˜",
    "“": "â€œ",
    "”": "â€\u009d",
    "–": "â€“",
    "—": "â€”",
    "£": "Â£",
    "é": "Ã©",
  };
  return text.replace(/[’‘“”–—£é]/g, (c) => (chance(rng, 0.8) ? map[c]! : c));
}

function boilerplate(text: string, format: Format, rng: Rng) {
  const notice = pick(rng, [
    "This game is available to players aged 18+ only. Please gamble responsibly.",
    "Game rules are subject to change. In the event of a malfunction all pays and plays are void.",
    "Images for illustrative purposes only. Terms apply.",
  ]);
  if (format === "cms_html") return text.replace(/<\/div>\s*$/, `<p class="legal"><em>${notice}</em></p>\n</div>`);
  if (format === "aggregator_xml") return text.replace(/(<\/\w+:Content>)/, `  <!-- ${notice} -->\n  $1`);
  return `${text}\n\n${notice}`;
}

function whitespace(text: string, rng: Rng) {
  return text
    .split("\n")
    .map((l) => (chance(rng, 0.2) ? `${l}${" ".repeat(1 + Math.floor(rng() * 4))}` : l))
    .join(chance(rng, 0.5) ? "\r\n" : "\n")
    .replace(/\. /g, () => (chance(rng, 0.15) ? ".  " : ". "));
}

// ---------- Entry point ----------

export function render(input: CleanDoc, opts: RenderOptions): RenderedDoc {
  const rng = mulberry32(opts.seed ^ hashString(input.docId));
  const damage = opts.damage ?? [];

  let doc: CleanDoc = { ...input, sections: input.sections.map((s) => ({ ...s, text: smarten(s.text) })) };
  let partial = new Set<number>();
  let dropped = new Set<number>();
  if (damage.includes("truncate")) ({ doc, partial, dropped } = truncate(doc, rng));

  let text = RENDERERS[opts.format](doc, rng);
  if (damage.includes("boilerplate")) text = boilerplate(text, opts.format, rng);
  if (damage.includes("mojibake")) text = mojibake(text, rng);
  if (damage.includes("whitespace")) text = whitespace(text, rng);

  const surviving = new Set<string>();
  const partialTags = new Set<string>();
  input.sections.forEach((s, i) => {
    if (dropped.has(i)) return;
    for (const t of s.tags) (partial.has(i) ? partialTags : surviving).add(t);
  });
  // A tag stated fully in one section and partially in another is still fully present.
  for (const t of surviving) partialTags.delete(t);

  return {
    docId: input.docId,
    format: opts.format,
    contentType: CONTENT_TYPES[opts.format],
    text,
    survivingTags: [...surviving].sort(),
    partialTags: [...partialTags].sort(),
    appliedDamage: damage,
  };
}

/** Pick a format at random from those plausible for a given document kind. */
export function pickFormat(candidates: readonly Format[], seed: number, docId: string): Format {
  return pick(mulberry32(seed ^ hashString(`fmt:${docId}`)), candidates);
}

// ---------- CLI ----------

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] : undefined;
}

/** Parses CLI arguments into a document path and render options; throws on unknown formats or damage. */
export function parseCliArgs(argv: readonly string[], readDoc: (path: string) => CleanDoc) {
  const path = argValue(argv, "--in");
  if (!path) throw new Error("usage: node render.ts --in doc.json [--format <fmt>|random] [--seed N] [--damage a,b]");
  const doc = readDoc(path);
  const seed = Number(argValue(argv, "--seed") ?? 42);
  const requested = argValue(argv, "--format") ?? "random";
  const format = requested === "random" ? pickFormat(FORMATS, seed, doc.docId) : (requested as Format);
  if (!FORMATS.includes(format)) throw new Error(`unknown format ${format}; expected one of ${FORMATS.join(", ")}`);
  const damage = (argValue(argv, "--damage")?.split(",") ?? []) as Damage[];
  for (const d of damage) if (!DAMAGES.includes(d)) throw new Error(`unknown damage ${d}`);
  return { doc, options: { format, seed, damage } satisfies RenderOptions };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import("node:fs");
  const { doc, options } = parseCliArgs(process.argv, (p) => JSON.parse(readFileSync(p, "utf8")) as CleanDoc);
  console.log(JSON.stringify(render(doc, options), null, 2));
}
