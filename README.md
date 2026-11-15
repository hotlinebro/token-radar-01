# Token Radar — radar-3

A token launch radar for pre-token protocols, built for the make.fun
`token-radar-01` competition. It reads one frozen snapshot of the DefiLlama
protocol index, fits a value model on the live-token market inside that
snapshot, and ranks every pre-token protocol by the implied value of a token
it has not launched yet.

## What it does

- **Coverage.** All 40 watchlist protocols (TVL at or above the $50M floor,
  no token on record), plus the 158 strongest pre-token protocols outside the
  watchlist by TVL — 198 rows in total. Live-token protocols are set aside
  with their market caps shown, never mixed into the ranking.
- **Model (radar-3).** An OLS regression fitted at run time on the snapshot's
  own live-token market (128 protocols with a positive market cap and TVL):

  `log(implied) = intercept + slope x log(TVL) + growth_coef_damped x growth_clipped + offset[category]`

  where `growth_clipped = clamp(change_7d, -40%, +30%) / 100`,
  `growth_coef_damped = 0.5 x growth_coef`, and each category offset is
  `n / (n + 10)` of its mean residual log. No coefficient is hard-coded: the
  fit is recomputed from the snapshot on every run. On this snapshot the fit
  is intercept 6.500, slope 0.529, growth coefficient -3.719 (damped -1.859).
- **Why it looks like that.** The slope is sublinear (0.529): a protocol ten
  times larger is worth about 3.4 times as much, not ten times. The growth
  coefficient is negative: TVL that arrives in a week is usually hot money,
  so the model damps it by half instead of trusting it. Growth is clipped so
  one wild week cannot move a row by itself, and category offsets are shrunk
  so a category with one live protocol barely moves the board.
- **Validation.** 5-fold cross-validation on the same 128 live tokens:
  median |error| 84.8%, Spearman 0.384, 33.6% of predictions within 2x of the
  true market cap. The model ranks roughly; it does not price precisely.
  Those numbers are computed at run time and shown on the dashboard.
- **Verdict.** Each row gets FARM, THIN or SKIP from the model's own numbers:
  the board's implied-value terciles decide farm vs thin vs skip, and any
  protocol whose growth is clipped at +30% (hot money) is a skip.
- **Farm plan.** Every row carries a 7-step plan whose mechanism follows the
  protocol's category (liquidity, lending, staking, vaults, bridges, margin,
  RWA, curators and the rest), with capital sized by TVL, gas priced by
  chain, a hold period sized by age, and the verdict with its reason.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Node 22, standard library only, no install. The run writes `out/board.json`
(the ranked board), `out/data.js` (the dashboard's dataset), `out/dashboard/`
(the static page, no network) and `out/dossier.json` (the judge's summary).

## Files

- `main.ts` — reads the snapshot, builds the board, writes the outputs.
- `lib/model.ts` — the radar-3 fit, the board, the farm plans, the validation.
- `dashboard/` — the static page: `index.html`, `app.css`, `app.js`.
- `vendor/makefun-board.ts` — make.fun's dossier library, byte for byte as
  shipped in the kit.
- `screenshots/` — the board, a detail view and a filtered view of the page.

## Honest limits

The model cannot see a points program, a team, a fundraise or a token
design, and it treats a protocol that will never launch a token exactly like
one that will. A FARM verdict means "large for this board", not "certain to
airdrop". Use the board as a shortlist to research, not a buy list.
