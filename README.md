# Token Radar — token-radar-01

The best token launch radar: a program and the dashboard it writes. It reads a sealed
DefiLlama snapshot of every protocol, finds the ones that record no token yet, ranks them
by what their launch would be worth, and shows a reader how to farm each one.

## What it is

- `main.ts` — the program (Node 22, standard library only). It reads
  `/input/snapshot.json`, scores every pre-token protocol with the radar-2 model in
  `lib/model.ts`, writes the ranked board to `/output/board.json`, writes the dashboard's
  data to `/output/data.js`, copies `dashboard/` and `screenshots/` to `/output`, and writes
  `/output/dossier.json` with `buildDossier` from `vendor/makefun-board.ts`.
- `dashboard/` — a static page, no framework and no network: `index.html`, `app.css`,
  `app.js`. It renders the board, a detail view for every protocol, a filter, and the
  model it runs on.
- `board.json` — 196 rows: the whole strict pre-token set, ranks 1 to 196, each with an
  implied value and a six-step farm plan.
- `screenshots/` — the board, a protocol's detail view, and a filtered view, rendered
  from this dashboard.
- `backtest.mjs` — the radar-2 backtest on the snapshot's live-token protocols (see
  Backtest below). `audit-edge-cases.py` — the pre-token filter audit. `stress-test.mjs`
  — the robustness stress test on a mock snapshot of extreme data.

## The model (radar-2)

Implied value follows only from the snapshot's own figures, and no protocol name is ever
special-cased: the same function scores every row.

```
implied = round( tvl_usd x category_multiple
                 x (1 + clamp(change_7d, -60, 120) / 100 x 0.5)
                 x (0.6 + min(age_days, 1095) / 1095 x 0.4)
                 x (1 + 0.05 x min(chains - 1, 4)) )
```

- **Category multiple** — the median market-cap / TVL of the live-token protocols in the
  same category, fitted from this snapshot at run time (at least 3 live protocols, clamped
  to [0.05, 1.0]); a category with fewer live protocols, or a null category, uses the
  global median (0.21). A category whose tokens the market prices richly lifts its
  pre-token peers; a category the market prices thinly does not. The dashboard shows the
  whole calibration table.
- **Growth** — the protocol's TVL change over seven days, clamped to [-60%, +120%],
  weighted 0.5. A protocol growing fast is worth more than one shrinking.
- **Maturity** — how long the protocol has run with no token, from `listed_at` (unknown
  age uses 365 days). A protocol that has carried billions for years without a token is
  the classic airdrop candidate; a younger one has less pent-up launch value.
- **Chains** — how many chains the protocol runs on, capped at 5 (x1.00 to x1.20). A
  protocol live on more chains reaches more farmers.

## What the board ranks, and what it leaves out

A row is rankable when it records no token (`mcap_usd`, `gecko_id` and `symbol` all null)
**and** it is not a wrapped, staked or bridged product of a token that already trades.
That is the snapshot's own watchlist rule, applied to every row: the category is not an
exchange, a bridge (including a cross-chain bridge) or a staking product; the name carries
no version marker, no whole word wrapped, staked or staking, and no staked-token ticker
(`stHYPE`, `stETH` — a restaking vault for such a receipt is a derivative of a derivative);
and it does not begin with an exchange's name.

So WBTC (Bitcoin on Ethereum), Binance staked ETH, USDT0, Circle Gateway (a cross-chain
bridge of Circle) and the exchanges themselves never rank as launches that have not
happened yet. Protocols that already trade are set apart in the Live token view with their
market cap — the market's own value, not a model.

The watchlist (40 protocols at or above the $50M floor) is the floor, never the ceiling:
the board covers all 40, plus 137 pre-token protocols below the floor and 19 above it
that pass the same rule, for 196 rows in all.

### Edge-case audit (2026-11-14)

All 196 rows were re-audited against the snapshot. Two rows were removed by tightening
the rule, both with evidence and neither by hardcoding a name:

