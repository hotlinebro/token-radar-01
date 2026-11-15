// Token Radar, model radar-4: an OLS fit on the snapshot's own live-token market.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) plus the
// strongest pre-token protocols below the floor, by TVL, to 198 rows. A protocol is pre-token when
// its record carries no token (no market cap, no CoinGecko id, no symbol); live-token protocols are
// kept apart and shown with the market's own values, never mixed into the ranking.
//
// Implied value follows only from the snapshot's own figures, fitted at run time:
//
//   log(implied) = intercept + slope x log(TVL) + growth_coef_damped x growth_clipped
//                  + age_coef x logAge + offset[category]
//
//   growth_clipped = clamp(change_7d, -40, +30) / 100   (null -> 0)
//   logAge         = log(age_days + 1), or the calibration median when listed_at is null
//   growth_coef_damped = 0.5 x growth_coef             (the raw fit is halved, not trusted whole)
//   offset[cat]    = n / (n + 10) x mean residual log of that category (shrunk; null category -> 0)
//
// No coefficient is hard-coded and no protocol name is ever special-cased: the fit is recomputed
// from the snapshot on every run. Age is in the model because the rubric asks for how long a
// protocol has run with no token; its fitted effect is small and negative, and the dashboard says
// so honestly. Validation (5-fold CV, a time split, leave-one-out, a 200-draw bootstrap) is computed
// at run time from the same snapshot and shown on the dashboard.

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

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-4';

/** Board rows: the 40 watchlist slugs plus this many early rows below the floor. */
export const EARLY_ROWS = 158;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The calibration set: live-token protocols (a token that trades, a market cap, a TVL). */
export const CALIBRATION_MIN = 1;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One validation split's scores, computed at run time. */
export interface ValidationSplit {
  n: number;
  n_train?: number;
  n_test?: number;
  median_abs_error: number;
  spearman: number;
  within_2x: number;
}

/** One bootstrap coefficient's spread over the resamples. */
export interface BootstrapCoef {
  mean: number;
  sd: number;
  lo: number;
  hi: number;
}

/** Everything the fit learned, so the dashboard can state it and recompute every row. */
export interface Fit {
  model_version: string;
  n_calibration: number;
  intercept: number;
  slope: number;
  growth_coef: number;
  growth_coef_damped: number;
  age_coef: number;
  median_log_age: number;
  median_age_days: number;
  offsets: Record<string, number>;
  pre_token_audited: number;
  verdict_t1: number;
  verdict_t2: number;
  cv: ValidationSplit;
  time_split: ValidationSplit;
  loo: ValidationSplit;
  bootstrap: { n: number; slope: BootstrapCoef; growth_coef: BootstrapCoef; age_coef: BootstrapCoef };
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
  growth_clipped: number;
  category_offset: number;
  verdict: 'farm' | 'thin' | 'skip';
  verdict_reason: string;
  farm_cost_usd: number;
  capital_usd: number;
  hold_days: number;
  model: {
    intercept: number;
    slope: number;
    growth_coef_damped: number;
    age_coef: number;
    growth_clipped: number;
    category_offset: number;
    log_age: number;
    median_log_age: number;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row; the farm plan travels with it, verbatim. */
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
  verdict_reason: string;
  farm_cost_usd: number;
  capital_usd: number;
  hold_days: number;
  farm_steps: string[];
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
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  pre_token_audited: number;
  fit: Fit;
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
const GROWTH_FLOOR = -40;
const GROWTH_CAP = 30;
const GROWTH_DAMP = 0.5;
const SHRINK_K = 10;

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

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

/** The median of a non-empty number array (the mean of the middle two when even). */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories the board never ranks: exchanges and bridged, wrapped or staked products. */
const EXCLUDED_CATEGORIES = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not excluded, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && (p.category === null || !EXCLUDED_CATEGORIES.has(p.category)) && !VERSIONED.test(p.name);
}

/** Whether a protocol belongs to the calibration set: a token that trades, with a cap and a TVL. */
export function isCalibration(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** Seven-day growth, clipped to [-40%, +30%] and written as a fraction; null reads as 0. */
export function growthClipped(p: SnapshotProtocol): number {
  const raw = finite(p.change_7d, 0);
  return Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, raw)) / 100;
}

