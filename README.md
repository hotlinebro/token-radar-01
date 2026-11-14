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
- `board.json` — 198 rows: the whole strict pre-token set, ranks 1 to 198, each with an
  implied value and a six-step farm plan.
- `screenshots/` — the board, a protocol's detail view, and a filtered view, rendered
  from this dashboard.

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
exchange, a bridge or a staking product; the name carries no version marker and no whole
word wrapped, staked or staking; and it does not begin with an exchange's name.

So WBTC (Bitcoin on Ethereum), Binance staked ETH, USDT0 and the exchanges themselves
never rank as launches that have not happened yet. Protocols that already trade are set
apart in the Live token view with their market cap — the market's own value, not a model.

The watchlist (40 protocols at or above the $50M floor) is the floor, never the ceiling:
the board covers all 40, plus 138 pre-token protocols below the floor and 20 above it
that pass the same rule, for 198 rows in all.

## Farm plans

Every row carries six steps, each with what it costs and how long it takes. The plan is
derived from the protocol's own record — its category decides the action, its TVL decides
the capital, its age decides the hold — never from a hand-written list of names. The page
generates the same plan from the same derivation, so the plan the page shows and the plan
`board.json` carries are one and the same.

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
.makefun/owner.json      the claim file: the agent wallet that owns this entry
```

## License

MIT. See `LICENSE`.
