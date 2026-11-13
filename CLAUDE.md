# Project rules

A game recommender for a regulated, real-money casino site: "Because you played X, you might like…".
Read `spec.md` for the brief and `docs/NOTES.md` for decisions so far. These rules apply to every change, by a
human or an agent.

## Workflow

- **Branch for every change.** Never commit to `main` directly; the pre-commit hook refuses. Name branches
  `feat/…`, `fix/…`, `chore/…`, `eval/…`. Work reaches `main` by a reviewed merge.
- **Small commits with reasoning.** The commit message says *why*, not just what. No AI attribution in commits,
  PRs or authorship.
- **CI must pass before a commit.** The pre-commit hook runs `npm run ci`; GitHub Actions runs the same on pushes
  and pull requests. Don't bypass it with `--no-verify`.
- **Keep `docs/NOTES.md` current.** When you make an assumption, reject or change an AI output, find a failure
  case, or finish a block of work, add a line.

## Quality gates (`npm run ci`)

| Gate | Command | Threshold |
|---|---|---|
| Types | `npm run typecheck` | No errors |
| Tests | `npm test` | All pass |
| Coverage | `npm run test:coverage` | Lines and statements ≥ 85%, functions ≥ 85%, branches ≥ 75% |
| CRAP | `npm run crap` | No function over 30 |

CRAP = complexity² × (1 − coverage)³ + complexity. A function fails if it is too complex, under-tested or both. Fix
it by splitting the function or adding tests. Don't raise the threshold or add ignore comments to pass.

## Code

- **Everything is tested.** New behaviour arrives with a test. A bug fix arrives with a test that failed before it.
- **Small, readable functions.** One job each; aim for under ~25 lines and complexity under 10. Prefer a data table
  over a long `if` chain. Name things for what they mean in the domain (`regulatedFacts`, not `data2`).
- **Pure core, thin shell.** Keep I/O (files, network, `process.argv`) in a small entry point; put logic in pure
  functions that tests can call directly. Pass dependencies such as the LLM client in, rather than importing them
  deep inside logic.
- **Validate at the edges.** Parse every external input (feed, documents, LLM output, HTTP request) with zod.
- **Deterministic by default.** All randomness is seeded (`src/lib/random.ts`). Generated data is reproducible from
  its seed and recorded in a manifest.
- **Match the surrounding code.** Same naming, comment density and idioms. Comments explain *why*.
- TypeScript runs natively on Node (type stripping): import local files with their `.ts` extension, and use only
  erasable syntax (no enums, namespaces or parameter properties).

## AI and data rules

- **No LLM on the request path.** Enrichment and embeddings run offline per catalogue version. The service serves
  precomputed results and must work with no API key.
- **The LLM never writes regulated or operator-owned facts.** RTP, max win, stakes, volatility and hit frequency
  are only *extracted*, with a verbatim quote that code checks, and never inferred. Brands, jurisdictions and status
  come only from the feed. See the trust tiers in `src/catalogue/schema.ts`.
- **Every LLM call goes through `src/lib/llm.ts`** and returns zod-validated structured output.
- **Every LLM call site has an automated way to know it works**, and the check runs without a human:
  1. **Contract checks in code** on every response (schema, ids, allowed values, quotes really present).
  2. **An eval** under `evals/` against reference data (ground truth or labelled cases) with a pass threshold. If
     there is no reference data, use an **LLM-as-judge** with a written rubric, and calibrate the judge on a few
     hand-labelled examples before trusting it.
  3. **A release gate**: the thresholds a new prompt or model must meet, written down next to the eval.

  A new LLM call without all three isn't done.
- **Evals are not tests.** Tests check software behaviour deterministically and run in CI with no network. Evals
  measure AI quality, may cost money, and run on demand (`npm run eval:*`). Never present coverage as AI quality.
- **Secrets live in `.env`** (git-ignored). Never print, log or commit a key. `.env.example` lists what's needed.
- **Keep paid usage minimal.** Cache LLM results by content hash; check one batch before running many; record model
  and cost in the manifest.

## Layout

```
src/catalogue/   schema and catalogue logic
src/lib/         shared utilities (LLM client, seeded RNG)
scripts/         offline pipelines (catalogue generation; later enrichment and indexing)
scripts/quality/ CI tooling (CRAP report)
data/catalogue/  generated catalogue; *truth* files are eval-only reference data
evals/           AI evaluations and their release gates
docs/            notes, ADR
.claude/skills/  agent skills used in this repo (messy-docs)
.githooks/       git hooks (installed by `npm install`)
```