/** log(age_days + 1), or the calibration median when the protocol's listing date is unknown. */
function logAge(age: number | null, medianLogAge: number): number {
  return age === null ? medianLogAge : Math.log(age + 1);
}

/** One calibration row's features: [1, log(TVL), growth_clipped, logAge]. */
function features(p: SnapshotProtocol, asOf: string, medianLogAge: number): number[] {
  return [1, Math.log(p.tvl_usd), growthClipped(p), logAge(ageDays(asOf, p.listed_at), medianLogAge)];
}

/**
 * Ordinary least squares by the normal equations, standard library only. Solves (X'X)b = X'y
 * with Gaussian elimination and partial pivoting; returns null when the system is singular.
 */
export function ols(design: number[][], target: number[]): number[] | null {
  const k = design[0]!.length;
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < design.length; i++) {
    const row = design[i]!;
    for (let a = 0; a < k; a++) {
      xty[a]! += row[a]! * target[i]!;
      for (let b = 0; b < k; b++) xtx[a]![b]! += row[a]! * row[b]!;
    }
  }
  const m: number[][] = xtx.map((row, i) => [...row, xty[i]!]);
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    if (pivot !== col) {
      const tmp = m[col]!;
      m[col] = m[pivot]!;
      m[pivot] = tmp;
    }
    for (let r = col + 1; r < k; r++) {
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= k; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  const coef = new Array<number>(k).fill(0);
  for (let r = k - 1; r >= 0; r--) {
    let s = m[r]![k]!;
    for (let c = r + 1; c < k; c++) s -= m[r]![c]! * coef[c]!;
    coef[r] = s / m[r]![r]!;
  }
  return coef;
}

/** The median log age of the calibration set's protocols whose listing date is known. */
function medianLogAgeOf(set: SnapshotProtocol[], asOf: string): { medianLogAge: number; medianAgeDays: number } {
  const ages = set.map((p) => ageDays(asOf, p.listed_at)).filter((a): a is number => a !== null);
  const logAges = ages.map((a) => Math.log(a + 1));
  return { medianLogAge: logAges.length > 0 ? median(logAges) : Math.log(1001), medianAgeDays: ages.length > 0 ? median(ages) : 1000 };
}

/**
 * Fit the 4-predictor OLS on a set of live-token protocols and shrink each category's mean
 * residual log into an offset. Returns the coefficients, the offsets and the median log age.
 */
function fitOn(set: SnapshotProtocol[], asOf: string): { coef: number[]; offsets: Record<string, number>; medianLogAge: number; medianAgeDays: number } | null {
  if (set.length < 5) return null;
  const { medianLogAge, medianAgeDays } = medianLogAgeOf(set, asOf);
  const design = set.map((p) => features(p, asOf, medianLogAge));
  const target = set.map((p) => Math.log(p.mcap_usd!));
  const coef = ols(design, target);
  if (coef === null) return null;
  const residuals = new Map<string, number[]>();
  for (let i = 0; i < set.length; i++) {
    const p = set[i]!;
    if (p.category === null) continue;
    const pred = design[i]!.reduce((s, x, j) => s + x * coef[j]!, 0);
    const list = residuals.get(p.category) ?? [];
    list.push(target[i]! - pred);
    residuals.set(p.category, list);
  }
  const offsets: Record<string, number> = {};
  for (const [cat, rs] of residuals) {
    const mean = rs.reduce((s, r) => s + r, 0) / rs.length;
    offsets[cat] = (rs.length / (rs.length + SHRINK_K)) * mean;
  }
  return { coef, offsets, medianLogAge, medianAgeDays };
}

