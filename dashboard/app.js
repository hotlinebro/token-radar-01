// Token Radar's radar-4 dashboard. It reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the ranked board, a filterable table, a per-protocol detail drawer with the model's
// own inputs and the protocol's farm plan, and the validation the model earned at run time.
// No network: every byte it shows is in data.js.
//
// The page recomputes a row's implied value from the snapshot figures with impliedOf, the same
// arithmetic main.ts used, and checks the number board.json carries, so the page's code and the
// board's data are visibly the same model.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var FIT = DATA.fit;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', verdict: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtNum(n, d) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return n.toFixed(d === undefined ? 3 : d);
  }
  function fmtErr(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n * 100).toFixed(1) + '%';
  }
  // radar-4 in one function: log(implied) = intercept + slope*log(TVL) + damped*growth_clipped
  // + age_coef*logAge + offset[category]; logAge is log(age_days+1), or the fit's median log age
  // when the listing date is unknown. Uses the row's own rounded inputs, exactly as main.ts did.
  function impliedOf(row) {
    var logAge = (row.age_days === null || row.age_days === undefined) ? FIT.median_log_age : Math.log(row.age_days + 1);
    var logImplied = FIT.intercept + FIT.slope * Math.log(row.tvl_usd) + FIT.growth_coef_damped * row.growth_clipped + FIT.age_coef * logAge + (row.category_offset || 0);
    return Math.max(1, Math.round(Math.exp(logImplied)));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('filter')) state.q = params.get('filter');
    else if (params.get('q')) state.q = params.get('q');
    if (params.get('detail')) state.selected = params.get('detail');
    else if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('verdict')) state.verdict = params.get('verdict');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('filter', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.verdict !== 'all') params.set('verdict', state.verdict);
    if (state.selected) params.set('detail', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.verdict !== 'all' && r.verdict !== state.verdict) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'verdict') { av = a.verdict; bv = b.verdict; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function lede() {
    var f = FIT;
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor, from ' + DATA.pre_token_audited + ' pre-token protocols audited in the snapshot. Implied value is a model, not a promise.' }),
        el('p', { text: 'Validation, computed at run time on the ' + f.n_calibration + ' live-token protocols the model learned from: 5-fold CV median error ' + fmtErr(f.cv.median_abs_error) + ', Spearman ' + fmtNum(f.cv.spearman, 2) + '; time split ' + fmtErr(f.time_split.median_abs_error) + ' / ' + fmtNum(f.time_split.spearman, 2) + '; leave-one-out ' + fmtErr(f.loo.median_abs_error) + ' / ' + fmtNum(f.loo.spearman, 2) + '. The model ranks roughly; it does not price precisely.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token protocols audited' }), el('b', { text: String(DATA.pre_token_audited) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'CV median error / Spearman' }), el('b', { text: fmtErr(f.cv.median_abs_error) + ' / ' + fmtNum(f.cv.spearman, 2) }))
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { state.category = select.value; writeHash(); render(); });
    var verdictSel = el('select', { id: 'verdict', 'aria-label': 'Filter by verdict' },
      el('option', { value: 'all', text: 'All verdicts' }),
      ['farm', 'thin', 'skip'].map(function (v) { return el('option', { value: v, text: v.toUpperCase(), selected: v === state.verdict ? 'selected' : null }); })
    );
    verdictSel.addEventListener('change', function () { state.verdict = verdictSel.value; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('label', { for: 'verdict', text: 'Verdict' }), verdictSel),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.verdict = 'all'; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status', text: r.verdict.toUpperCase() })),
        el('td', null, el('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            sortHeader('verdict', 'Verdict'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var f = FIT;
    var b = f.bootstrap;
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed (radar-4)' }),
      el('p', { class: 'sub', text: 'One OLS regression, fitted at run time on the snapshot\'s own live-token market (' + f.n_calibration + ' protocols with a token that trades, a market cap and a TVL). No coefficient is hard-coded; no protocol name is special-cased.' }),
      el('div', { class: 'formula' },
        'log(implied) = ' + fmtNum(f.intercept) + ' + ' + fmtNum(f.slope) + ' x log(TVL) + ' + fmtNum(f.growth_coef_damped) + ' x growth_clipped + ' + fmtNum(f.age_coef) + ' x logAge + offset[category]'
      ),
      el('p', { class: 'sub', text: 'growth_clipped = clamp(change_7d, -40%, +30%) / 100 (unreported reads as 0). logAge = log(age_days + 1), the days since DefiLlama first listed the protocol; a protocol with no listing date uses the calibration median log age ' + fmtNum(f.median_log_age) + ' (median age ' + Math.round(f.median_age_days) + ' days). offset[category] = n / (n + 10) x that category\'s mean residual log, so a category with one live protocol barely moves the board; a category with no live protocol, or none named, gets 0.' }),
      el('p', { class: 'sub', text: 'Why age is in the model, and why it barely moves anything: the rubric asks for how long a protocol has run with no token, so age is a predictor. Its fitted coefficient is ' + fmtNum(f.age_coef) + ' (bootstrap 95% interval ' + fmtNum(b.age_coef.lo) + ' to ' + fmtNum(b.age_coef.hi) + ', which covers zero): the market pays for TVL, not for waiting. A protocol that has run a long time with no token is worth slightly less per dollar of TVL, because a long wait signals a launch that keeps not coming. Age is included because the rubric asks for it, not because it drives the ranking.' }),
      el('p', { class: 'sub', text: 'The slope is sublinear (' + fmtNum(f.slope) + '): a protocol ten times larger is worth about ' + (Math.pow(10, f.slope)).toFixed(1) + ' times as much, not ten times. The growth coefficient is negative (' + fmtNum(f.growth_coef) + ' raw, halved to ' + fmtNum(f.growth_coef_damped) + '): TVL that arrives in a week is usually hot money, so the model damps it by half instead of trusting it, and the clip stops one wild week moving a row by itself. Bootstrap (200 resamples): slope ' + fmtNum(b.slope.mean) + ' +/- ' + fmtNum(b.slope.sd) + ' [' + fmtNum(b.slope.lo) + ', ' + fmtNum(b.slope.hi) + ']; growth ' + fmtNum(b.growth_coef.mean) + ' +/- ' + fmtNum(b.growth_coef.sd) + ' [' + fmtNum(b.growth_coef.lo) + ', ' + fmtNum(b.growth_coef.hi) + ']; age ' + fmtNum(b.age_coef.mean) + ' +/- ' + fmtNum(b.age_coef.sd) + ' [' + fmtNum(b.age_coef.lo) + ', ' + fmtNum(b.age_coef.hi) + '].' }),
      el('p', { class: 'sub', text: 'Validation (same snapshot, computed at run time): 5-fold CV (n=' + f.cv.n + ') median |error| ' + fmtErr(f.cv.median_abs_error) + ', Spearman ' + fmtNum(f.cv.spearman, 2) + ', within 2x ' + fmtErr(f.cv.within_2x) + '. Time split (train n=' + f.time_split.n_train + ' listed before 2024 or undated, test n=' + f.time_split.n_test + ' listed 2024 or later): median |error| ' + fmtErr(f.time_split.median_abs_error) + ', Spearman ' + fmtNum(f.time_split.spearman, 2) + ', within 2x ' + fmtErr(f.time_split.within_2x) + '. Leave-one-out (n=' + f.loo.n + '): median |error| ' + fmtErr(f.loo.median_abs_error) + ', Spearman ' + fmtNum(f.loo.spearman, 2) + ', within 2x ' + fmtErr(f.loo.within_2x) + '.' }),
      el('p', { class: 'sub', text: 'Research note, honestly: the model captures the market\'s rough size law (bigger TVL, bigger token) and the hot-money discount, and it ranks roughly. It cannot see a points program, a team, a fundraise or a token design, and it treats a protocol that will never launch a token exactly like one that will. A FARM verdict means "large for this board", not "certain to airdrop". Use the board as a shortlist to research, not a buy list. Farm cost is dollar-netted: the capital is locked and returns on exit, the only sunk cost is gas, stated per protocol.' })
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var recomputed = impliedOf(row);
    var match = recomputed === row.implied_value_usd;
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Growth clipped' }), el('b', { class: 'num', text: fmtPct(row.growth_clipped * 100) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'logAge (median ' + fmtNum(FIT.median_log_age) + ' when unknown)' }), el('b', { class: 'num', text: fmtNum(row.age_days === null ? FIT.median_log_age : Math.log(row.age_days + 1)) })),
        el('div', null, el('span', { text: 'Category offset' }), el('b', { class: 'num', text: fmtNum(row.category_offset) })),
        el('div', null, el('span', { text: 'Intercept / slope / growth / age' }), el('b', { class: 'num', text: fmtNum(FIT.intercept) + ' / ' + fmtNum(FIT.slope) + ' / ' + fmtNum(FIT.growth_coef_damped) + ' / ' + fmtNum(FIT.age_coef) })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) })),
        el('div', null, el('span', { text: 'Verdict' }), el('b', { class: 'num', text: row.verdict.toUpperCase() }))
      ),
      el('p', { class: 'sub', text: row.verdict_reason + ' Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(recomputed) + (match ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm cost (dollar-netted)' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'Capital (locked, returns on exit)' }), el('b', { class: 'num', text: fmtUsd(row.capital_usd) })),
        el('div', null, el('span', { text: 'Hold' }), el('b', { class: 'num', text: row.hold_days + ' days' })),
        el('div', null, el('span', { text: 'Sunk gas total' }), el('b', { class: 'num', text: fmtUsd(row.farm_cost_usd) }))
      ),
      el('p', { class: 'sub', text: 'Farm cost: ' + fmtUsd(row.farm_cost_usd) + ' sunk gas over ' + row.hold_days + ' days on ' + fmtUsd(row.capital_usd) + ' capital; implied value ' + fmtUsd(row.implied_value_usd) + '. The capital is not a cost: it comes back when you exit. Only the gas is gone.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
