// Token Radar, model radar-3: an OLS fit on the snapshot's own live-token market.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds the
// strongest pre-token protocols outside it, by TVL, until the board holds 198 rows. A protocol is
// pre-token when its index entry records no token (no market cap, no CoinGecko id, no symbol); the
// snapshot's live-token protocols are the calibration set and are set aside from the ranking, shown
// with the market's own values, never mixed into the ranked board.
//
// Implied value is fitted at run time from the snapshot, never hard-coded:
//
//   growth_clipped = clamp(change_7d, -40, +30) / 100        (null -> 0)
//   log(mcap) ~ intercept + slope * log(TVL) + growth_coef * growth_clipped     (OLS, 128 live tokens)
//   growth_coef_damped = 0.5 * growth_coef                  (the fitted growth sign is reversed:
//                                                            fast-growing TVL is hot money, not value)
//   offset[category] = n / (n + 10) * mean residual log per category
//   log(implied) = intercept + slope * log(TVL) + growth_coef_damped * growth_clipped + offset[category]
//   implied = max(1, round(exp(log(implied))))
//
// No protocol name is ever special-cased: the same fitted function scores every row. Maturity
// (listed_at) and chain count are not in the formula; age is shown only as context, and the chain
// count only shapes the farm plan's costs.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The radar-3 fit, computed from the snapshot at run time. */
export interface Radar3Fit {
  intercept: number;
  slope: number;
  growth_coef: number;
  growth_coef_damped: number;
  growth_clip_low: number;
  growth_clip_high: number;
  damping: number;
  shrinkage: number;
  n_calibration: number;
  offsets: Record<string, number>;
  cv: { n: number; median_abs_error: number; spearman: number; within_2x: number };
  verdict_t1: number;
  verdict_t2: number;
}

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-3';

/** How many pre-token protocols outside the watchlist the board carries, by TVL. */
export const EARLY_ROWS = 158;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  verdict: 'farm' | 'thin' | 'skip';
  model: {
    intercept: number;
    slope: number;
    growth_clipped: number;
    growth_coef_damped: number;
    category_offset: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with the farm plan generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_clipped: number;
  category_offset: number;
  verdict: 'farm' | 'thin' | 'skip';
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  fit: Radar3Fit;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const GROWTH_LOW = -40;
const GROWTH_HIGH = 30;
const DAMPING = 0.5;
const SHRINKAGE = 10;

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The clipped 7-day growth as a fraction: clamp(change_7d, -40, +30) / 100; null -> 0. */
export function growthClipped(p: SnapshotProtocol): number {
  return Math.min(GROWTH_HIGH, Math.max(GROWTH_LOW, finite(p.change_7d, 0))) / 100;
}

/** Solve a small dense linear system by Gauss-Jordan with partial pivoting. */
function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    [m[c], m[piv]] = [m[piv]!, m[c]!];
    const d = m[c]![c]!;
    if (d === 0) throw new SnapshotError('OLS fit is singular: the calibration set cannot identify the model');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / d;
      for (let j = c; j <= n; j++) m[r]![j]! -= f * m[c]![j]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** OLS of y on [1, x1, x2] by the normal equations. Returns [intercept, slope, growth_coef]. */
function ols3(rows: SnapshotProtocol[]): [number, number, number] {
  const xtx = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const xty = [0, 0, 0];
  for (const p of rows) {
    const x = [1, Math.log(p.tvl_usd), growthClipped(p)];
    const y = Math.log(p.mcap_usd!);
    for (let a = 0; a < 3; a++) {
      xty[a]! += x[a]! * y;
      for (let b = 0; b < 3; b++) xtx[a]![b]! += x[a]! * x[b]!;
    }
  }
  const beta = solveLinear(xtx, xty);
  return [beta[0]!, beta[1]!, beta[2]!];
}

/** Category offsets from residuals against a prediction without offsets, shrunk n/(n+10). */
function categoryOffsets(rows: SnapshotProtocol[], intercept: number, slope: number, growthDamped: number): Record<string, number> {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const p of rows) {
    if (p.category === null) continue;
    const pred = intercept + slope * Math.log(p.tvl_usd) + growthDamped * growthClipped(p);
    const r = Math.log(p.mcap_usd!) - pred;
    const cur = sums.get(p.category) ?? { sum: 0, n: 0 };
    cur.sum += r;
    cur.n += 1;
    sums.set(p.category, cur);
  }
  const out: Record<string, number> = {};
  for (const [cat, { sum, n }] of sums) out[cat] = (n / (n + SHRINKAGE)) * (sum / n);
  return out;
}