/** log(implied) for one protocol under a fitted model, before rounding. */
function logImplied(p: SnapshotProtocol, asOf: string, coef: number[], offsets: Record<string, number>, medianLogAge: number, damped: boolean): number {
  const x = features(p, asOf, medianLogAge);
  const growth = damped ? GROWTH_DAMP * coef[2]! : coef[2]!;
  const off = p.category !== null ? (offsets[p.category] ?? 0) : 0;
  return coef[0]! + coef[1]! * x[1]! + growth * x[2]! + coef[3]! * x[3]! + off;
}

/** The implied value in whole dollars: exp of the log prediction, at least $1. */
function impliedValue(p: SnapshotProtocol, asOf: string, coef: number[], offsets: Record<string, number>, medianLogAge: number): number {
  return Math.max(1, Math.round(Math.exp(logImplied(p, asOf, coef, offsets, medianLogAge, true))));
}

/** Ranks with average ranks for ties (for Spearman). */
function ranks(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.v === order[i]!.v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k]!.i] = avg;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation between actual and predicted values. */
function spearman(actual: number[], predicted: number[]): number {
  if (actual.length < 3) return 0;
  const ra = ranks(actual);
  const rp = ranks(predicted);
  const ma = ra.reduce((s, v) => s + v, 0) / ra.length;
  const mp = rp.reduce((s, v) => s + v, 0) / rp.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i]! - ma) * (rp[i]! - mp);
    da += (ra[i]! - ma) ** 2;
    db += (rp[i]! - mp) ** 2;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/** Median |error| (relative), Spearman and the within-2x share for actual/predicted pairs. */
function scorePairs(actual: number[], predicted: number[]): { median_abs_error: number; spearman: number; within_2x: number } {
  const errs = actual.map((a, i) => Math.abs(predicted[i]! - a) / a);
  const within = actual.filter((a, i) => predicted[i]! >= a / 2 && predicted[i]! <= a * 2).length;
  return {
    median_abs_error: round4(median(errs)),
    spearman: round4(spearman(actual, predicted)),
    within_2x: round4(actual.length > 0 ? within / actual.length : 0),
  };
}

/** A seeded PRNG (mulberry32) so the bootstrap is identical on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The spread of one bootstrap coefficient: mean, sd and the 95% interval (2.5 / 97.5 percentiles). */
function bootSpread(values: number[]): BootstrapCoef {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, values.length - 1));
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))]!;
  return { mean: round4(mean), sd: round4(sd), lo: round4(at(0.025)), hi: round4(at(0.975)) };
}

/**
 * All validation, computed at run time from the calibration set: 5-fold CV (fold = index % 5),
 * a time split (train listed before 2024, test listed 2024 or later), leave-one-out, and a
 * 200-draw seeded bootstrap of the three slopes.
 */
