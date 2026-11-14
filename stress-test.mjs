#!/usr/bin/env node
// Stress test for token-radar-01 (point 4). Builds a mock snapshot with extreme data,
// runs main.ts against it twice in a scratch dir, and checks:
//   - no crash (exit 0 both runs)
//   - deterministic output (two runs byte-identical)
//   - no NaN / Infinity / negative implied values
//   - ranks exactly 1..N
//   - farm steps 3..12 strings of 20..600 chars
//   - every row is pre-token and rankable
// Usage: node stress-test.mjs
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/hatch/workspace/makefun/token-radar-01';
const SCRATCH = '/tmp/token-radar-stress';
const SNAP = join(SCRATCH, 'snapshot.json');

const extreme = (slug, name, over) => ({
  slug, name,
  category: 'Dexs', chains: ['Ethereum'], tvl_usd: 10_000_000,
  change_7d: 0, mcap_usd: null, listed_at: '2025-01-01',
  gecko_id: null, symbol: null, ...over,
});

const protocols = [
  extreme('zero-tvl', 'Zero TVL', { tvl_usd: 0 }),
  extreme('null-change', 'Null Change', { change_7d: null }),
  extreme('crash-99', 'Crash 99', { change_7d: -99 }),
  extreme('moon-500', 'Moon 500', { change_7d: 500 }),
  extreme('null-category', 'Null Category', { category: null }),
  extreme('nonsense-category', 'Nonsense Category', { category: 'Quantum Banana' }),
  extreme('null-listed', 'Null Listed', { listed_at: null }),
  extreme('bad-listed', 'Bad Listed', { listed_at: 'not-a-date' }),
  extreme('future-listed', 'Future Listed', { listed_at: '2027-01-01' }),
  extreme('empty-chains', 'Empty Chains', { chains: [] }),
  extreme('many-chains', 'Many Chains', { chains: ['Ethereum', 'Base', 'Arbitrum', 'Solana', 'Polygon', 'Optimism', 'Avalanche', 'BSC', 'Tron', 'Sui'] }),
  extreme('floor-edge', 'Floor Edge', { tvl_usd: 5_000_001 }),
  extreme('huge-tvl', 'Huge TVL', { tvl_usd: 999_000_000_000 }),
  extreme('tiny-tvl', 'Tiny TVL', { tvl_usd: 1 }),
  extreme('old-age', 'Old Age', { listed_at: '2019-01-01' }),
  extreme('live-token', 'Live Token', { mcap_usd: 123_456_789, gecko_id: 'live-token', symbol: 'LIVE' }),
  extreme('negative-change-huge', 'Negative Change Huge', { change_7d: -999 }),
  extreme('zero-change', 'Zero Change', { change_7d: 0 }),
  extreme('fractional-tvl', 'Fractional TVL', { tvl_usd: 5_000_000.7 }),
  extreme('null-everything', 'Null Everything', { category: null, chains: [], change_7d: null, listed_at: null, tvl_usd: 0 }),
];

const snapshot = {
  as_of: '2026-11-14',
  source: 'stress-test mock (not the sealed snapshot)',
  floor_usd: 5_000_000,
  protocols,
  watchlist: ['zero-tvl', 'null-change', 'moon-500'],
};

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(join(SCRATCH, 'out1'), { recursive: true });
mkdirSync(join(SCRATCH, 'out2'), { recursive: true });
writeFileSync(SNAP, JSON.stringify(snapshot, null, 2));

let fails = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
};

function run(outDir) {
  try {
    execSync(`MAKEFUN_OUTPUT_DIR=${outDir} node main.ts --input ${SNAP}`, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (e) {
    console.log(`FAIL  main.ts crashed on ${outDir}: ${(e.stderr || e.message || '').toString().slice(0, 500)}`);
    fails++;
    return false;
  }
}

const ok1 = run(join(SCRATCH, 'out1'));
const ok2 = run(join(SCRATCH, 'out2'));
if (!ok1 || !ok2) {
  console.log(`\nSTRESS TEST FAILED (${fails} failures)`);
  process.exit(1);
}

// determinism
const { execSync: ex } = await import('node:child_process');
try {
  ex(`diff -r ${join(SCRATCH, 'out1')} ${join(SCRATCH, 'out2')}`, { encoding: 'utf8' });
  check(true, 'deterministic: two runs byte-identical');
} catch {
  check(false, 'deterministic: two runs byte-identical', 'out1 and out2 differ');
}

const board = JSON.parse(readFileSync(join(SCRATCH, 'out1', 'board.json'), 'utf8'));
const rows = board.rows;
check(rows.length >= 1, `board has rows (${rows.length})`);
check(rows.map((r) => r.rank).every((v, i) => v === i + 1), 'ranks exactly 1..N');
check(rows.every((r) => Number.isFinite(r.implied_value_usd) && Number.isInteger(r.implied_value_usd) && r.implied_value_usd > 0), 'implied values finite, whole, positive', rows.filter((r) => !(Number.isFinite(r.implied_value_usd) && r.implied_value_usd > 0)).map((r) => r.slug).join(', '));
check(rows.every((r, i) => i === 0 || r.implied_value_usd <= rows[i - 1].implied_value_usd), 'implied values non-increasing with rank');
check(rows.every((r) => Array.isArray(r.farm_steps) && r.farm_steps.length >= 3 && r.farm_steps.length <= 12), 'farm_steps 3..12 per row');
check(rows.every((r) => r.farm_steps.every((s) => typeof s === 'string' && s.length >= 20 && s.length <= 600)), 'farm steps 20..600 chars');
check(rows.every((r) => r.mcap_usd === null && r.gecko_id === null && r.symbol === null), 'every row pre-token (live-token row excluded)');
check(!rows.some((r) => r.slug === 'live-token'), 'live-token protocol not on board');
check(['zero-tvl', 'null-change', 'moon-500'].every((s) => rows.some((r) => r.slug === s)), 'all 3 watchlist slugs covered');
// no NaN in the whole output
const raw = readFileSync(join(SCRATCH, 'out1', 'board.json'), 'utf8');
check(!/NaN|Infinity|-Infinity/.test(raw), 'no NaN/Infinity in board.json');
const dataRaw = readFileSync(join(SCRATCH, 'out1', 'data.js'), 'utf8');
check(!/NaN|Infinity|-Infinity/.test(dataRaw), 'no NaN/Infinity in data.js');
console.log('\nboard rows in stress run:');
for (const r of rows) console.log(`  #${r.rank} ${r.slug} | implied $${r.implied_value_usd.toLocaleString()} | ${r.category ?? 'null'} | TVL ${r.tvl_usd}`);
console.log(fails === 0 ? '\nSTRESS TEST PASSED' : `\nSTRESS TEST FAILED (${fails} failures)`);
process.exit(fails === 0 ? 0 : 1);
