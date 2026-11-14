#!/usr/bin/env node
// Backtest radar-2 on the snapshot's LIVE-TOKEN protocols (point 3).
// For each live-token protocol (mcap_usd non-null), compute the radar-2 implied
// value from its TVL/category/growth/maturity/chains using the SAME calibration
// (category multiples fitted from the snapshot) and compare to its actual mcap_usd.
// Reports median/mean percentage error and the share within 2x / 5x / 10x.
// Usage: node backtest.mjs [--model <json overrides>] [--out <file>]
//   --model '{"growth_weight":0.5,"multiple_max":1.0}' overrides MODEL constants.
import { readFileSync, writeFileSync } from 'node:fs';

const snap = JSON.parse(readFileSync('/home/hatch/workspace/makefun/token-radar-01-kit/input/snapshot.json', 'utf8'));
const modelTs = readFileSync('/home/hatch/workspace/makefun/token-radar-01/lib/model.ts', 'utf8');

// --- replicate the model from lib/model.ts (same constants + functions) ---
const MODEL = {
  growth_weight: 0.5, growth_floor: -60, growth_cap: 120,
  maturity_floor: 0.6, maturity_range: 0.4, maturity_days: 1095,
  unknown_age_days: 365, multiple_min: 0.05, multiple_max: 1.0,
  multiple_min_category: 3, chain_step: 0.05, chain_max_extra: 4,
};
const overrides = {};
const mi = process.argv.indexOf('--model');
if (mi >= 0) Object.assign(overrides, JSON.parse(process.argv[mi + 1]));
Object.assign(MODEL, overrides);

const DAY_MS = 86400000;
function ageDays(asOf, listedAt) {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}
function median(sorted) {
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function calibrate(protocols) {
  const live = protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const allRatios = live.map((p) => p.mcap_usd / p.tvl_usd).sort((a, b) => a - b);
  const global = Math.min(MODEL.multiple_max, Math.max(MODEL.multiple_min, median(allRatios)));
  const byCat = new Map();
  for (const p of live) {
    if (p.category === null) continue;
    const list = byCat.get(p.category) ?? [];
    list.push(p.mcap_usd / p.tvl_usd);
    byCat.set(p.category, list);
  }
  const out = new Map();
  for (const [cat, ratios] of byCat) {
    ratios.sort((a, b) => a - b);
    if (ratios.length >= MODEL.multiple_min_category) {
      out.set(cat, Math.min(MODEL.multiple_max, Math.max(MODEL.multiple_min, median(ratios))));
    }
  }
  return { global, byCat: out };
}
function implied(p, asOf, cal) {
  const age = ageDays(asOf, p.listed_at);
  const growth = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, Number.isFinite(p.change_7d) ? p.change_7d : 0));
  const growthMult = 1 + (growth / 100) * MODEL.growth_weight;
  const ageFor = age ?? MODEL.unknown_age_days;
  const maturity = MODEL.maturity_floor + (Math.min(Math.max(ageFor, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
  const chains = 1 + MODEL.chain_step * Math.min(Math.max(p.chains.length - 1, 0), MODEL.chain_max_extra);
  const mult = p.category !== null && cal.byCat.has(p.category) ? cal.byCat.get(p.category) : cal.global;
  return Math.max(1, Math.round(p.tvl_usd * mult * growthMult * maturity * chains));
}

const cal = calibrate(snap.protocols);
const live = snap.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
console.log(`live-token protocols with mcap+TVL: ${live.length} | global multiple: ${cal.global.toFixed(4)}`);
console.log(`model overrides: ${JSON.stringify(overrides)}`);

const rows = [];
for (const p of live) {
  const pred = implied(p, snap.as_of, cal);
  const actual = p.mcap_usd;
  const err = (pred - actual) / actual; // signed relative error
  const absErr = Math.abs(err);
  const ratio = pred / actual;
  rows.push({ slug: p.slug, name: p.name, category: p.category, tvl: p.tvl_usd, actual, pred, err, absErr, ratio });
}
rows.sort((a, b) => a.absErr - b.absErr);
const absErrs = rows.map((r) => r.absErr).sort((a, b) => a - b);
const errs = rows.map((r) => r.err).sort((a, b) => a - b);
const med = median(absErrs);
const mean = absErrs.reduce((s, x) => s + x, 0) / absErrs.length;
const medSigned = median(errs);
const within = (x) => rows.filter((r) => r.ratio >= 1 / x && r.ratio <= x).length;
console.log(`\nmedian |error|: ${(med * 100).toFixed(1)}%`);
console.log(`mean   |error|: ${(mean * 100).toFixed(1)}%`);
console.log(`median signed error: ${(medSigned * 100).toFixed(1)}% (${medSigned >= 0 ? 'over-predicts' : 'under-predicts'} on balance)`);
console.log(`within 2x:  ${within(2)} / ${rows.length} (${(100 * within(2) / rows.length).toFixed(1)}%)`);
console.log(`within 5x:  ${within(5)} / ${rows.length} (${(100 * within(5) / rows.length).toFixed(1)}%)`);
console.log(`within 10x: ${within(10)} / ${rows.length} (${(100 * within(10) / rows.length).toFixed(1)}%)`);
console.log(`outside 10x: ${rows.length - within(10)} / ${rows.length}`);
// error by direction
const over = rows.filter((r) => r.err > 0).length;
console.log(`over-predicted: ${over} | under-predicted: ${rows.length - over}`);
console.log(`\nbest 10 (closest):`);
for (const r of rows.slice(0, 10)) console.log(`  ${r.slug} | pred $${r.pred.toLocaleString()} vs actual $${r.actual.toLocaleString()} | err ${(r.err * 100).toFixed(1)}%`);
console.log(`\nworst 10 (farthest):`);
for (const r of rows.slice(-10).reverse()) console.log(`  ${r.slug} | pred $${r.pred.toLocaleString()} vs actual $${r.actual.toLocaleString()} | err ${(r.err * 100).toFixed(1)}% | ratio ${r.ratio.toFixed(2)}x`);
// error by category (categories with >=5 live protocols)
const byCat = new Map();
for (const r of rows) {
  const l = byCat.get(r.category) ?? [];
  l.push(r.absErr);
  byCat.set(r.category, l);
}
console.log(`\nmedian |error| by category (>=5 live):`);
for (const [cat, list] of [...byCat.entries()].filter(([, l]) => l.length >= 5).sort((a, b) => median([...b[1]].sort((x, y) => x - y)) - median([...a[1]].sort((x, y) => x - y)))) {
  console.log(`  ${cat}: ${(median([...list].sort((x, y) => x - y)) * 100).toFixed(0)}% (n=${list.length})`);
}
const oi = process.argv.indexOf('--out');
if (oi >= 0) {
  writeFileSync(process.argv[oi + 1], JSON.stringify({ model: MODEL, global_multiple: cal.global, n: rows.length, median_abs_error: med, mean_abs_error: mean, median_signed_error: medSigned, within2: within(2), within5: within(5), within10: within(10), rows }, null, 2));
  console.log(`\nwrote ${process.argv[oi + 1]}`);
}