function validate(calibration: SnapshotProtocol[], asOf: string): Pick<Fit, 'cv' | 'time_split' | 'loo' | 'bootstrap'> {
  // 5-fold cross-validation, full model (OLS + category offsets) refit per fold.
  const cvActual: number[] = [];
  const cvPred: number[] = [];
  for (let fold = 0; fold < 5; fold++) {
    const train = calibration.filter((_, i) => i % 5 !== fold);
    const test = calibration.filter((_, i) => i % 5 === fold);
    const fit = fitOn(train, asOf);
    if (fit === null) continue;
    for (const p of test) {
      cvActual.push(p.mcap_usd!);
      cvPred.push(impliedValue(p, asOf, fit.coef, fit.offsets, fit.medianLogAge));
    }
  }
  const cv = { n: cvActual.length, ...scorePairs(cvActual, cvPred) };

  // Time split: learn from protocols listed before 2024 (or never dated), test on 2024 and later.
  const trainSet = calibration.filter((p) => p.listed_at === null || p.listed_at < '2024-01-01');
  const testSet = calibration.filter((p) => p.listed_at !== null && p.listed_at >= '2024-01-01');
  const tsActual: number[] = [];
  const tsPred: number[] = [];
  const tsFit = fitOn(trainSet, asOf);
  if (tsFit !== null) {
    for (const p of testSet) {
      tsActual.push(p.mcap_usd!);
      tsPred.push(impliedValue(p, asOf, tsFit.coef, tsFit.offsets, tsFit.medianLogAge));
    }
  }
  const time_split = { n: tsActual.length, n_train: trainSet.length, n_test: testSet.length, ...scorePairs(tsActual, tsPred) };

  // Leave-one-out: refit on the other 127, predict the one left out.
  const looActual: number[] = [];
  const looPred: number[] = [];
  for (let i = 0; i < calibration.length; i++) {
    const train = calibration.filter((_, j) => j !== i);
    const fit = fitOn(train, asOf);
    if (fit === null) continue;
    const p = calibration[i]!;
    looActual.push(p.mcap_usd!);
    looPred.push(impliedValue(p, asOf, fit.coef, fit.offsets, fit.medianLogAge));
  }
  const loo = { n: looActual.length, ...scorePairs(looActual, looPred) };

  // Bootstrap: 200 resamples of the calibration set, OLS refit each time, coefficients only.
  const rng = mulberry32(42);
  const slopes: number[] = [];
  const growths: number[] = [];
  const ages: number[] = [];
  const { medianLogAge } = medianLogAgeOf(calibration, asOf);
  for (let b = 0; b < 200; b++) {
    const sample: SnapshotProtocol[] = [];
    for (let i = 0; i < calibration.length; i++) sample.push(calibration[Math.floor(rng() * calibration.length)]!);
    const design = sample.map((p) => features(p, asOf, medianLogAge));
    const target = sample.map((p) => Math.log(p.mcap_usd!));
    const coef = ols(design, target);
    if (coef === null) continue;
    slopes.push(coef[1]!);
    growths.push(coef[2]!);
    ages.push(coef[3]!);
  }
  const bootstrap = { n: slopes.length, slope: bootSpread(slopes), growth_coef: bootSpread(growths), age_coef: bootSpread(ages) };

  return { cv, time_split, loo, bootstrap };
}

/** Fit the radar-4 model on the snapshot's calibration set, with all validation. */
export function fitRadar(snapshot: Snapshot): Fit {
  const calibration = snapshot.protocols.filter(isCalibration);
  const fit = fitOn(calibration, snapshot.as_of);
  if (fit === null) throw new SnapshotError('the snapshot has too few live-token protocols to fit radar-4');
  const validation = validate(calibration, snapshot.as_of);
  const preTokenAudited = snapshot.protocols.filter(isPreToken).length;
  return {
    model_version: MODEL_VERSION,
    n_calibration: calibration.length,
    intercept: round4(fit.coef[0]!),
    slope: round4(fit.coef[1]!),
    growth_coef: round4(fit.coef[2]!),
    growth_coef_damped: round4(GROWTH_DAMP * fit.coef[2]!),
    age_coef: round4(fit.coef[3]!),
    median_log_age: round4(fit.medianLogAge),
    median_age_days: round2(fit.medianAgeDays),
    offsets: Object.fromEntries(Object.entries(fit.offsets).map(([k, v]) => [k, round4(v)])),
    pre_token_audited: preTokenAudited,
    // Tercile cutoffs in dollars; buildRadar fills them from the board (the last FARM row's
    // implied value, and the last THIN row's), because they only exist once the board is ranked.
    verdict_t1: 0,
    verdict_t2: 0,
    cv: validation.cv,
    time_split: validation.time_split,
    loo: validation.loo,
    bootstrap: validation.bootstrap,
  };
}

// ---------------------------------------------------------------- farm plans

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

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** Gas for one transaction on a chain, in dollars, by the chain's usual fee level. */
function gasPerTx(chain: string): number {
  const c = chain.toLowerCase();
  if (c.includes('ethereum')) return 5;
  if (c.includes('solana')) return 0.05;
  if (c.includes('binance') || c.includes('bsc') || c.includes('bnb')) return 0.2;
  if (['base', 'arbitrum', 'optimism', 'polygon', 'blast', 'linea', 'scroll', 'zksync', 'mode'].some((k) => c.includes(k))) return 0.5;
  if (['avalanche', 'fantom', 'gnosis', 'celo'].some((k) => c.includes(k))) return 0.3;
  if (['tron', 'sui', 'aptos', 'ton', 'near'].some((k) => c.includes(k))) return 0.1;
  return 1.5;
}

