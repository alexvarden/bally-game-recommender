# Game features for semantic matching

Key: **[S]** from the source feed · **[E]** extracted or derived by the LLM · **[F]** used as a filter or guardrail, never embedded

## Identity
- SKU / internal ID, supplier game code [S]
- Game name [S]
- Studio / supplier, plus in-house vs aggregator [S]
- Game family: base game and its versions (Deluxe, Megaways, jackpot versions) [S/E]. Stops a game recommending its own versions.

## Content: what the game is about
- Description, cleaned and normalised from supplier copy [S → E]
- Primary theme from a fixed list (Egyptian, Irish luck, Norse, fruit/classic, fishing, animals, gems, horror, Asian fortune, Wild West, TV/gameshow…) [E]
- Sub-themes / motifs: free tags such as "pyramids", "rainbows", "Vikings" [E]
- Tone / mood: cosy, epic, spooky, retro, glamorous, comedic [E]
- Art style: cartoon, realistic 3D, retro pixel, classic fruit-machine [E]
- Licensed IP / brand tie-in: Monopoly, Deal or No Deal, Rainbow Riches [S]
- Setting or narrative hook: "explorer raids a tomb", "a fisherman reels in cash fish" [E]

## Gameplay: how it plays
- Format: video slot, classic slot, Slingo, bingo, live dealer, table, scratch/instant, crash, game show [S]. Hybrids such as Slingo matter for Bally's.
- Reel and payout structure: grid size, paylines / ways / Megaways / cluster pays [S/E]
- Core mechanic, the game's defining trait: hold & win, cascades, expanding wilds, sticky wilds, multipliers, collect/cash-on-reels, pick-me bonus, wheel bonus [E]
- Secondary features: free spins, retriggers, mystery symbols, respins [E]
- Bonus style: frequent small features vs a rare big feature [E]
- Jackpot type: none, fixed, local progressive, network progressive [S]
- Complexity: simple, moderate, feature-heavy, as a proxy for player sophistication [E]

## Experience: what playing it feels like
These are the creative part: fields that suppliers don't provide but players notice.
- Pace: relaxed, steady, frenetic [E]
- Excitement curve: steady trickle, slow build, or bursty chase [E]
- Social / shared element: shared bingo room, live host, community jackpot [E]
- Nostalgia factor: pub fruit-machine feel, land-based conversion [E]
- "Plays like" references to other catalogue games [E]. A seed signal for evaluation.

## Maths profile: structured, not embedded
- Volatility (low / medium / high / very high) [S, normalised by E]
- RTP [S] **never inferred**
- Max win multiplier [S] **never inferred**
- Min / max stake [S]
- Hit frequency [S, often missing]

## Guardrails: filters only
- Brands available on [F]
- Jurisdictions / licence [F]
- Status: live, coming soon, suspended, retired [F]
- Release date: lets fresh content be favoured or penalised [S]
- Responsible-gambling flags: could appeal to under-18s, "do not promote" [F/E]
- Volatility step-up limit: don't push a low-volatility player towards a very-high-volatility game [F]

## Deliberately excluded from matching
- Game revenue (GGR), average stake, revenue per player. Ranking by commercial value conflicts with UK consumer-protection expectations.
