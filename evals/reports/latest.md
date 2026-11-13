# Evaluation report

Matching rankers run over the **ideal calibration enrichment**. Hand labels: 10 seeds. Gates: see `evals/GATES.md`.

## Enrichment

> **No pipeline output yet** (`data/enriched/games.json` is missing). Only calibration rows are shown; gates below are for the ideal calibration output.

| Output | Games | Regulated violations | Accuracy | Abstention | Quote rejection | Vol. conflict | Wrong rules | RG suggest | Duplicates |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ideal _(calibration)_ | 100 | 0 | 100.0% | 100.0% | 0.2% | 4/4 | 3/3 | 2/2 | 2/2 |
| corrupted _(calibration)_ | 100 | 14 | 96.9% | 97.4% | 0.0% | 0/4 | 0/3 | 1/2 | 2/2 |

### Per field (ideal calibration output)

| Field | Scored | Accuracy | Missed | No source | Abstained |
| --- | --- | --- | --- | --- | --- |
| volatility | 80 | 100.0% | 0 | 19 | 100.0% |
| rtp | 88 | 100.0% | 0 | 12 | 100.0% |
| maxWinMultiplier | 81 | 100.0% | 0 | 19 | 100.0% |
| minStake | 85 | 100.0% | 0 | 15 | 100.0% |
| maxStake | 85 | 100.0% | 0 | 15 | 100.0% |
| hitFrequency | 31 | 100.0% | 0 | 68 | 100.0% |
| format | 87 | 100.0% | 0 | 13 | 100.0% |
| payStructure | 61 | 100.0% | 0 | 39 | 100.0% |
| grid | 64 | 100.0% | 0 | 36 | 100.0% |
| paylines | 55 | 100.0% | 0 | 45 | 100.0% |
| jackpotType | 68 | 100.0% | 0 | 32 | 100.0% |
| primaryTheme | 100 | 100.0% | 0 | 0 | – |
| mood | 100 | 100.0% | 0 | 0 | – |
| artStyle | 100 | 100.0% | 0 | 0 | – |
| coreMechanic | 100 | 100.0% | 0 | 0 | – |
| secondaryFeatures | 100 | 100.0% | 0 | 0 | – |
| bonusStyle | 100 | 100.0% | 0 | 0 | – |
| complexity | 100 | 100.0% | 0 | 0 | – |
| pace | 100 | 100.0% | 0 | 0 | – |
| excitementCurve | 100 | 100.0% | 0 | 0 | – |
| socialElement | 100 | 100.0% | 0 | 0 | – |
| nostalgia | 100 | 100.0% | 0 | 0 | – |

### Gates

|  | Level | Gate | Value | Threshold |
| --- | --- | --- | --- | --- |
| ✅ | block | Regulated facts wrong, unevidenced or invented | 0 | <= 0 |
| ✅ | warn | Quote rejection rate | 0.002 | <= 0.05 |
| ✅ | warn | Accuracy on available facts | 1 | >= 0.8 |
| ✅ | warn | Abstention where no source states the fact | 1 | >= 0.9 |
| ✅ | warn | Worst planted-defect recall | 1 | >= 0.66 |

**Releasable**: every blocking gate passes.

## Matching

| Ranker | Requests | Hard violations | nDCG@5 silver | P@5 silver | nDCG@5 hand | P@5 hand | Must-not hits | Family share | Fallback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| metadata (enriched attributes) **(candidate)** | 245 | 0 | 0.676 | 51.3% | 0.440 | 17.9% | 0 | 8.5% | 22.4% |
| random, filtered | 245 | 0 | 0.170 | 9.7% | 0.124 | 4.3% | 0 | 1.0% | 22.4% |
| random, unfiltered _(calibration)_ | 245 | 688 | 0.233 | 11.4% | 0.094 | 3.6% | 1 | 0.7% | 0.0% |
| silver oracle (answer key) _(calibration)_ | 245 | 0 | 1 | 74.5% | 0.817 | 32.9% | 0 | 8.4% | 1.6% |

### Gates (metadata (enriched attributes))

|  | Level | Gate | Value | Threshold |
| --- | --- | --- | --- | --- |
| ✅ | block | Hard violations (wrong brand, not live, quarantined, seed, duplicate, volatility step-up) | 0 | <= 0 |
| ✅ | warn | Hand-label must-not hits | 0 | <= 0 |
| ✅ | warn | nDCG@5, silver labels | 0.676 | >= 0.6 |
| ⚠️ | warn | nDCG@5, hand labels | 0.440 | >= 0.5 |
| ⚠️ | warn | Fallback rate | 0.224 | <= 0.2 |

**Releasable**: every blocking gate passes.

## Where it goes wrong

### Enrichment

_No pipeline output to inspect yet._

### Matching (metadata (enriched attributes))

- jackpotjoy: **Ruby Reel Picnic** nDCG 0: got nothing (below_floor)
- virgin_games: **Cloverfall Cluster** nDCG 0: got Sugarbell Selection, Fortune Lanterns of Lianhua, Hollowmere Afterdark, Neon Encore, Prize Pod Parade
- virgin_games: **Ruby Reel Picnic** nDCG 0: got nothing (below_floor)

### Design tension

- 20 games have no known volatility. The guardrail can't check a step-up it can't measure, so it excludes them; seeds with unknown volatility get no recommendations and fall back. Correct abstention in enrichment therefore costs coverage in matching.
