/**
 * Raw document → plain text, deterministically.
 *
 * Every wire format the catalogue receives (CMS HTML, aggregator XML, Markdown, forwarded email, PDF-extracted text)
 * is reduced to readable lines. Evidence quotes from the LLM are verified against this text, so the property that
 * matters is: every fact stated in the source survives, findable with `matchKey`.
 */
import type { DocumentFormat } from "../catalogue/schema.ts";
import type { z } from "zod";

type Format = z.infer<typeof DocumentFormat>;

// ---------- Shared cleanup ----------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“",
  rdquo: "”", ndash: "–", mdash: "—", pound: "£", euro: "€", copy: "©", trade: "™", hellip: "…",
};

/** Decodes named and numeric HTML/XML entities. Unknown names are left as they are. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** UTF-8 bytes decoded as Windows-1252. Longest sequences first so "â€™" isn't half-fixed. */
const MOJIBAKE: [string, string][] = [
  ["â€™", "’"], ["â€˜", "‘"], ["â€œ", "“"], ["â€\u009d", "”"], ["â€“", "–"], ["â€”", "—"],
  ["â€¦", "…"], ["Â£", "£"], ["Ã©", "é"], ["Â ", " "],
];

export function fixMojibake(s: string): string {
  return MOJIBAKE.reduce((text, [bad, good]) => text.split(bad).join(good), s);
}

const LIGATURES: [string, string][] = [["ﬁ", "fi"], ["ﬂ", "fl"], ["ﬀ", "ff"], ["ﬃ", "ffi"], ["ﬄ", "ffl"]];

export const expandLigatures = (s: string) => LIGATURES.reduce((text, [lig, plain]) => text.split(lig).join(plain), s);

/** Trims lines, collapses runs of spaces and blank lines, and normalises line endings. */
export function tidyWhitespace(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- HTML and XML ----------

const BLOCK_END = /<\/(p|div|h[1-6]|li|tr|table|tbody|section)>|<br\s*\/?>/gi;

/** Removes markup, keeping block boundaries as newlines and table cells as "label: value". */
export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/td>\s*<td[^>]*>/gi, ": ")
    .replace(BLOCK_END, "\n")
    .replace(/<p(\s[^>]*)?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
}

export function normaliseHtml(raw: string): string {
  return stripTags(decodeEntities(stripTags(raw)));
}

/** Leaf key/value elements and attributes become "key: value" lines; everything else is stripped as markup. */
export function normaliseXml(raw: string): string {
  const keyName = (k: string) => k.replace(/_/g, " ");
  const text = raw
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[\w:]*Attr\s+key="([^"]*)"\s+value="([^"]*)"\s*\/>/g, (_, k: string, v: string) => `\n${keyName(k)}: ${v}\n`)
    .replace(/<[\w]+:Section[^>]*\bname="([^"]*)"[^>]*>/g, "\n$1\n")
    .replace(/<\w+:(?!Title|Provider|Content|Section|GameAsset)(\w+)>([^<]*)<\/\w+:\1>/g, (_, k: string, v: string) => `\n${keyName(k)}: ${v}\n`)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Rich text arrives as CDATA, escaped HTML or plain text: strip, decode, then strip what decoding revealed.
  return normaliseHtml(text);
}

// ---------- Markdown ----------

const MARKDOWN_RULES: [RegExp, string][] = [
  [/^\[\d+\]:\s+\S+.*$/gm, ""], // reference link definitions
  [/!?\[([^\]]*)\]\([^)]*\)/g, "$1"], // inline links and images
  [/\[([^\]]*)\]\[\d+\]/g, "$1"], // reference links
  [/^\s*\|?\s*:?-{2,}.*$/gm, ""], // table separator rows
  [/^\s*\|\s*Item\s*\|\s*Value\s*\|\s*$/gim, ""], // the generic table header
  [/^\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|?\s*$/gm, "$1: $2"], // two-column rows → "key: value"
  [/^\s*[-*•]\s+\*\*([^*]+?):?\*\*:?\s*/gm, "$1: "], // "- **Key:** value"
  [/^\s*[-*•]\s+([^:\n]+?) - (.+)$/gm, "$1: $2"], // "• Key - value"
  [/^\s*[-*•]\s+/gm, ""], // other bullets
  [/^#{1,6}\s+/gm, ""], // ATX headings
  [/^[=-]{3,}\s*$/gm, ""], // setext underlines
  [/\*\*([^*]+)\*\*/g, "$1"], // bold
  [/<br\s*\/?>/gi, "\n"],
];

export function normaliseMarkdown(raw: string): string {
  return MARKDOWN_RULES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), raw);
}

// ---------- Email ----------

const HEADER_LINE = /^(From|To|Cc|Subject|Date|Content-Type|Sent|Reply-To):/i;

/** Drops headers, forward banners, quote markers and everything after the signature delimiter. */
export function normaliseEmail(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const sigIndex = lines.findIndex((l) => l.trim() === "--");
  return (sigIndex >= 0 ? lines.slice(0, sigIndex) : lines)
    .filter((l) => !HEADER_LINE.test(l.trim()) && !/^-+ ?Forwarded message/i.test(l.trim()))
    .map((l) => l.replace(/^\s*>\s?/, "").replace(/^\*([^*]+)\*$/, "$1"))
    .join("\n");
}

// ---------- PDF text ----------

const PDF_NOISE = [/^.*Game Rules.*CONFIDENTIAL\s*$/i, /^\s*Page \d+ of \d+\s*$/i];

/** Removes running headers and page numbers, then rejoins words hyphenated across line breaks. */
export function normalisePdfText(raw: string): string {
  return raw
    .replace(/\f/g, "\n")
    .split("\n")
    .filter((l) => !PDF_NOISE.some((p) => p.test(l)))
    .join("\n")
    .replace(/([a-z])-[ \t]*\n+[ \t]*([a-z])/g, "$1$2");
}

// ---------- Entry point ----------

const BY_FORMAT: Record<Format, (raw: string) => string> = {
  cms_html: normaliseHtml,
  aggregator_xml: normaliseXml,
  markdown: normaliseMarkdown,
  email: normaliseEmail,
  pdf_text: normalisePdfText,
};

/** Raw document bytes → readable plain text. Encoding repairs run first, so format rules see clean characters. */
export function normaliseDocument(raw: string, format: Format): string {
  const repaired = expandLigatures(fixMojibake(raw.replace(/\r\n?/g, "\n")));
  return tidyWhitespace(decodeEntities(BY_FORMAT[format](repaired)));
}

/**
 * The comparison form used to check that a quote appears in a document: Unicode-normalised, typographic quotes and
 * dashes folded to ASCII, case-folded, whitespace collapsed. Quotes may differ from the doc only in these ways.
 */
export function matchKey(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/ /g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
