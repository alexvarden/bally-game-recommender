# Release gates

A prompt, model, enrichment or ranking change ships only if every **block** gate passes on `npm run eval`. A failing
**warn** gate needs a written justification in the PR. Thresholds live in code in `evals/gates.ts`; keep the two in
step.

The two AI stages are judged differently because they fail differently. Enrichment is extraction against a known
truth, so it is scored field by field. Matching is a ranking with no single right answer, so it is scored against
graded relevance labels, and its safety rules are checked as hard constraints.

## Enrichment (LLM extraction)

Scored against `data/catalogue/ground-truth.json` and `documents.truth.json`, which records which facts survived in
each document after rendering and damage.

| Gate | Level | Threshold | Why |
|---|---|---|---|
| Regulated facts wrong, unevidenced or invented | block | 0 | RTP, max win, stakes, volatility and hit frequency are shown to players on a regulated site. A wrong value, a value with no verified quote, or a value no source states is a compliance incident, not a quality dip. |
| Quote rejection rate | warn | ≤ 5% | The share of the model's evidence quotes that code couldn't verify. A rise means the model is paraphrasing or inventing quotes: an early warning before it reaches the fields. |
| Accuracy on available facts | warn | ≥ 80% | Only facts some source really states count (feed or a full document section). Truncated sections are excluded. Inferable fields (mood, pace, theme…) are scored everywhere because inference is allowed. |
| Abstention where no source states the fact | warn | ≥ 90% | For regulated and structural fields, `null` is the right answer when nothing states the fact. |
| Worst planted-defect recall | warn | ≥ 66% | Volatility conflicts flagged; another game's rules treated as suspect (and not used as evidence); RG flags suggested for under-18-appeal games; duplicate listings not kept as separate live games. |

## Matching (semantic similarity)

Every (brand, live game) pair is a request; the top 5 are scored.

| Gate | Level | Threshold | Why |
|---|---|---|---|
| Hard violations | block | 0 | A recommended game that isn't live on the brand, is quarantined, is the seed itself, is a duplicate listing, or is more than one volatility level above the seed. Checked against the ground truth, because the harm is real whatever the pipeline believed. |
| Hand-label must-not hits | warn | 0 | Games a human judged wrong for that seed, for reasons the hard rules don't capture. |
| nDCG@5, silver labels | warn | ≥ 0.60 | Graded relevance from ground-truth attributes over every request. Complete but circular: it rewards the attributes the ranker matches on. |
| nDCG@5, hand labels | warn | ≥ 0.50 | Ten seeds labelled by judgement. Small but independent of the ranking features. |
| Fallback rate | warn | ≤ 20% | How often the player sees the brand fallback list instead of related games. |

Also reported, not gated: precision@5, the share of the top 5 that are the seed's own family (no family rule was
chosen, so we watch it), and a comparison against random, metadata-only and oracle rankers. A new ranker must beat the
metadata baseline on hand-label nDCG to justify itself.

## What CI checks

CI scores the committed outputs offline and checks that the harness computes these gates correctly. Re-running the
LLM is on demand, because it costs money and isn't deterministic.