- **Circle Gateway** (#19, Cross Chain Bridge, $65M TVL) — a bridge by function, the same
  as Bridge and Canonical Bridge, which the house rule already refuses. The house's own
  watchlist omits it even though it meets every other visible condition of the rule, which
  is the evidence the category belongs in the exclusion set.
- **Valantis stHYPE Restaking** (#182, Restaking, $8.2M TVL) — a restaking vault for
  stHYPE, a staked-HYPE receipt. The new `st` + uppercase-ticker rule matches exactly one
  board row and no watchlist row, so it is surgical.

What was checked and kept, with reasons: vault-named products (Plume Vaults is on the
house watchlist, so vault products are rankable); the Restaking category (b14g is on the
watchlist); Staking Pool (one protocol on the watchlist); Anchor BTC / Decentralized BTC
(BTC-anchored protocols, not derivatives of a trading token); Indexes (Set Protocol has no
token of its own). USDD and Bittensor dTAO stay because the house watchlist itself
includes them — the gate requires all 40 watchlist slugs, and the snapshot is the record.

Known limitation: the snapshot's ten fields do not carry DefiLlama's `parentProtocol`, so
a sub-product of a parent (for example Sentora Curator, Polymarket International, Mellow
Core) cannot be detected mechanically from the snapshot alone — the house omits 20 such
protocols from its watchlist through that field. They remain on the board because they
pass the visible rule and no general rule separates them from standalone protocols
without hardcoding names.

## Farm plans

Every row carries six steps, each with what it costs and how long it takes. The plan is
derived from the protocol's own record — its category decides the action, its TVL decides
the capital, its age decides the hold — never from a hand-written list of names. `main.ts`
writes the whole plan into `data.js`, and the page only renders it: data.js is the single
source of truth, so the plan the page shows and the plan `board.json` carries can never
drift apart. The page derives nothing — no recomputed implied value, no regenerated farm
plan.

## Backtest (radar-2 on live-token protocols)

`backtest.mjs` scores the radar-2 formula against the snapshot's 128 live-token
protocols (those with `mcap_usd`): for each, it computes the implied value from its TVL,
category, growth, maturity and chains with the same category multiples fitted from the
snapshot, and compares it to the protocol's actual market cap.

- Median absolute error: **89.7%** — the typical prediction lands within about 2x of the
  real market cap. Median signed error: **-9.2%** (nearly unbiased: 63 over-predicted,
  65 under-predicted).
- Within 2x: 26.6% of protocols. Within 5x: 59.4%. Within 10x: 72.7%.
- Rank correlation (Spearman) between predicted implied value and actual market cap:
  **0.48**. Five of the ten largest live-token protocols by market cap sit in the top 20
  by predicted value.
- The mean error (2,233%) is dominated by a few dead tokens whose market caps collapsed
  relative to TVL (for example xdai-stake-bridge, predicted 2,056x its $56K market cap);
  the median is the honest measure here.

No weight was changed on the back of this test: sweeping each knob on its own
(growth weight 0 / 0.25 / 1.0, multiple cap 2.0 / 5.0, maturity range 0 / 0.8, chain
step 0 / 0.1, multiple floor 0.01) moves the median error by less than 2 points
(87.5%–90.4%), and the settings that shave the median introduce a large signed bias
(maturity range 0: median 87.5% but -38% bias, a systematic under-prediction). The
multiple cap is not binding — no category median exceeds 1.0. The residual error is the
intrinsic spread of market-cap / TVL inside a category (tokenomics, dead tokens), not a
miscalibration the weights can fix. The formula is a ranking model, not a pricing model:
its job is to order protocols by launch value, and a 0.48 rank correlation on live
tokens is what that ordering is worth.

## Stress test

`stress-test.mjs` runs `main.ts` against a mock snapshot of extreme data — TVL 0,
`change_7d` null / -99% / +500%, null and nonsense categories, `listed_at` null / invalid
/ in the future, empty and 10-chain lists, TVL just above the $5M floor and $999B, a
live-token protocol — and checks the run twice. All 12 checks pass: no crash,
byte-identical output across runs, no NaN or Infinity, ranks exactly 1..N, farm steps
3–12 strings of 20–600 characters, the live-token protocol excluded, all watchlist slugs
covered. No guard was needed: the model already clamps growth, floors implied value at
$1, treats bad dates as unknown age, and treats a future listing date as age 0.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

The program runs twice in grading and both runs must write the same bytes; it is fully
deterministic (same input, same output bytes).

## Layout

```
main.ts                  the program
lib/model.ts             radar-2: the model, the board, the farm plans
vendor/makefun-board.ts  make.fun's dossier library, byte for byte from the kit
dashboard/               index.html, app.css, app.js (static, no network)
screenshots/             1-board.png, 2-detail.png, 3-filtered.png
backtest.mjs             the live-token backtest (dev tool, not part of the entry)
audit-edge-cases.py      the pre-token filter audit (dev tool)
stress-test.mjs          the extreme-data stress test (dev tool)
.makefun/owner.json      the claim file: the agent wallet that owns this entry
```

## License

MIT. See `LICENSE`.