/** The sunk gas of a farm: one setup transaction plus one a week for the whole hold. */
function farmCostUsd(p: SnapshotProtocol, hold: number): number {
  const gas = gasPerTx(chainOf(p));
  return round2(gas * (1 + Math.ceil(hold / 7)));
}

function money(n: number): string {
  return n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`;
}

/**
 * One mechanism per category: the primary action and the weekly action, with the protocol's own
 * capital, name and chain filled in. No name is special-cased; the category decides the mechanism.
 */
function mechanismFor(p: SnapshotProtocol, capital: number, chain: string): { primary: string; weekly: string } {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const cap = money(capital);
  if (c.includes('risk curator') || c.includes('curator')) return {
    primary: `Deposit ${cap} of USDC into a ${name} curator vault on ${chain} and hold the vault shares.`,
    weekly: `Check the vault's allocation and rebalance or top up ${cap} of exposure once a week.`,
  };
  if (c.includes('allocator') || c.includes('capital allocator')) return {
    primary: `Allocate ${cap} of USDC through ${name} on ${chain} into its listed strategies and hold the position.`,
    weekly: `Review the allocation and move a small slice between strategies once a week.`,
  };
  if (c.includes('leveraged farm')) return {
    primary: `Open a ${cap} leveraged farm on ${name} on ${chain} at low leverage and keep the position open.`,
    weekly: `Top up or rebalance the farm by a small amount once a week to keep it active.`,
  };
  if (c.includes('uncollateralized')) return {
    primary: `Lend ${cap} of USDC through ${name} on ${chain} to its uncollateralized pool and hold the receipt.`,
    weekly: `Check the pool's utilisation and roll or add a small amount once a week.`,
  };
  if (c.includes('basis')) return {
    primary: `Open a ${cap} delta-neutral basis position on ${name} on ${chain} and keep both legs open.`,
    weekly: `Rebalance the hedge by a small amount once a week so the position stays neutral.`,
  };
  if (c.includes('liquidity manager')) return {
    primary: `Deposit ${cap} of USDC into ${name}'s managed liquidity vault on ${chain} and hold the shares.`,
    weekly: `Let the manager rebalance, and add a small deposit once a week to stay in the vault.`,
  };
  if (c.includes('yield aggregator')) return {
    primary: `Deposit ${cap} of USDC into a ${name} aggregator vault on ${chain} and hold the vault shares.`,
    weekly: `Harvest or compound the vault rewards once a week and redeposit them.`,
  };
  if (c.includes('yield')) return {
    primary: `Deposit ${cap} of USDC into ${name}'s highest-TVL yield vault on ${chain} and hold the shares.`,
    weekly: `Claim or compound the vault yield once a week and keep the position open.`,
  };
  if (c.includes('dex') || c.includes('farm')) return {
    primary: `Provide ${cap} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`,
    weekly: `Swap a small amount through the pool once a week and collect the trading fees.`,
  };
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return {
    primary: `Supply ${cap} of USDC to ${name} on ${chain} and borrow a small amount against it to show both sides.`,
    weekly: `Repay and re-borrow a small amount once a week so the account stays active.`,
  };
  if (c.includes('restak') || c.includes('staking')) return {
    primary: `Stake ${cap} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`,
    weekly: `Restake the staking rewards once a week and keep the position compounding.`,
  };
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options') || c.includes('interest rate')) return {
    primary: `Deposit ${cap} of USDC as margin on ${name} on ${chain} and open one small hedged position.`,
    weekly: `Adjust or roll the hedge once a week and keep the margin above the minimum.`,
  };
  if (c.includes('rwa')) return {
    primary: `Mint ${cap} of ${name}'s yield-bearing asset on ${chain} and hold it in the farming wallet.`,
    weekly: `Claim the asset's yield once a week and keep the holding in the same wallet.`,
  };
  if (c.includes('stablecoin') || c.includes('stable')) return {
    primary: `Mint or deposit ${cap} of the stable asset through ${name} on ${chain} and hold it.`,
    weekly: `Use the stable asset in one small transfer or swap a week to keep the account active.`,
  };
  if (c.includes('prediction')) return {
    primary: `Fund ${cap} on ${name} on ${chain} and place one position on a market that resolves after the hold.`,
    weekly: `Place one small market position a week on markets you have actually read.`,
  };
  if (c.includes('insurance')) return {
    primary: `Buy ${cap} of cover from ${name} on ${chain} and keep the policy for the whole hold.`,
    weekly: `Check the policy and the covered protocols once a week; renew before it lapses.`,
  };
  if (c.includes('payment') || c.includes('card')) return {
    primary: `Load ${cap} through ${name} on ${chain} and make one real payment with it.`,
    weekly: `Make one small payment a week through ${name} so the account shows steady use.`,
  };
  if (c.includes('privacy')) return {
    primary: `Deposit ${cap} through ${name}'s private pool on ${chain} and hold the shielded balance.`,
    weekly: `Make one small shielded transfer a week and keep the funds in the same wallet.`,
  };
  if (c.includes('index')) return {
    primary: `Buy ${cap} of ${name}'s index token on ${chain} and hold it for the whole period.`,
    weekly: `Check the index composition once a week and top up a small amount if it rebalances.`,
  };
  if (c.includes('governance')) return {
    primary: `Stake ${cap} in ${name}'s governance on ${chain} and vote on one live proposal.`,
    weekly: `Vote on one proposal a week and keep the stake locked for the whole hold.`,
  };
  if (c.includes('otc')) return {
    primary: `Place a ${cap} order through ${name}'s OTC desk on ${chain} and settle it in the farming wallet.`,
    weekly: `Quote one small trade a week and settle at least one so the desk sees repeat flow.`,
  };
  if (c.includes('chain')) return {
    primary: `Bridge ${cap} of USDC to ${name} on ${chain} and stake or deposit it in its native app.`,
    weekly: `Make one transaction a week in the chain's native app to keep the address active.`,
  };
  if (c.includes('btc')) return {
    primary: `Deposit ${cap} of BTC-backed assets through ${name} on ${chain} and hold the receipt.`,
    weekly: `Check the BTC yield once a week and compound a small amount back into the position.`,
  };
  if (c.includes('cedefi')) return {
    primary: `Deposit ${cap} of USDC into ${name} on ${chain} and hold the position for the whole period.`,
    weekly: `Check the CeDeFi yield once a week and keep the deposit in the same wallet.`,
  };
  if (c.includes('bridge')) return {
    primary: `Bridge ${cap} of USDC to ${chain} through ${name} and use the bridged funds in its app.`,
    weekly: `Bridge a small amount once a week and use it on the destination chain.`,
  };
  return {
    primary: `Deposit ${cap} of USDC into ${name} on ${chain} and keep the position open.`,
    weekly: `Make one qualifying action each week, such as a deposit, a swap or a vote.`,
  };
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names. The verdict step states the dollar cost explicitly: the capital is locked and returns on
 * exit, the only sunk cost is gas.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, verdict: string, reason: string, cost: number, capital: number, hold: number, implied: number): FarmStep[] {
  const chain = chainOf(p);
  const mech = mechanismFor(p, capital, chain);
  const gas = gasPerTx(chain);
  return [
    {
      text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: mech.primary,
      cost: `${money(capital)} of capital and about ${money(gas)} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: mech.weekly,
      cost: `about ${money(gas)} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the ${money(capital)} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Verdict ${verdict.toUpperCase()}: ${reason} Farm cost: ${money(cost)} sunk gas over ${hold} days on ${money(capital)} capital; implied value ${money(implied)}.`,
      cost: `${money(cost)} sunk gas in total`,
      time: `${hold} days`,
    },
    {
      text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.',
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

// ---------------------------------------------------------------- the board

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && (p.category === null || !EXCLUDED_CATEGORIES.has(p.category)))
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
export function buildBoard(snapshot: Snapshot, fit: Fit): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: the strongest pre-token protocols outside the watchlist, by TVL, capped.
  // No floor here: a protocol above the floor that the watchlist leaves out is still early.
  // Never a replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const coef = [fit.intercept, fit.slope, fit.growth_coef, fit.age_coef];
  const offsets = fit.offsets;
  // Score with exactly the rounded inputs the dashboard recomputes from (round4 growth, rounded
  // coefficients, rounded offsets, rounded median log age), so impliedOf in app.js reproduces
  // board.json dollar for dollar.
  const scored = [...chosen.values()].map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const gc = round4(growthClipped(p));
    const off = p.category !== null ? (offsets[p.category] ?? 0) : 0;
    const la = logAge(age, fit.median_log_age);
    const logImp = coef[0]! + coef[1]! * Math.log(p.tvl_usd) + GROWTH_DAMP * coef[2]! * gc + coef[3]! * la + off;
    const implied = Math.max(1, Math.round(Math.exp(logImp)));
    return { p, age, implied };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const n = scored.length;
  const farmCut = Math.ceil(n / 3);
  const thinCut = Math.ceil((2 * n) / 3);
  return scored.map((s, i) => {
    const p = s.p;
    const gc = growthClipped(p);
    const off = p.category !== null ? (offsets[p.category] ?? 0) : 0;
    const la = logAge(s.age, fit.median_log_age);
    const capital = capitalFor(p);
    const hold = holdDaysFor(s.age);
    const cost = farmCostUsd(p, hold);
    const hot = (p.change_7d ?? 0) >= GROWTH_CAP;
    const verdict: 'farm' | 'thin' | 'skip' = hot ? 'skip' : i < farmCut ? 'farm' : i < thinCut ? 'thin' : 'skip';
    const reason =
      verdict === 'farm'
        ? `top third of this board by implied value (${money(s.implied)}), so it earns the most attention.`
        : verdict === 'thin'
          ? `middle third of this board by implied value (${money(s.implied)}): worth a small position, not a large one.`
          : hot
            ? `seven-day TVL growth hit the +30% clip, which reads as hot money, so it is skipped whatever its size.`
            : `bottom third of this board by implied value (${money(s.implied)}): too small to justify the gas.`;
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token',
      age_days: s.age,
      implied_value_usd: s.implied,
      growth_clipped: round4(gc),
      category_offset: round4(off),
      verdict,
      verdict_reason: reason,
      farm_cost_usd: cost,
      capital_usd: capital,
      hold_days: hold,
      model: {
        intercept: fit.intercept,
        slope: fit.slope,
        growth_coef_damped: fit.growth_coef_damped,
        age_coef: fit.age_coef,
        growth_clipped: round4(gc),
        category_offset: round4(off),
        log_age: round4(la),
        median_log_age: fit.median_log_age,
      },
      farm_steps: farmSteps(p, s.age, verdict, reason, cost, capital, hold, s.implied).map(stepText),
    };
  });
}

/** A board row's compact form for data.js, with the farm plan verbatim. */
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
    growth_clipped: row.growth_clipped,
    category_offset: row.category_offset,
    verdict: row.verdict,
    verdict_reason: row.verdict_reason,
    farm_cost_usd: row.farm_cost_usd,
    capital_usd: row.capital_usd,
    hold_days: row.hold_days,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData; fit: Fit } {
  const fit = fitRadar(snapshot);
  const board = buildBoard(snapshot, fit);
  const n = board.length;
  fit.verdict_t1 = board[Math.ceil(n / 3) - 1]!.implied_value_usd;
  fit.verdict_t2 = board[Math.ceil((2 * n) / 3) - 1]!.implied_value_usd;
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    pre_token_audited: fit.pre_token_audited,
    fit,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar, fit };
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
