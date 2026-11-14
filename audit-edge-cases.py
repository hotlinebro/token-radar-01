#!/usr/bin/env python3
"""Edge-case audit for token-radar-01 board.json (point 2).

Checks every board row against the sealed snapshot for derivative products that
slipped through the strict rankable rule:
  - categories the watchlist rule misses (Restaking, Cross Chain Bridge, Staking Pool)
  - LRT / yield-bearing / receipt-like names
  - sub-vaults (a specific vault variation under a big protocol)
  - name overlap with a live-token protocol (the row may be a derivative of it)
Prints a flagged list; exit 0. Read-only.
"""
import json
import re
import sys

SNAP = '/home/hatch/workspace/makefun/token-radar-01-kit/input/snapshot.json'
BOARD = '/home/hatch/workspace/makefun/token-radar-01/board.json'

snap = json.load(open(SNAP))
board = json.load(open(BOARD))
rows = board['rows'] if isinstance(board, dict) else board
by_slug = {p['slug']: p for p in snap['protocols']}
live = [p for p in snap['protocols'] if p['mcap_usd'] is not None]

# Categories the house watchlist rule names (excluded) vs ones it does NOT name
HOUSE_EXCLUDED = {'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX'}
SUSPECT_CATS = {'Restaking', 'Cross Chain Bridge', 'Staking Pool', 'Anchor BTC', 'Decentralized BTC', 'Indexes', 'Token Locker'}

# Name patterns that suggest a derivative / receipt / sub-product
NAME_PATTERNS = [
    (r'\b(vaults?|vault)\b', 'vault word'),
    (r'\b(receipt|shares?|yield-bearing|yield bearing)\b', 'receipt/share word'),
    (r'\b(lrt|liquid restak)', 'LRT word'),
    (r'\b(wrapped|staked|staking)\b', 'wrapped/staked word (should already be excluded)'),
    (r'\s(v\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$', 'version marker (should already be excluded)'),
    (r'\b(index|fund|basket)\b', 'index/fund word'),
]

def base_name(name):
    return re.sub(r'[^a-z0-9]+', ' ', name.lower()).strip()

live_names = {}
for p in live:
    live_names.setdefault(base_name(p['name']), []).append(p)

flags = []
for r in rows:
    p = by_slug.get(r['slug'])
    if p is None:
        flags.append((r['rank'], r['slug'], 'NOT IN SNAPSHOT'))
        continue
    reasons = []
    if p['category'] in HOUSE_EXCLUDED:
        reasons.append(f"category {p['category']} is house-excluded but row is on board")
    if p['category'] in SUSPECT_CATS:
        reasons.append(f"category {p['category']} is a derivative-adjacent category the house rule does not name")
    for pat, label in NAME_PATTERNS:
        if re.search(pat, p['name'], re.I):
            reasons.append(f"name matches {label}: {p['name']!r}")
    # name overlap with a live-token protocol (same normalised base name, different slug)
    bn = base_name(p['name'])
    for ln, lps in live_names.items():
        if ln and (ln == bn or bn.startswith(ln + ' ') or ln.startswith(bn + ' ')):
            for lp in lps:
                if lp['slug'] != p['slug']:
                    reasons.append(f"name overlaps live-token protocol {lp['name']} ({lp['slug']}, mcap ${lp['mcap_usd']:,})")
    # sub-vault heuristic: name is "<BigProtocol> <something>" where the first token matches a live protocol's first token
    first = bn.split(' ')[0] if bn else ''
    for ln, lps in live_names.items():
        if ln.split(' ')[0] == first and first and ln != bn:
            for lp in lps:
                if lp['slug'] != p['slug'] and len(first) >= 4:
                    reasons.append(f"shares first word {first!r} with live-token protocol {lp['name']} ({lp['slug']}) — possible sub-product")
                    break
    if reasons:
        flags.append((r['rank'], r['slug'], p['name'], p['category'], p['tvl_usd'], r['implied_value_usd'], reasons))

print(f"board rows: {len(rows)} | flagged: {len(flags)}")
print()
for f in flags:
    rank, slug, name, cat, tvl, impl, reasons = f
    print(f"#{rank} {slug} | {name} | cat={cat} | TVL ${tvl:,} | implied ${impl:,}")
    for reason in reasons:
        print(f"    - {reason}")
    print()

# summary by category of the whole board
from collections import Counter
print('board category counts:', Counter(r['category'] for r in rows).most_common())
print()
print('watchlist slugs on board:', sum(1 for r in rows if r['slug'] in snap['watchlist']), '/', len(snap['watchlist']))