/** log(implied) for one protocol under a fit; the offset defaults to 0 for unknown categories. */
export function logImplied(p: SnapshotProtocol, intercept: number, slope: number, growthDamped: number, offsets: Record<string, number>): number {
  const off = p.category !== null ? (offsets[p.category] ?? 0) : 0;
  return intercept + slope * Math.log(p.tvl_usd) + growthDamped * growthClipped(p) + off;
}

/** The implied value of one protocol under a fit, at least $1. */
export function impliedValue(p: SnapshotProtocol, intercept: number, slope: number, growthDamped: number, offsets: Record<string, number>): number {
  return Math.max(1, Math.round(Math.exp(logImplied(p, intercept, slope, growthDamped, offsets))));
}

/** Ranks with averaged ties, for Spearman. */
function ranks(values: number[]): number[] {
  const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && values[order[j + 1]!] === values[order[i]!]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k]!] = avg;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation of two equal-length arrays. */
export function spearman(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  const ra = ranks(a);
  const rb = ranks(b);
  const ma = ra.reduce((x, y) => x + y, 0) / n;
  const mb = rb.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

/** The median of a non-empty array of numbers. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * 5-fold cross-validation of the radar-3 fit on the calibration set: fold = index % 5, so the split
 * is deterministic. Each fold is fitted on the other four (OLS + offsets) and scored out-of-fold.
 */
export function crossValidate(calibration: SnapshotProtocol[]): { n: number; median_abs_error: number; spearman: number; within_2x: number } {
  const errors: number[] = [];
  const actual: number[] = [];
  const predicted: number[] = [];
  for (let f = 0; f < 5; f++) {
    const train = calibration.filter((_, i) => i % 5 !== f);
    const test = calibration.filter((_, i) => i % 5 === f);
    const [intercept, slope, growth] = ols3(train);
    const damped = DAMPING * growth;
    const offsets = categoryOffsets(train, intercept, slope, damped);
    for (const p of test) {
      const pred = impliedValue(p, intercept, slope, damped, offsets);
      errors.push(Math.abs(pred - p.mcap_usd!) / p.mcap_usd!);
      actual.push(p.mcap_usd!);
      predicted.push(pred);
    }
  }
  let within = 0;
  for (let i = 0; i < actual.length; i++) {
    const ratio = predicted[i]! / actual[i]!;
    if (ratio >= 0.5 && ratio <= 2) within++;
  }
  return {
    n: calibration.length,
    median_abs_error: median(errors),
    spearman: spearman(actual, predicted),
    within_2x: within / actual.length,
  };
}

/** The live-token calibration set: a token that trades, with a positive market cap and TVL. */
export function calibrationSet(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => p.gecko_id !== null && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

/** Fit radar-3 on the snapshot: OLS, damped growth, shrunk category offsets, 5-fold CV. */
export function fitRadar3(snapshot: Snapshot): Omit<Radar3Fit, 'verdict_t1' | 'verdict_t2'> {
  const calibration = calibrationSet(snapshot);
  if (calibration.length < 10) throw new SnapshotError(`only ${calibration.length} live-token protocols can calibrate the model`);
  const [intercept, slope, growth] = ols3(calibration);
  const damped = DAMPING * growth;
  const offsets = categoryOffsets(calibration, intercept, slope, damped);
  const cv = crossValidate(calibration);
  return {
    intercept,
    slope,
    growth_coef: growth,
    growth_coef_damped: damped,
    growth_clip_low: GROWTH_LOW,
    growth_clip_high: GROWTH_HIGH,
    damping: DAMPING,
    shrinkage: SHRINKAGE,
    n_calibration: calibration.length,
    offsets,
    cv,
  };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * The categories the watchlist itself leaves out: a bridge, a canonical bridge, a liquid
 * staking or restaking product, or an exchange is a wrapped, staked or bridged product of a token
 * that already trades, not a protocol still waiting on a launch of its own. The board uses the
 * watchlist's own rule for its early rows too. Cross Chain Bridge is not in this set: it stays.
 */
const RANK_EXCLUDED_CATEGORIES = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

/** Whether a protocol is one the board may rank: pre-token, not an exchange, bridge or staked product, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && (p.category === null || !RANK_EXCLUDED_CATEGORIES.has(p.category)) && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** Rough gas for one transaction on a chain, in USD, from the chain's usual fee level. */
function gasUsd(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 5;
  if (c === 'solana') return 0.05;
  if (c === 'bsc' || c === 'binance') return 0.2;
  if (c === 'base' || c === 'arbitrum' || c === 'optimism' || c === 'polygon' || c === 'blast' || c === 'linea' || c === 'scroll' || c === 'zksync era' || c === 'mode') return 0.5;
  if (c === 'avalanche' || c === 'fantom' || c === 'gnosis' || c === 'celo') return 0.3;
  if (c === 'tron' || c === 'sui' || c === 'aptos' || c === 'ton' || c === 'near') return 0.1;
  return 1.5;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * One mechanism per category: what the farmer actually does, and what the weekly qualifying action
 * is. The mechanism follows the category, the numbers follow the protocol; no name is special-cased.
 */
interface Mechanism {
  primary: (name: string, capital: number, chain: string) => string;
  weekly: (name: string, chain: string) => string;
}

function mechanismFor(p: SnapshotProtocol): Mechanism {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('dex') || c.includes('liquidity manager')) {
    return {
      primary: (n, k, ch) => `Provide $${k} of liquidity to ${n}'s main pool on ${ch} in a balanced pair and keep the position open.`,
      weekly: (n) => `Swap a small amount through ${n} once a week so the wallet shows repeated trading activity.`,
    };
  }
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return {
      primary: (n, k, ch) => `Supply $${k} of USDC to ${n} on ${ch} as collateral and borrow no more than a third of it.`,
      weekly: (n) => `Repay a little of the borrow on ${n} and re-supply it, so the wallet shows live borrowing activity.`,
    };
  }
  if (c.includes('restak') || c.includes('liquid staking') || c.includes('staking pool') || c.includes('staking')) {
    return {
      primary: (n, k, ch) => `Stake $${k} of the chain's staking asset through ${n} on ${ch} and keep the receipt token in the wallet.`,
      weekly: (n) => `Restake the staking rewards ${n} pays out instead of selling them, so the stake compounds.`,
    };
  }
  if (c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) {
    return {
      primary: (n, k, ch) => `Deposit $${k} of USDC into ${n}'s highest-TVL vault on ${ch} and keep the vault shares.`,
      weekly: (n) => `Claim the vault yield on ${n} once a week and redeposit it instead of withdrawing.`,
    };
  }
  if (c.includes('bridge')) {
    return {
      primary: (n, k, ch) => `Bridge $${k} of USDC to ${ch} through ${n} and put the bridged funds to work in the destination app.`,
      weekly: (n) => `Bridge a small amount through ${n} once a week, alternating direction when the route allows it.`,
    };
  }
  if (c.includes('derivative') || c.includes('basis trading') || c.includes('options vault') || c.includes('perpetual')) {
    return {
      primary: (n, k, ch) => `Deposit $${k} of USDC as margin on ${n} on ${ch} and open one small hedge, not a leveraged bet.`,
      weekly: (n) => `Rebalance the hedge on ${n} once a week so the position stays near delta-neutral.`,
    };
  }
  if (c.includes('rwa')) {
    return {
      primary: (n, k, ch) => `Mint $${k} of the yield-bearing real-world asset ${n} issues on ${ch} and hold it.`,
      weekly: (n) => `Claim the yield ${n} pays on the asset once a week and hold it in the same wallet.`,
    };
  }
  if (c.includes('risk curator') || c.includes('capital allocator') || c.includes('allocator')) {
    return {
      primary: (n, k, ch) => `Deposit $${k} into a ${n} vault on ${ch} and keep the shares while the curator allocates.`,
      weekly: (n) => `Check ${n}'s vault allocation once a week and move a small amount to the vault it just opened.`,
    };
  }
  if (c.includes('stable')) {
    return {
      primary: (n, k, ch) => `Mint or deposit $${k} of the stable asset through ${n} on ${ch} and hold it in the wallet.`,
      weekly: (n) => `Swap a small amount in and out of ${n}'s stable asset once a week to show repeated use.`,
    };
  }
  if (c.includes('prediction')) {
    return {
      primary: (n, k, ch) => `Fund $${k} and place one market position on ${n} on ${ch}, sized so a loss is affordable.`,
      weekly: (n) => `Place one new market position on ${n} each week and settle the old ones as they resolve.`,
    };
  }
  if (c.includes('insurance')) {
    return {
      primary: (n, k, ch) => `Buy $${k} of cover from ${n} on ${ch} and keep the policy active in the wallet.`,
      weekly: (n) => `Check the policy on ${n} once a week and top it up if the covered amount falls.`,
    };
  }
  if (c.includes('payment') || c.includes('card')) {
    return {
      primary: (n, k, ch) => `Load $${k} onto ${n} on ${ch} and pay one real bill or purchase with it.`,
      weekly: (n) => `Make one real payment through ${n} each week instead of a single test transaction.`,
    };
  }
  if (c.includes('privacy')) {
    return {
      primary: (n, k, ch) => `Deposit $${k} through ${n}'s shielded pool on ${ch} and keep the shielded balance.`,
      weekly: (n) => `Make one small shielded transfer through ${n} each week.`,
    };
  }
  if (c.includes('index')) {
    return {
      primary: (n, k, ch) => `Buy $${k} of ${n}'s index token on ${ch} and hold it.`,
      weekly: (n) => `Check ${n}'s index rebalance once a week and add a small amount after it.`,
    };
  }
  if (c.includes('chain')) {
    return {
      primary: (n, k, ch) => `Bridge $${k} to ${ch} and stake a part of it in ${n}'s native app, keeping the rest liquid.`,
      weekly: (n) => `Use one native app on the chain ${n} runs once a week, such as a swap or a vote.`,
    };
  }
  if (c.includes('governance')) {
    return {
      primary: (n, k, ch) => `Deposit $${k} into ${n} on ${ch} and vote on its first open proposal.`,
      weekly: (n) => `Vote on every new ${n} proposal each week so the wallet shows steady governance activity.`,
    };
  }
  if (c.includes('otc')) {
    return {
      primary: (n, k, ch) => `Place one $${k} order on ${n} on ${ch} at a price near the market, not far from it.`,
      weekly: (n) => `Place one small order on ${n} each week and let it fill rather than cancelling it.`,
    };
  }
  return {
    primary: (n, k, ch) => `Deposit $${k} of USDC into ${n} on ${ch} and keep the position open.`,
    weekly: (n) => `Make one qualifying action on ${n} each week, such as a deposit, a swap or a vote.`,
  };
}

/** The verdict, from the model's own numbers: terciles of the board's implied values, hot money out. */
export function verdictFor(implied: number, growthClippedValue: number, t1: number, t2: number): 'farm' | 'thin' | 'skip' {
  if (growthClippedValue >= 0.3) return 'skip';
  if (implied >= t2) return 'farm';
  if (implied >= t1) return 'thin';
  return 'skip';
}

/** Why this protocol got its verdict, in the model's own numbers. */
function verdictReason(p: SnapshotProtocol, implied: number, verdict: 'farm' | 'thin' | 'skip', growthClippedValue: number, offset: number, t1: number, t2: number): string {
  const money = `$${Math.round(implied / 1e6)}M`;
  if (growthClippedValue >= 0.3) {
    return `Verdict: SKIP. Implied value is ${money}, but 7-day TVL growth is clipped at +30%: hot money is rushing in, so farming now chases a crowd that may leave before any token.`;
  }
  if (verdict === 'farm') {
    return `Verdict: FARM. Implied value ${money} is above the board's upper tercile ($${Math.round(t2 / 1e6)}M), growth is not hot, and the category offset is ${offset >= 0 ? '+' : ''}${offset.toFixed(2)} log points: this is the size the market usually pays for.`;
  }
  if (verdict === 'thin') {
    return `Verdict: THIN. Implied value ${money} sits between the board's terciles ($${Math.round(t1 / 1e6)}M to $${Math.round(t2 / 1e6)}M): worth a small position, not a large one, and only if the weekly actions are cheap.`;
  }
  return `Verdict: SKIP. Implied value ${money} is below the board's lower tercile ($${Math.round(t1 / 1e6)}M): the market would pay little for a token this size, so the farm's gas and time cost more than the expected airdrop.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age) and the model's verdict, never from a
 * hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, implied: number, verdict: 'farm' | 'thin' | 'skip', growthClippedValue: number, offset: number, t1: number, t2: number): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const gas = gasUsd(chain);
  const hold = holdDaysFor(age);
  const mech = mechanismFor(p);
  const secondChain = p.chains.length > 1 ? ` Repeat the same deposit on ${p.chains[1]} if the protocol runs there, since a second chain doubles the footprint for about $${gas} more gas.` : '';
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: `under $${Math.max(1, gas).toFixed(2)} of gas for the first transaction`,
      time: '5 minutes',
    },
    {
      text: mech.primary(p.name, capital, chain),
      cost: `$${capital} of capital and about $${gas.toFixed(2)} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `${mech.weekly(p.name, chain)}${secondChain}`,
      cost: `about $${gas.toFixed(2)} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: verdictReason(p, implied, verdict, growthClippedValue, offset, t1, t2),
      cost: 'no fee to read the verdict, it follows from the model',
      time: '2 minutes',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, fit: Radar3Fit): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but
  // the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: the pre-token protocols outside the watchlist with the most TVL, capped. Never
  // a replacement for a watchlist row: a chosen protocol stays chosen. No floor filter here: a
  // pre-token protocol above the floor that the watchlist leaves out (for example one with a parent
  // protocol) is still a protocol with no token, and the radar exists to find it.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const implied = impliedValue(p, fit.intercept, fit.slope, fit.growth_coef_damped, fit.offsets);
    return { p, implied, growth: growthClipped(p), offset: p.category !== null ? (fit.offsets[p.category] ?? 0) : 0, age: ageDays(snapshot.as_of, p.listed_at) };
  });
  // Verdict terciles come from the board's own implied values, not from a hard-coded dollar line.
  const sortedImplied = scored.map((s) => s.implied).sort((a, b) => a - b);
  const t1 = sortedImplied[Math.floor(sortedImplied.length / 3)]!;
  const t2 = sortedImplied[Math.floor((2 * sortedImplied.length) / 3)]!;
  fit.verdict_t1 = t1;
  fit.verdict_t2 = t2;

  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => {
    const verdict = verdictFor(s.implied, s.growth, t1, t2);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      age_days: s.age,
      implied_value_usd: s.implied,
      verdict,
      model: {
        intercept: round4(fit.intercept),
        slope: round4(fit.slope),
        // Full precision here, not rounded: the dashboard recomputes the row from these two
        // numbers and must land on exactly the implied value board.json carries.
        growth_clipped: s.growth,
        growth_coef_damped: round4(fit.growth_coef_damped),
        category_offset: s.offset,
        age_days: s.age,
      },
      farm_steps: farmSteps(s.p, s.age, s.implied, verdict, s.growth, s.offset, t1, t2).map(stepText),
    };
  });
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_clipped: row.model.growth_clipped,
    category_offset: row.model.category_offset,
    verdict: row.verdict,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const fit = fitRadar3(snapshot) as Radar3Fit;
  const board = buildBoard(snapshot, fit);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    fit,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
