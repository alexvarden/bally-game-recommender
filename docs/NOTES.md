# Working notes

A running log kept during the exercise. The README draws on it for time allocation, assumptions, AI usage and
failure cases. Newest entries go at the bottom of each section.

## Time log

Brief received 11:57. Four-hour timebox.

| Block | Clock | Approx. | What |
|---|---|---|---|
| Planning | 11:57–12:22 | 25m | Read the brief, drafted the plan, researched what an iGaming operator stores per game, wrote `features-list.md` |
| Schema and messy input | 12:22–12:42 | 20m | Catalogue schema with trust tiers; messy-docs skill (seeded renderer for HTML/XML/Markdown/email/PDF text) |
| Catalogue generation | 12:42–13:05 | 25m | plan → generate → degrade pipeline; provider-agnostic LLM client; generated 100 games for ~$0.05 |
| Review and process | 13:05–13:10 | 5m | Re-read the brief against progress; started this log |
| Project rules and quality gates | 13:10–13:25 | 15m | `CLAUDE.md`; vitest with coverage thresholds; CRAP report; pre-commit hook and GitHub Actions; refactored the generator into small functions and tested everything (97 tests, 98.5% statements, max CRAP 10) |

## AI tools used

- **Claude Code** for planning, research, code, and running the pipeline. It used its bundled `claude-api` skill
  for current SDK and model guidance.
- **messy-docs** (our skill, `.claude/skills/messy-docs/`) to render realistic source documents.
- **openai/gpt-6-luna via OpenRouter** to generate the catalogue content (27 calls, 63k input / 88k output tokens).

## AI output changed or rejected

1. **Rejected: having the LLM write the messy HTML/XML directly.** It would be unreproducible, expensive to vary,
   and we'd lose track of which facts each document still contains. Replaced with a seeded renderer: the LLM writes
   clean tagged sections, code applies the mess.
2. **Changed: the generation prompt.** On the trial batch the model left `secondaryFeatures` empty for all three
   games and over-tagged experience fields from general tone. Tightened the prompt before the full run; afterwards
   0/75 slots had empty features.
3. **Rejected by code: unverifiable fact tags.** In 20 places the model claimed a section stated a number that
   wasn't in it (usually "choose a stake within the limits" tagged as stating the stake). The generator drops these;
   spot checks confirmed each drop was correct.
4. **Ignored by the model: the licensed IP instruction.** Only 1 of 6 planned games got a fictional licence. Accepted
   as a known gap rather than spending more on regeneration.
5. **Changed: model choice.** Started on Claude Opus 5.5 (est. $5–8); the OpenRouter balance was ~$0.34, so switched
   to gpt-6-luna at the user's direction. Recorded in the manifest.

## Assumptions

- Studios, game names and licensed IP are fictional. Brand names (Jackpotjoy, Virgin Games, Monopoly Casino,
  Rainbow Riches Casino, Double Bubble Bingo, Bally Casino US) are real because they are the operator's own sites.
- The UK's £5 per-spin online slot stake limit applies to every GB-available slot, Slingo included.
- Bonus buy appears only on US-only games, as many GB operators don't offer it.
- Jurisdiction means "certified for", brand means "listed on". So a game can be ES-certified without an ES brand
  in the catalogue.
- In-house games have rich, mostly complete records and slightly lower RTPs. Aggregator games have sparse feeds
  with inconsistent units and labels.
- Commercial signals (game revenue, average stake) are deliberately excluded from ranking, for consumer-protection
  reasons.
- Regulated facts may be extracted from a document with a verified quote, but never inferred.
- Operator-owned facts (brands, jurisdictions, status) come only from the feed. The LLM can't write them.

## Agreed design (13:30–14:00 discussion)

- **Ingestion:** new titles land in an S3 bucket (locally a folder behind an `ObjectStore` interface); a run-once
  `npm run pipeline` reads new objects into SQLite behind a `CatalogueStore` interface. Push API, supplier polling,
  SQS fan-out and snapshot diffing are noted, not built.
- **Seeding:** most of the catalogue is pre-processed and committed as JSON; `npm run db:seed` builds SQLite. About
  10 new titles and 2 updates (an RTP change, a late document) are left unprocessed in the bucket for the demo.
- **Regulated-fact conflict** between feed and document: the game is quarantined until a human resolves it.
- **Enrichment model:** gpt-6-terra via OpenRouter (a different model from the generator, so the eval isn't
  self-grading).
- **Similarity:** one vector per aspect (content, gameplay, experience), weighted, from a local transformers.js
  model behind an `Embedder` interface. Scored live per request from in-memory vectors. No format rules, no family
  rule. Baselines for the eval: raw-text embedding, TF-IDF, random.
- **Guardrails:** volatility step-up limit only. Under-18 appeal isn't filtered because the site is 18+ and
  age-verified; UK advertising codes judge appeal by content, so marketing outside the site would differ.
- **Service:** Fastify; `GET /v1/brands/:brand/games/:gameId/recommendations`; brand only (assumption: the brand
  decides availability); brand fallback list with a reason code; no player-facing reasons; index hot-swap with
  validation; pino structured logs; `/readyz`. No publish gate.
- **Game management:** tiered admin API on a separate port with a bearer token. Operator fields apply immediately,
  regulated facts only via conflict resolution, descriptive overrides marked `provenance: operator`, creation goes
  through the bucket, delete means retire. Append-only audit log with a required reason. Single static admin page:
  list/filter, suspend/reinstate/retire. Actor recorded as `admin`.
- **Evals:** scoring of committed outputs runs in CI; live LLM re-runs on demand. Claude drafts the hand labels for
  matching. The generator eval is skipped and logged as a known gap.
- **Part B:** the messy-docs skill. **Workflow:** public GitHub repo, a PR per workstream.

## Failure cases worth showing

Collected as they turn up; the eval section of the README picks from these.

- (Planted) `BLY-SLT-0013` Frostbound Saga is very high volatility, but its blurb says "Gentle low-volatility play
  with frequent small wins." Enrichment should flag the conflict, not trust the blurb.
- (Planted) `BLY-SLT-0018`, `-0051`, `-0052` have another game's rules text. Enrichment should mark the doc suspect.
- (Planted) `BLY-SLT-0044` Mossglade Neighbours has a cartoon theme that could appeal to under-18s, a one-line blurb,
  and no responsible-gambling flag in the feed. Enrichment should suggest the flag back.

## Decisions log

Short entries; the ADR covers the big ones.

- No LLM on the request path: enrichment and embeddings run offline per catalogue version.
- Recommendations are precomputed per (brand, game) at index build; the service serves a versioned index.
- One structured-output client (`src/lib/llm.ts`) for every LLM call; it always re-validates with zod.
- Every LLM call site must have an automated way to check it works (see `CLAUDE.md`).
- Quality gates: coverage ≥ 85% (branches ≥ 75%) and no function over CRAP 30, enforced by a pre-commit hook and
  CI. Direct commits to `main` are refused; work goes through branches.
- Golden tests pin the committed data: re-running plan or degrade from the committed seed must reproduce the
  committed files byte for byte. They caught nothing during the refactor, which is the point: they made it safe to
  split `buildPlan` (complexity 49) and `feedRecord` (43) into small functions.
- CRAP is computed by our own small script (Babel AST + Istanbul JSON) rather than a dependency: about 150 lines,
  tested, and no TypeScript-version coupling.
- **Open: the catalogue generator's LLM call has contract checks but no eval yet.** It needs an LLM-as-judge (or
  sampled human check) on whether generated documents are consistent with their ground truth, per the rule.
