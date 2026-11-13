---
name: messy-docs
description: Generate realistic, messy unstructured source documents (CMS HTML, aggregator XML, Markdown release notes, forwarded emails, PDF-extracted text) from clean tagged content, with ground truth on which facts survived. Use when building fixtures or eval data for an ingestion, extraction or enrichment pipeline, or when the user asks for "messy", "realistic" or "dirty" input documents.
---

# messy-docs

Extraction pipelines are only as good as the mess they were tested against. This skill turns clean content into the documents a real system receives, deterministically, and keeps track of which facts are still in each one.

**The core rule:** an LLM writes the *content*, but code applies the *mess*. If an LLM wrote the HTML, you couldn't reproduce it, couldn't vary it cheaply, and wouldn't know which facts it dropped.

## Workflow

1. **Write clean content as tagged sections.** Each section is either prose or `Key: value` lines, and each lists the facts it states in `tags`. Tags are opaque strings; use your schema's field names. See `examples/rules-doc.json`.
   - Put one kind of fact per section where possible. That makes truncation ground truth precise.
   - Generate this with an LLM if you like, but validate it against a schema before rendering.
2. **Choose a format for each document kind**, matching what that source sends in reality. For example, for an iGaming catalogue:

   | Document kind | Plausible formats |
   |---|---|
   | Rules / help text | `cms_html`, `pdf_text`, `aggregator_xml` |
   | Marketing blurb | `aggregator_xml`, `cms_html` |
   | Release note | `email`, `markdown` |
   | Editorial copy | `markdown`, `cms_html` |

   Use `pickFormat(candidates, seed, docId)` so the choice is stable across runs.
3. **Choose damage**, sparingly and by source. Clean in-house sources get little damage; third-party feeds get more.
4. **Render.** From code: `import { render } from ".claude/skills/messy-docs/scripts/render.ts"`. Ad hoc: run the CLI below.
5. **Store `text`, `format` and `contentType` in the ingested dataset.** Store `survivingTags` and `partialTags` **only in the ground truth**. Never let tags leak into what the pipeline sees.
6. **Score extraction against `survivingTags`.** A `null` for a tag that didn't survive is a *correct abstention*. Leave `partialTags` out of scoring.

```bash
node .claude/skills/messy-docs/scripts/render.ts --in examples/rules-doc.json --format cms_html --seed 7
node .claude/skills/messy-docs/scripts/render.ts --in examples/rules-doc.json --format random --seed 3 --damage truncate,mojibake
```

## Formats and what makes each one realistic

| Format | Mess it produces |
|---|---|
| `cms_html` | MS Word export classes (`MsoNormal`), inline styles, `<font>` tags, a mix of named, numeric and raw entities (`&rsquo;`, `&#163;`, `£`), `&nbsp;` before numbers, unclosed `<p>`, `<br><br>` used as paragraphs, key/value pairs as tables, tracking `<script>`, legal footer |
| `aggregator_xml` | Random namespace prefixes, rich text as CDATA *or* escaped HTML *or* plain text, key/value pairs as attributes *or* elements, inconsistent `encoding` and `lang` |
| `markdown` | Setext or ATX title, headings of mixed levels or bold labels, `-`, `*` or `•` bullets, tables with misaligned pipes, stray `<br>`, draft markers, emoji, reference links |
| `email` | Forward or reply headers, quoted `> ` body, headings in capitals, signature, confidentiality footer, "Sent from my iPhone" |
| `pdf_text` | Hard wrapping at 58–75 columns, hyphenation across line breaks, running header with "CONFIDENTIAL", page numbers, form feeds, `ﬁ`/`ﬂ` ligatures |

| Damage | Effect | Effect on ground truth |
|---|---|---|
| `truncate` | Drops trailing sections and cuts the last kept one mid-sentence. Always keeps at least half. | Dropped tags are gone; the cut section's tags become `partialTags` |
| `mojibake` | UTF-8 read as Windows-1252 (`â€™`, `Â£`) | None |
| `boilerplate` | Adds a legal or responsible-gambling notice | None |
| `whitespace` | Trailing spaces, CRLF line endings, double spaces after full stops | None |

Damage that changes *which game a document describes* (copy-pasted rules, conflicting values) is semantic, not formatting. It belongs in the caller's degrade step, not here.

## Downstream implications

Remember these when you build the pipeline that reads these documents:

- **Normalise to text before extraction and before verifying evidence.** This means decoding entities, stripping tags, unwrapping CDATA, removing hyphenation, expanding ligatures, fixing mojibake and collapsing whitespace. Then check quotes against that *same* normalised text, or every quote from an HTML doc fails on `&amp;`.
- **Normalisation is deterministic code with its own unit tests.** Use these fixtures as its test inputs.

## Extending

To add a format, write a `(doc, rng) => string` renderer, register it in `RENDERERS` and `CONTENT_TYPES`, and add a row to the table above. Rules:
- All randomness goes through `rng`, never `Math.random`.
- Never invent or remove facts. Only formatting changes.
- Run the CLI on `examples/rules-doc.json` and read the output before you commit.

## Using it on another project

Nothing in `render.ts` is specific to games. For the next prototype that extracts structure from documents, whether contracts, product specs or support tickets:
1. Write about 5 clean, tagged examples of the domain's documents.
2. Map the domain's document kinds to formats.
3. Render with a fixed seed.

That gives a reproducible extraction eval with real abstention ground truth, in less than an hour.
