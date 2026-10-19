// admin/seo.js
//
// The SEO, AEO and GEO dashboard screen in /admin (admins only). Plain JS,
// no outside scripts, charts drawn as SVG. Data comes from /api/seo.
// admin.js calls window.ATISEO.render(mainElement) when the menu item is
// clicked.

(function () {
  'use strict';

  var TABS = [
    ['overview', 'Overview'], ['improve', 'How to Improve'], ['pages', 'Pages'], ['links', 'Internal Links'], ['keywords', 'Keywords'],
    ['rankings', 'Rankings'], ['analytics', 'Analytics'], ['recs', 'Recommendations'], ['audit', 'Site Audit'],
  ];
  var SEV = { critical: 0, high: 1, medium: 2, low: 3 };
  var EVENT_LABELS = { generate_lead: 'Quote requests', phone_click: 'Phone taps', calculator_quote: 'Calculator quotes', file_download: 'PDF downloads' };

  var S = {
    tab: 'overview', core: null, search: null, analytics: null, err: {}, loading: {},
    pages: { q: '', type: 'all', sort: 'clicks', fixesOnly: false, open: {} },
    recs: { status: 'open', q: '', sev: '', pillar: '', source: '', sel: {} },
    kw: { q: '' }, auditOpen: {}, linksOpen: {}, busy: {}, msg: {},
  };
  var root = null;

  // ---------- helpers ----------

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'text') n.textContent = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return n;
  }

  function api(url, opts) {
    return fetch(url, opts).then(function (res) {
      if (res.status === 401) { window.location.href = '/admin/login.html'; throw new Error('Please log in again.'); }
      return res.json().catch(function () { return {}; }).then(function (d) {
        if (!res.ok) throw new Error(d.error || ('Something went wrong (' + res.status + ').'));
        return d;
      });
    });
  }
  function post(body) {
    return api('/api/seo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  function num(n, d) {
    if (n == null || isNaN(n)) return '–';
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: d == null ? 0 : d, minimumFractionDigits: d || 0 });
  }
  function pctTxt(x, d) { return x == null ? '–' : num(x * 100, d == null ? 1 : d) + '%'; }
  function ago(iso) {
    if (!iso) return 'never';
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 86400 * 45) return Math.round(s / 86400) + 'd ago';
    return Math.round(s / 86400 / 30) + 'mo ago';
  }
  function shortDate(iso) { if (!iso) return ''; var d = new Date(iso + (iso.length === 10 ? 'T12:00:00Z' : '')); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); }
  function scoreClass(v) { return v == null ? 'sd-na' : v >= 90 ? 'sd-good' : v >= 70 ? 'sd-ok' : 'sd-bad'; }
  function scoreTxt(v) { return el('span', { class: scoreClass(v) }, [v == null ? '–' : String(v)]); }
  function scores(s) {
    return el('span', { class: 'sd-scores' }, [scoreTxt(s.seo), el('span', { class: 'sep' }, ['·']), scoreTxt(s.aeo), el('span', { class: 'sep' }, ['·']), scoreTxt(s.geo)]);
  }
  function delta(cur, prev, lowerBetter) {
    if (cur == null || prev == null || prev === 0) return null;
    var ch = (cur - prev) / prev;
    var good = lowerBetter ? ch < 0 : ch > 0;
    var cls = Math.abs(ch) < 0.005 ? 'flat' : good ? 'up' : 'down';
    return el('span', { class: 'sd-delta ' + cls, title: 'Compared with the 28 days before' }, [(ch > 0 ? '+' : '') + Math.round(ch * 100) + '%']);
  }
  function kpi(n, label, sub, extra, bad) {
    return el('div', { class: 'sd-kpi' }, [
      el('div', { class: 'sd-kpi-n' + (bad ? ' is-bad' : '') }, [String(n), extra || null]),
      el('div', { class: 'sd-kpi-l' }, [label]),
      sub ? el('div', { class: 'sd-kpi-s' }, [sub]) : null,
    ]);
  }
  function card(kids, cls) { return el('div', { class: 'sd-card' + (cls ? ' ' + cls : '') }, kids); }
  function loading(text) { return el('div', { class: 'sd-loading' }, [el('div', { class: 'sd-spinner' }), text || 'Loading…']); }
  function errorBox(text) { return el('div', { class: 'error-msg' }, [text]); }
  function pathLink(path) {
    return el('a', { class: 'sd-path', href: (S.core ? S.core.site : '') + path, target: '_blank', rel: 'noopener', onClick: function (e) { e.stopPropagation(); } }, [path + ' ↗']);
  }
  function pageTitle(path) {
    var p = S.core && S.core.pages.find(function (x) { return x.path === path; });
    return p ? p.title : path;
  }
  function openEditor(title) {
    var btns = document.querySelectorAll('#pages-list .nav-item, #posts-list .nav-item');
    for (var i = 0; i < btns.length; i++) if (btns[i].textContent === title) { btns[i].click(); return; }
    alert('Couldn’t find that page in the editor list.');
  }

  // ---------- charts ----------

  function lineChart(series, labels, opts) {
    opts = opts || {};
    var W = 760, H = opts.height || 220, L = 40, R = 12, T = 12, B = 26;
    var max = 0;
    series.forEach(function (s) { s.values.forEach(function (v) { if (v != null && v > max) max = v; }); });
    max = max <= 0 ? 1 : max;
    var step = Math.pow(10, Math.floor(Math.log10(max)));
    var top = Math.ceil(max / step) * step;
    if (top / step < 3) top = Math.ceil(max / (step / 2)) * (step / 2);
    // Pick 4 or 5 gridlines so the labels are round numbers.
    var div = [4, 5, 3, 6].find(function (k) { var v = top / k; return Math.abs(v - Math.round(v)) < 1e-9 && (v >= 1 ? true : top <= 5); }) || 4;
    var n = labels.length;
    var x = function (i) { return L + (n <= 1 ? 0 : (i * (W - L - R)) / (n - 1)); };
    var y = function (v) { return T + (H - T - B) * (1 - v / top); };
    var parts = ['<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + (opts.label || 'Chart') + '">'];
    for (var g = 0; g <= div; g++) {
      var gv = (top * g) / div;
      parts.push('<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(gv) + '" y2="' + y(gv) + '" stroke="#eef0f3"/>');
      parts.push('<text x="' + (L - 6) + '" y="' + (y(gv) + 3) + '" text-anchor="end">' + num(gv, gv < 10 && top < 10 ? 1 : 0) + '</text>');
    }
    var every = Math.max(1, Math.ceil(n / 8));
    labels.forEach(function (lb, i) { if (i % every === 0 || i === n - 1) parts.push('<text x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + lb + '</text>'); });
    series.forEach(function (s) {
      var d = '';
      s.values.forEach(function (v, i) { if (v == null) return; d += (d ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); });
      if (s.fill && d) parts.push('<path d="' + d + 'L' + x(n - 1) + ' ' + y(0) + 'L' + x(0) + ' ' + y(0) + 'Z" fill="' + s.color + '" opacity=".08"/>');
      parts.push('<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2.2" stroke-linejoin="round"/>');
      if (n <= 16) s.values.forEach(function (v, i) { if (v != null) parts.push('<circle cx="' + x(i) + '" cy="' + y(v) + '" r="3" fill="#fff" stroke="' + s.color + '" stroke-width="2"/>'); });
    });
    parts.push('</svg>');
    return el('div', { class: 'sd-chart', html: parts.join('') });
  }

  // Positions: lower is better, so the line goes up when the ranking improves.
  function spark(values) {
    var W = 120, H = 30;
    var pts = values.map(function (v, i) { return { v: v, i: i }; }).filter(function (p) { return p.v != null; });
    if (pts.length < 2) return el('span', { class: 'sd-na' }, [pts.length ? 'one week' : '–']);
    var min = Math.min.apply(null, pts.map(function (p) { return p.v; }));
    var max = Math.max.apply(null, pts.map(function (p) { return p.v; }));
    var span = Math.max(1, max - min);
    var x = function (i) { return 3 + (i * (W - 6)) / (values.length - 1); };
    var y = function (v) { return 3 + ((v - min) / span) * (H - 6); };
    var d = pts.map(function (p, k) { return (k ? 'L' : 'M') + x(p.i).toFixed(1) + ' ' + y(p.v).toFixed(1); }).join('');
    var last = pts[pts.length - 1];
    return el('span', { html: '<svg class="sd-spark" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true"><path d="' + d + '" fill="none" stroke="#00703a" stroke-width="2"/><circle cx="' + x(last.i) + '" cy="' + y(last.v) + '" r="2.8" fill="#00703a"/></svg>' });
  }

  // ---------- loading data ----------

  function load(view, force) {
    if (S.loading[view]) return;
    if (S[view] && !force) return;
    S.loading[view] = true;
    S.err[view] = '';
    draw();
    api('/api/seo?view=' + view).then(function (d) {
      S[view] = d;
    }).catch(function (e) {
      S.err[view] = e.message;
    }).then(function () {
      S.loading[view] = false;
      draw();
    });
  }
  function refreshAll() {
    S.search = null; S.analytics = null;
    load('core', true);
    if (S.tab === 'keywords' || S.tab === 'rankings') load('search', true);
    if (S.tab === 'analytics') load('analytics', true);
  }

  // ---------- frame ----------

  function draw() {
    if (!root) return;
    var scrollY = window.scrollY;
    root.innerHTML = '';
    var c = S.core;
    var openCount = c ? c.recs.filter(function (r) { return r.status === 'open'; }).length : 0;
    var wrap = el('div', { class: 'sd' }, [
      el('div', { class: 'sd-head' }, [
        el('div', {}, [el('p', { class: 'sd-eyebrow' }, [c ? c.site.replace(/^https?:\/\//, '') : 'ati-products.com']), el('h1', { class: 'sd-title' }, ['SEO · AEO · GEO'])]),
        el('div', { class: 'sd-updated' }, [
          c ? 'Checked ' + ago(c.generatedAt) : '',
          el('button', { class: 'sd-btn sd-btn-sm', type: 'button', onClick: refreshAll, disabled: S.loading.core ? true : null }, [S.loading.core ? 'Checking…' : '↻ Refresh']),
        ]),
      ]),
      el('div', { class: 'sd-tabs', role: 'tablist' }, TABS.map(function (t) {
        return el('button', {
          class: 'sd-tab' + (S.tab === t[0] ? ' is-active' : ''), type: 'button', role: 'tab', 'aria-selected': S.tab === t[0] ? 'true' : 'false',
          onClick: function () { S.tab = t[0]; if (t[0] === 'keywords' || t[0] === 'rankings') load('search'); if (t[0] === 'analytics') load('analytics'); draw(); window.scrollTo(0, 0); },
        }, [t[1], t[0] === 'recs' && openCount ? el('span', { class: 'sd-count' }, [String(openCount)]) : null]);
      })),
    ]);
    var body;
    if (!c && S.err.core) body = errorBox(S.err.core);
    else if (!c) body = loading('Checking every page on the live site… this takes about 10 seconds.');
    else body = ({ overview: viewOverview, improve: viewImprove, pages: viewPages, links: viewLinks, keywords: viewKeywords, rankings: viewRankings, analytics: viewAnalytics, recs: viewRecs, audit: viewAudit })[S.tab]();
    wrap.appendChild(body);
    root.appendChild(wrap);
    window.scrollTo(0, scrollY);
  }

  function setupNotice(what) {
    var conn = S.core ? S.core.connections : {};
    var steps = [];
    if (!conn.google) steps.push(el('li', {}, ['Create a Google service account and add its key as GOOGLE_SERVICE_ACCOUNT_JSON in Vercel (SETUP.md, “SEO dashboard”, step 1).']));
    if (what === 'search' && conn.google) steps.push(el('li', {}, ['Add ', el('b', {}, [conn.googleEmail]), ' as a Full user in Search Console (Settings, Users and permissions).']));
    if (what === 'analytics') {
      if (!conn.gaMeasurementId) steps.push(el('li', {}, ['Paste your GA4 measurement ID (G-…) below under Connections so the site starts counting visitors.']));
      if (!conn.gaPropertyId) steps.push(el('li', {}, ['Paste your GA4 property ID (a number) under Connections so the dashboard can read the counts.']));
      if (conn.google) steps.push(el('li', {}, ['In Google Analytics, Admin, Property access management, add ', el('b', {}, [conn.googleEmail || 'the service account']), ' as a Viewer.']));
    }
    return el('div', { class: 'sd-setup' }, [
      el('b', {}, [what === 'analytics' ? 'Google Analytics isn’t connected yet.' : 'Search Console isn’t connected yet.']),
      ' Everything else on this dashboard already works. To fill this in:',
      el('ol', {}, steps),
    ]);
  }

  // ---------- Overview ----------

  function runPageSpeed(strategy, paths) {
    S.busy.ps = true; S.msg.ps = ''; draw();
    post({ action: 'pagespeed', strategy: strategy || 'mobile', paths: paths || null }).then(function (r) {
      Object.keys(r.results || {}).forEach(function (p) {
        var pg = S.core.pages.find(function (x) { return x.path === p; });
        if (pg) pg.speed = r.results[p];
      });
      S.msg.ps = 'Measured ' + r.measured.join(', ') + (r.errors.length ? '. ' + r.errors.length + ' failed: ' + r.errors[0].error : '') + (r.remaining ? '. ' + r.remaining + ' page(s) still need measuring this week.' : '. All pages are measured.');
      S.psRemaining = r.remaining;
      S.core.runs.pagespeed = { at: new Date().toISOString(), by: 'you' };
      recompute();
    }).catch(function (e) { S.msg.ps = e.message; }).then(function () { S.busy.ps = false; draw(); });
  }
  // Keeps measuring 3 pages at a time until every page has a speed score
  // from the last 7 days. The page has to stay open while it runs.
  function measureAll() {
    if (S.busy.ps) return;
    S.busy.ps = true; S.busy.all = true; S.stopAll = false;
    S.msg.ps = 'Starting… keep this page open.';
    draw();
    var measured = {}, failed = 0, lastErr = '', rounds = 0;
    var done = 0;
    var finish = function (prefix) {
      S.busy.ps = false; S.busy.all = false;
      S.msg.ps = prefix + 'Measured ' + done + ' page(s)' + (failed ? ', ' + failed + ' failed (' + lastErr + ')' : '') +
        (S.psRemaining ? '. ' + S.psRemaining + ' page(s) still to measure.' : '. Every page has a speed score.');
      S.core.runs.pagespeed = { at: new Date().toISOString(), by: 'you' };
      draw();
      recompute();
    };
    var step = function () {
      if (S.stopAll) return finish('Stopped. ');
      rounds++;
      post({ action: 'pagespeed', strategy: 'mobile' }).then(function (r) {
        Object.keys(r.results || {}).forEach(function (p) {
          var pg = S.core.pages.find(function (x) { return x.path === p; });
          if (pg) pg.speed = r.results[p];
        });
        r.measured.forEach(function (p) { if (!r.errors.some(function (x) { return x.path === p; })) measured[p] = true; });
        done = Object.keys(measured).length;
        failed += r.errors.length;
        if (r.errors.length) lastErr = r.errors[0].error;
        S.psRemaining = r.remaining;
        var progressed = r.errors.length < r.measured.length;
        if (r.remaining > 0 && progressed && rounds < 20 && !S.stopAll) {
          S.msg.ps = 'Measuring… ' + done + ' done, ' + r.remaining + ' to go (about ' + Math.max(1, Math.round(Math.ceil(r.remaining / 3) * 0.5)) + ' min left). Keep this page open.';
          draw();
          step();
        } else {
          finish(S.stopAll ? 'Stopped. ' : '');
        }
      }).catch(function (e) { lastErr = e.message; failed++; finish(''); });
    };
    step();
  }
  function speedButtons(primaryLabel) {
    if (S.busy.all) {
      return [el('button', { class: 'sd-btn sd-btn-sm', type: 'button', onClick: function () { S.stopAll = true; S.msg.ps = 'Stopping after the current 3 pages…'; draw(); } }, ['Stop'])];
    }
    return [
      el('button', { class: 'sd-btn sd-btn-sm sd-btn-primary', type: 'button', disabled: S.busy.ps ? true : null, onClick: measureAll }, [primaryLabel || 'Measure all']),
      el('button', { class: 'sd-btn sd-btn-sm', type: 'button', disabled: S.busy.ps ? true : null, onClick: function () { runPageSpeed('mobile'); } }, [S.busy.ps ? 'Measuring…' : 'Measure the 3 oldest']),
    ];
  }
  function runIndex() {
    S.busy.idx = true; S.msg.idx = ''; draw();
    post({ action: 'index' }).then(function (r) {
      S.msg.idx = 'Checked ' + Object.keys(r.index).length + ' pages with Google.' + (r.errors.length ? ' ' + r.errors.length + ' failed.' : '');
      load('core', true);
    }).catch(function (e) { S.msg.idx = e.message; }).then(function () { S.busy.idx = false; draw(); });
  }
  // After measuring speed, refresh the scores without re-checking every page.
  function recompute() { setTimeout(function () { load('core', true); }, 300); }

  function viewOverview() {
    var c = S.core, sm = c.summary;
    var open = c.recs.filter(function (r) { return r.status === 'open'; });
    var urgent = open.filter(function (r) { return r.severity === 'critical' || r.severity === 'high'; });
    var counts = { critical: 0, high: 0, medium: 0, low: 0 };
    open.forEach(function (r) { counts[r.severity]++; });
    var out = el('div', {}, []);
    out.appendChild(el('div', { class: 'sd-kpis' }, [
      kpi(sm.scored + '/' + sm.pages, 'Pages scored', c.failedFetch.length ? c.failedFetch.length + ' couldn’t be read' : 'every page in the admin'),
      pillarKpi('seo', sm.seo, 'Avg SEO', 'classic search'),
      pillarKpi('aeo', sm.aeo, 'Avg AEO', 'answer engines'),
      pillarKpi('geo', sm.geo, 'Avg GEO', 'AI citations'),
      kpi(sm.speed == null ? '–' : sm.speed, 'Mobile speed', sm.speedMeasured ? 'PageSpeed, ' + sm.speedMeasured + ' of ' + sm.pages + ' measured' : 'not measured yet'),
      kpi(open.length, 'Open recommendations', urgent.length + ' critical or high', null, urgent.length > 0),
    ]));
    var alerts = card([
      el('p', { class: 'sd-label' }, ['Open recommendations']),
      el('p', { class: 'sd-note', style: 'margin-top:6px' }, [
        el('span', { class: 'sd-bad' }, [counts.critical + ' critical']), ' · ', el('span', { style: 'color:#c2410c' }, [counts.high + ' high']), ' · ' + counts.medium + ' medium · ' + counts.low + ' low · ',
        el('button', { class: 'sd-link', type: 'button', onClick: function () { S.tab = 'recs'; S.recs.status = 'open'; draw(); } }, ['open the list']),
      ]),
      el('ul', { class: 'sd-alerts' }, open.slice(0, 6).map(function (r) {
        return el('li', {}, [el('span', { class: 'sd-dot ' + r.severity }), el('div', {}, [el('b', {}, [r.title]), ' ', r.finding, ' ', el('span', { class: 'sd-path' }, [r.path])])]);
      })),
      open.length ? null : el('p', { class: 'sd-note' }, ['Nothing open. Nice work.']),
    ]);
    var ps = c.runs.pagespeed, ix = c.runs.index, cr = c.runs.cron;
    var actions = card([
      el('p', { class: 'sd-label' }, ['Checks']),
      el('p', { class: 'sd-note', style: 'margin:6px 0 14px' }, ['Page scores update every time this dashboard opens. Speed and Google’s index status are measured separately because they take longer.']),
      el('div', { class: 'sd-actions' }, [
        S.busy.all
          ? el('button', { class: 'sd-btn', type: 'button', onClick: function () { S.stopAll = true; S.msg.ps = 'Stopping after the current 3 pages…'; draw(); } }, ['Stop measuring'])
          : el('button', { class: 'sd-btn sd-btn-primary', type: 'button', disabled: S.busy.ps ? true : null, onClick: measureAll }, [S.busy.ps ? 'Measuring…' : 'Measure speed of every page (about 4 minutes)']),
        el('button', { class: 'sd-btn', type: 'button', disabled: S.busy.idx || !c.connections.google ? true : null, onClick: runIndex, title: c.connections.google ? '' : 'Connect Google first' }, [S.busy.idx ? 'Asking Google…' : 'Check Google index status']),
      ]),
      S.msg.ps ? el('p', { class: 'sd-msg' }, [S.msg.ps]) : null,
      S.msg.idx ? el('p', { class: 'sd-msg' }, [S.msg.idx]) : null,
      el('ul', { class: 'sd-conn', style: 'margin-top:12px' }, [
        el('li', {}, [el('span', { class: 'sd-dot ' + (ps ? 'on' : 'off') }), el('div', {}, ['Speed last measured ', el('b', {}, [ago(ps && ps.at)]), ps && ps.by ? el('small', {}, ['by ' + ps.by]) : null])]),
        el('li', {}, [el('span', { class: 'sd-dot ' + (ix ? 'on' : 'off') }), el('div', {}, ['Index last checked ', el('b', {}, [ago(ix && ix.at)])])]),
        el('li', {}, [el('span', { class: 'sd-dot ' + (cr ? (cr.ok ? 'on' : 'err') : 'off') }), el('div', {}, ['Daily automatic check ', el('b', {}, [cr ? ago(cr.at) : (c.connections.cronSecret ? 'waiting for first run' : 'off')]), el('small', {}, [cr ? cr.steps.join(' · ') : (c.connections.cronSecret ? 'Runs every morning.' : 'Add CRON_SECRET in Vercel to turn it on (SETUP.md).')])])]),
      ]),
    ]);
    out.appendChild(el('div', { class: 'sd-two' }, [alerts, actions]));

    var sc = c.search, ga = c.analytics;
    out.appendChild(el('div', { class: 'sd-section-h' }, ['Search and traffic, last 28 days', sc.window ? el('span', {}, [sc.window.current.startDate + ' to ' + sc.window.current.endDate + ' vs ' + sc.window.previous.startDate + ' to ' + sc.window.previous.endDate]) : null]));
    if (sc.error) out.appendChild(errorBox(sc.error));
    if (ga.error) out.appendChild(errorBox(ga.error));
    var cur = sc.current || {}, prev = sc.previous || {}, g = ga.current || {}, gp = ga.previous || {};
    out.appendChild(el('div', { class: 'sd-kpis' }, [
      kpi(sc.current ? num(cur.clicks) : '–', 'Clicks', 'Search Console', delta(cur.clicks, prev.clicks)),
      kpi(sc.current ? num(cur.impressions) : '–', 'Impressions', 'Search Console', delta(cur.impressions, prev.impressions)),
      kpi(sc.current && cur.position ? num(cur.position, 1) : '–', 'Avg position', 'lower is better', delta(cur.position, prev.position, true)),
      kpi(ga.current ? num(g.users) : '–', 'Users', 'Analytics', delta(g.users, gp.users)),
      kpi(ga.current ? num(g.sessions) : '–', 'Sessions', 'Analytics', delta(g.sessions, gp.sessions)),
    ]));
    if (!sc.connected) out.appendChild(setupNotice('search'));
    out.appendChild(connectionsCard());
    return out;
  }

  function connectionsCard() {
    var c = S.core.connections;
    var mid = el('input', { class: 'sd-input', id: 'sd-ga-mid', placeholder: 'G-XXXXXXXXXX', value: c.gaMeasurementId || '' });
    var pid = el('input', { class: 'sd-input', id: 'sd-ga-pid', placeholder: '412345678', value: c.gaPropertyId || '', inputmode: 'numeric' });
    var save = el('button', { class: 'sd-btn sd-btn-primary', type: 'button', disabled: S.busy.settings ? true : null, onClick: function () {
      S.busy.settings = true; S.msg.settings = null; draw();
      post({ action: 'settings', gaMeasurementId: mid.value, gaPropertyId: pid.value }).then(function (r) {
        S.core.connections.gaMeasurementId = r.settings.gaMeasurementId;
        S.core.connections.gaPropertyId = r.settings.gaPropertyId;
        S.analytics = null;
        S.msg.settings = { ok: true, text: r.siteUpdated ? 'Saved. The website is updating with the new tracking setting (live in about a minute).' : 'Saved.' };
      }).catch(function (e) { S.msg.settings = { ok: false, text: e.message }; }).then(function () { S.busy.settings = false; draw(); });
    } }, [S.busy.settings ? 'Saving…' : 'Save']);
    var dot = function (on, err) { return el('span', { class: 'sd-dot ' + (err ? 'err' : on ? 'on' : 'off') }); };
    return card([
      el('p', { class: 'sd-label' }, ['Connections']),
      el('ul', { class: 'sd-conn', style: 'margin-top:8px' }, [
        el('li', {}, [dot(c.google, c.googleError), el('div', {}, [el('b', {}, ['Google account (service account)']), el('small', {}, [c.googleError || (c.google ? c.googleEmail : 'Not connected. Add GOOGLE_SERVICE_ACCOUNT_JSON in Vercel.')])])]),
        el('li', {}, [dot(S.core.search.connected && !S.core.search.error, S.core.search.error), el('div', {}, [el('b', {}, ['Search Console']), el('small', {}, [S.core.search.error || (S.core.search.connected ? 'Reading ' + c.gscSite : 'Needs the Google account above.')])])]),
        el('li', {}, [dot(!!c.gaMeasurementId), el('div', {}, [el('b', {}, ['Google Analytics tracking']), el('small', {}, [c.gaMeasurementId ? 'Counting visitors with ' + c.gaMeasurementId : 'Off. Paste the measurement ID below to start counting visitors.'])])]),
        el('li', {}, [dot(S.core.analytics.connected && !S.core.analytics.error, S.core.analytics.error), el('div', {}, [el('b', {}, ['Google Analytics reports']), el('small', {}, [S.core.analytics.error || (S.core.analytics.connected ? 'Reading property ' + c.gaPropertyId : 'Paste the property ID below.')])])]),
        el('li', {}, [dot(c.pagespeedKey), el('div', {}, [el('b', {}, ['PageSpeed key']), el('small', {}, [c.pagespeedKey ? 'Connected.' : 'Optional. Without PAGESPEED_API_KEY in Vercel, Google allows only a few measurements a day.'])])]),
        el('li', {}, [dot(c.cronSecret), el('div', {}, [el('b', {}, ['Daily automatic check']), el('small', {}, [c.cronSecret ? 'On: checks index status and measures 3 pages every morning.' : 'Off. Add CRON_SECRET in Vercel to turn it on.'])])]),
      ]),
      el('div', { class: 'sd-form-row' }, [
        el('div', {}, [el('label', { for: 'sd-ga-mid' }, ['GA4 measurement ID']), mid]),
        el('div', {}, [el('label', { for: 'sd-ga-pid' }, ['GA4 property ID']), pid]),
        save,
      ]),
      S.msg.settings ? el('p', { class: 'sd-msg ' + (S.msg.settings.ok ? 'ok' : 'err') }, [S.msg.settings.text]) : null,
      el('p', { class: 'sd-note', style: 'margin-top:10px' }, ['Dashboard data is saved on the GitHub branch “' + c.dataBranch + '”, which is never published, so saving here doesn’t rebuild the website (except changing the measurement ID, which updates the site’s tracking file).']),
    ]);
  }

  // ---------- Pages ----------

  function speedCell(p) {
    var m = p.speed && p.speed.mobile;
    if (m && m.perf != null) return el('span', { class: scoreClass(m.perf), title: 'Mobile PageSpeed, measured ' + ago(m.at) + (m.lcp ? '. LCP ' + (m.lcp / 1000).toFixed(1) + 's' : '') }, [String(m.perf)]);
    return el('button', { class: 'sd-btn sd-btn-sm', type: 'button', disabled: S.busy.ps ? true : null, onClick: function (e) { e.stopPropagation(); runPageSpeed('mobile', [p.path]); } }, ['Speed']);
  }
  function indexCell(p) {
    var r = p.index;
    if (!r) return el('span', { class: 'sd-idx' }, [el('span', { class: 'sd-na' }, ['Not checked'])]);
    var good = /indexed/i.test(r.coverageState) && !/not indexed/i.test(r.coverageState);
    return el('div', { class: 'sd-idx ' + (good ? 'good' : 'bad') }, [
      r.coverageState || r.verdict,
      r.lastCrawlTime ? el('small', {}, ['crawled ' + ago(r.lastCrawlTime)]) : null,
      good ? null : el('a', { href: consoleHome(), title: 'Copies this page’s address and opens Search Console. Paste it into the “Inspect any URL” bar at the top, then click Request indexing.', target: '_blank', rel: 'noopener', class: 'sd-link', style: 'font-size:12px', onClick: function (e) {
        e.stopPropagation();
        var a = e.currentTarget;
        copyText(p.url);
        a.textContent = 'Address copied. Paste it in the top bar ↗';
      } }, ['Request indexing ↗']),
    ]);
  }
  // Search Console's own page links (inspect?id=...) can 404, so this opens
  // the property's home page and puts the page address on the clipboard to
  // paste into the "Inspect any URL" bar. Google only allows the request by hand.
  function consoleHome() {
    var site = (S.core && S.core.connections && S.core.connections.gscSite) || 'sc-domain:ati-products.com';
    return 'https://search.google.com/search-console?resource_id=' + encodeURIComponent(site);
  }
  function copyText(t) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).catch(function () { copyFallback(t); }); } catch (e) {}
    copyFallback(t);
  }
  function copyFallback(t) {
    var ta = document.createElement('textarea');
    ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }
  function checksList(checks, pillar) {
    return el('div', {}, [
      el('h4', {}, [pillar]),
      el('ul', { class: 'sd-checks' }, checks.filter(function (c) { return c.pillar === pillar; }).map(function (c) {
        var cls = c.pass === true ? 'pass' : c.pass === false ? 'fail' : 'na';
        return el('li', {}, [el('span', { class: 'sd-i ' + cls }, [c.pass === true ? '✓' : c.pass === false ? '!' : '–']), el('div', {}, [c.label, c.pass === false ? el('small', {}, [c.fix]) : c.pass === null ? el('small', {}, [c.note || 'Not checked yet.']) : null])]);
      })),
    ]);
  }

  function viewPages() {
    var c = S.core, u = S.pages;
    var list = c.pages.slice();
    var q = u.q.trim().toLowerCase();
    if (q) list = list.filter(function (p) { return (p.title + ' ' + p.path + ' ' + p.seoTitle).toLowerCase().indexOf(q) > -1; });
    if (u.type !== 'all') list = list.filter(function (p) { return u.type === 'posts' ? p.isPost : !p.isPost; });
    if (u.fixesOnly) list = list.filter(function (p) { return p.checks.some(function (x) { return x.pass === false && (x.severity === 'critical' || x.severity === 'high'); }); });
    var sorters = {
      clicks: function (a, b) { return ((b.search && b.search.clicks) || 0) - ((a.search && a.search.clicks) || 0) || ((b.search && b.search.impressions) || 0) - ((a.search && a.search.impressions) || 0); },
      seo: function (a, b) { return (a.scores.seo || 0) - (b.scores.seo || 0); },
      aeo: function (a, b) { return (a.scores.aeo || 0) - (b.scores.aeo || 0); },
      geo: function (a, b) { return (a.scores.geo || 0) - (b.scores.geo || 0); },
      speed: function (a, b) { var x = a.speed && a.speed.mobile ? a.speed.mobile.perf : 999, y = b.speed && b.speed.mobile ? b.speed.mobile.perf : 999; return x - y; },
      title: function (a, b) { return a.title.localeCompare(b.title); },
    };
    list.sort(sorters[u.sort]);
    var searchInput = el('input', { class: 'sd-input sd-grow', placeholder: 'Search title or address…', value: u.q, onInput: function (e) { u.q = e.target.value; redrawKeepFocus('sd-pq'); }, id: 'sd-pq' });
    var unmeasured = c.pages.filter(function (p) { return !(p.speed && p.speed.mobile); }).length;
    var rows = [];
    list.forEach(function (p) {
      var open = !!u.open[p.path];
      rows.push(el('tr', { class: 'sd-click' + (open ? ' sd-open' : ''), onClick: function () { u.open[p.path] = !open; draw(); } }, [
        el('td', {}, [el('div', { class: 'sd-pt' }, [p.title]), pathLink(p.path), p.topFix ? el('div', { class: 'sd-fix' }, [p.topFix]) : el('div', { class: 'sd-fix sd-good' }, ['No high-priority fixes.'])]),
        el('td', {}, [p.isPost ? 'Blog post' : 'Page']),
        el('td', {}, [scores(p.scores)]),
        el('td', { class: 'num' }, [speedCell(p)]),
        el('td', { class: 'num' }, [p.search ? num(p.search.clicks) : '–']),
        el('td', { class: 'num' }, [p.search ? num(p.search.impressions) : '–']),
        el('td', {}, [indexCell(p)]),
        el('td', { class: 'num' }, [num(p.words)]),
      ]));
      if (open) {
        rows.push(el('tr', { class: 'sd-open' }, [el('td', { colspan: '8' }, [
          el('div', { class: 'sd-detail' }, [checksList(p.checks, 'SEO'), checksList(p.checks, 'AEO'), checksList(p.checks, 'GEO')]),
          el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin-top:10px' }, [
            el('button', { class: 'sd-btn sd-btn-sm sd-btn-primary', type: 'button', onClick: function () { openEditor(p.title); } }, ['Open in the editor']),
            el('button', { class: 'sd-btn sd-btn-sm', type: 'button', disabled: S.busy.ps ? true : null, onClick: function () { runPageSpeed('mobile', [p.path]); } }, ['Measure speed again']),
            p.speed && p.speed.mobile ? el('span', { class: 'sd-note', style: 'align-self:center' }, ['Mobile: ' + p.speed.mobile.perf + ' performance, ' + p.speed.mobile.a11y + ' accessibility, LCP ' + (p.speed.mobile.lcp / 1000).toFixed(1) + 's, measured ' + ago(p.speed.mobile.at)]) : null,
          ]),
        ])]));
      }
    });
    return el('div', {}, [
      el('div', { class: 'sd-filters' }, [
        searchInput,
        el('select', { class: 'sd-select', 'aria-label': 'Type', onChange: function (e) { u.type = e.target.value; draw(); } }, [['all', 'All types'], ['pages', 'Pages'], ['posts', 'Blog posts']].map(function (o) { return el('option', { value: o[0], selected: u.type === o[0] ? true : null }, [o[1]]); })),
        el('select', { class: 'sd-select', 'aria-label': 'Sort', onChange: function (e) { u.sort = e.target.value; draw(); } }, [['clicks', 'Most clicks (28d)'], ['seo', 'Lowest SEO'], ['aeo', 'Lowest AEO'], ['geo', 'Lowest GEO'], ['speed', 'Slowest'], ['title', 'Title A to Z']].map(function (o) { return el('option', { value: o[0], selected: u.sort === o[0] ? true : null }, [o[1]]); })),
        el('label', { class: 'sd-check' }, [el('input', { type: 'checkbox', checked: u.fixesOnly ? true : null, onChange: function (e) { u.fixesOnly = e.target.checked; draw(); } }), 'Only pages with high-priority fixes']),
        el('span', { class: 'sd-note' }, [list.length + ' of ' + c.pages.length + ' pages']),
      ]),
      el('div', { class: 'sd-bulk' }, [
        el('b', {}, ['SPEED']),
      ].concat(speedButtons('Measure all'), [
        S.busy.all ? '' : unmeasured ? unmeasured + ' page(s) not measured yet · “Measure all” takes about ' + Math.max(1, Math.round(Math.ceil(unmeasured / 3) * 0.5)) + ' min' : 'Every page has a mobile speed score.',
        S.msg.ps ? el('span', {}, [' · ' + S.msg.ps]) : null,
      ])),
      el('div', { class: 'sd-table-wrap' }, [el('table', { class: 'sd-table' }, [
        el('thead', {}, [el('tr', {}, [el('th', {}, ['Page']), el('th', {}, ['Type']), el('th', {}, ['SEO · AEO · GEO']), el('th', { class: 'num' }, ['Speed']), el('th', { class: 'num' }, ['Clicks 28d']), el('th', { class: 'num' }, ['Impr. 28d']), el('th', {}, ['Google index']), el('th', { class: 'num' }, ['Words'])])]),
        el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { colspan: '8', class: 'sd-empty' }, ['No pages match.'])])]),
      ])]),
      el('p', { class: 'sd-note', style: 'margin-top:10px' }, ['Click a page to see every check. Scores: 90+ green, 70 to 89 amber, under 70 red.']),
    ]);
  }

  function redrawKeepFocus(id) {
    var node = document.getElementById(id);
    var pos = node ? node.selectionStart : null;
    draw();
    var again = document.getElementById(id);
    if (again) { again.focus(); if (pos != null) again.setSelectionRange(pos, pos); }
  }

  // ---------- Internal links ----------

  function viewLinks() {
    var c = S.core;
    var list = c.pages.slice().sort(function (a, b) { return a.inbound - b.inbound || a.title.localeCompare(b.title); });
    var orphans = list.filter(function (p) { return p.inbound === 0 && p.path !== '/'; }).length;
    var weak = list.filter(function (p) { return p.inbound === 1 && p.path !== '/'; }).length;
    var rows = [];
    list.forEach(function (p) {
      var open = !!S.linksOpen[p.path];
      var state = p.path === '/' ? ['good', 'Homepage'] : p.inbound === 0 ? ['bad', 'No links'] : p.inbound === 1 ? ['high', 'Weak'] : ['good', 'Good'];
      rows.push(el('tr', { class: 'sd-click' + (open ? ' sd-open' : ''), onClick: function () { S.linksOpen[p.path] = !open; draw(); } }, [
        el('td', {}, [el('div', { class: 'sd-pt' }, [p.title]), pathLink(p.path)]),
        el('td', { class: 'num' }, [String(p.inbound)]),
        el('td', { class: 'num' }, [String(p.inboundAll)]),
        el('td', { class: 'num' }, [String(p.outbound.length)]),
        el('td', {}, [el('span', { class: 'sd-pill ' + state[0] }, [state[1]])]),
      ]));
      if (open) rows.push(el('tr', { class: 'sd-open' }, [el('td', { colspan: '5' }, [el('div', { class: 'sd-detail' }, [
        el('div', {}, [el('h4', {}, ['Linked from (in the content)']), p.linkedFrom.length ? el('ul', { class: 'sd-checks' }, p.linkedFrom.map(function (f) { return el('li', {}, [pageTitle(f) + ' ', el('span', { class: 'sd-path' }, [f])]); })) : el('p', { class: 'sd-note' }, ['No other page links here from its content.'])]),
        el('div', {}, [el('h4', {}, ['Links out to']), p.outbound.length ? el('ul', { class: 'sd-checks' }, p.outbound.map(function (f) { return el('li', {}, [pageTitle(f) + ' ', el('span', { class: 'sd-path' }, [f])]); })) : el('p', { class: 'sd-note' }, ['No links to other pages in the content.'])]),
      ])])]));
    });
    var opps = c.links.opportunities;
    return el('div', {}, [
      el('div', { class: 'sd-kpis' }, [
        kpi(c.pages.length, 'Pages', 'in the admin list'),
        kpi(orphans, 'Pages with no links', 'from other pages’ content', null, orphans > 0),
        kpi(weak, 'Weakly linked', 'only one page links in'),
        kpi(opps.length, 'Link opportunities', 'pages that mention a topic but don’t link'),
      ]),
      el('p', { class: 'sd-note', style: 'margin-bottom:12px' }, ['Links inside a page’s own words tell Google which pages matter most. The menu and footer are on every page, so they’re counted separately in “Whole site”.']),
      el('div', { class: 'sd-table-wrap' }, [el('table', { class: 'sd-table' }, [
        el('thead', {}, [el('tr', {}, [el('th', {}, ['Page']), el('th', { class: 'num' }, ['Linked from content']), el('th', { class: 'num' }, ['Whole site']), el('th', { class: 'num' }, ['Links out']), el('th', {}, ['Status'])])]),
        el('tbody', {}, rows),
      ])]),
      el('div', { class: 'sd-section-h' }, ['Link opportunities', el('span', {}, ['Add these links in the editor: select the words, then use the link button.'])]),
      el('div', { class: 'sd-table-wrap' }, [el('table', { class: 'sd-table' }, [
        el('thead', {}, [el('tr', {}, [el('th', {}, ['On this page']), el('th', {}, ['Link the words']), el('th', {}, ['To']), el('th', {}, [''])])]),
        el('tbody', {}, opps.length ? opps.map(function (o) {
          return el('tr', {}, [
            el('td', {}, [el('div', { class: 'sd-pt' }, [o.fromTitle]), el('span', { class: 'sd-path' }, [o.from])]),
            el('td', {}, ['“' + o.phrase + '”']),
            el('td', {}, [el('div', {}, [o.toTitle]), el('span', { class: 'sd-path' }, [o.to])]),
            el('td', { class: 'num' }, [el('button', { class: 'sd-btn sd-btn-sm', type: 'button', onClick: function () { openEditor(o.fromTitle); } }, ['Open in the editor'])]),
          ]);
        }) : [el('tr', {}, [el('td', { colspan: '4', class: 'sd-empty' }, ['No missing links found.'])])]),
      ])]),
    ]);
  }

  // ---------- Keywords ----------

  function trackKeyword(kw) {
    S.busy['t:' + kw] = true; draw();
    post({ action: 'track', keyword: kw }).then(function (r) {
      if (S.core) { S.core.tracked = r.tracked; S.core.trackedIsDefault = false; }
      S.search = null; load('search', true);
    }).catch(function (e) { alert(e.message); }).then(function () { S.busy['t:' + kw] = false; draw(); });
  }
  function untrack(kw) {
    post({ action: 'untrack', keyword: kw }).then(function (r) {
      if (S.core) { S.core.tracked = r.tracked; S.core.trackedIsDefault = false; }
      if (S.search) S.search.rankings = S.search.rankings.filter(function (x) { return x.keyword !== kw; });
      draw();
    }).catch(function (e) { alert(e.message); });
  }
  function isTracked(q) { var t = (S.search && S.search.tracked) || (S.core && S.core.tracked) || []; return t.indexOf(q.toLowerCase()) > -1; }

  function searchGate() {
    if (S.err.search) return errorBox(S.err.search);
    if (!S.search) return loading('Reading Search Console…');
    if (!S.search.connected) return setupNotice('search');
    return null;
  }

  function viewKeywords() {
    var gate = searchGate();
    if (gate) return gate;
    var s = S.search;
    var q = S.kw.q.trim().toLowerCase();
    var top = q ? s.top.filter(function (r) { return r.query.indexOf(q) > -1; }) : s.top;
    var trackBtn = function (query) {
      return isTracked(query) ? el('span', { class: 'sd-pill good' }, ['Tracked']) : el('button', { class: 'sd-btn sd-btn-sm', type: 'button', disabled: S.busy['t:' + query] ? true : null, onClick: function () { trackKeyword(query); } }, ['+ Track']);
    };
    return el('div', {}, [
      card([
        el('div', { class: 'sd-card-h' }, [el('p', { class: 'sd-label' }, ['Within reach, last 28 days']), el('span', { class: 'sd-note' }, [s.window.current.startDate + ' to ' + s.window.current.endDate + ' · ' + num(s.queryCount) + ' searches seen'])]),
        el('p', { class: 'sd-note', style: 'margin-bottom:12px' }, ['Searches where the site shows at #4 to #20 with at least 10 views, ordered by the extra clicks a top 3 spot would bring. These are the cheapest wins.']),
        s.striking.length ? el('div', { class: 'sd-table-wrap' }, [el('table', { class: 'sd-table' }, [
          el('thead', {}, [el('tr', {}, [el('th', {}, ['Search']), el('th', {}, ['Page']), el('th', { class: 'num' }, ['Position']), el('th', { class: 'num' }, ['Impressions']), el('th', { class: 'num' }, ['Clicks']), el('th', { class: 'num' }, ['CTR']), el('th', { class: 'num' }, ['Extra clicks at #3']), el('th', {}, [''])])]),
          el('tbody', {}, s.striking.slice(0, 40).map(function (r) {
            return el('tr', {}, [el('td', { class: 'sd-pt' }, [r.query]), el('td', {}, [el('span', { class: 'sd-path' }, [r.page])]), el('td', { class: 'num' }, ['#' + num(r.position, 1)]), el('td', { class: 'num' }, [num(r.impressions)]), el('td', { class: 'num' }, [num(r.clicks)]), el('td', { class: 'num' }, [pctTxt(r.ctr)]), el('td', { class: 'num sd-good' }, ['+' + r.extraAt3]), el('td', { class: 'num' }, [trackBtn(r.query)])]);
          })),
        ])]) : el('p', { class: 'sd-empty' }, ['Nothing in the #4 to #20 range with 10+ views yet. As the new pages get indexed, searches will show up here.']),
      ]),
      card([
        el('div', { class: 'sd-card-h' }, [el('p', { class: 'sd-label' }, ['Top searches, last 28 days']), el('input', { class: 'sd-input', id: 'sd-kq', placeholder: 'Filter searches…', value: S.kw.q, onInput: function (e) { S.kw.q = e.target.value; redrawKeepFocus('sd-kq'); } })]),
        top.length ? el('div', { class: 'sd-table-wrap' }, [el('table', { class: 'sd-table' }, [
          el('thead', {}, [el('tr', {}, [el('th', {}, ['Search']), el('th', {}, ['Top page']), el('th', { class: 'num' }, ['Clicks']), el('th', { class: 'num' }, ['Impressions']), el('th', { class: 'num' }, ['CTR']), el('th', { class: 'num' }, ['Position']), el('th', {}, [''])])]),
          el('tbody', {}, top.slice(0, 100).map(function (r) {
            return el('tr', {}, [el('td', { class: 'sd-pt' }, [r.query]), el('td', {}, [el('span', { class: 'sd-path' }, [r.page])]), el('td', { class: 'num' }, [num(r.clicks)]), el('td', { class: 'num' }, [num(r.impressions)]), el('td', { class: 'num' }, [pctTxt(r.ctr)]), el('td', { class: 'num' }, ['#' + num(r.position, 1)]), el('td', { class: 'num' }, [trackBtn(r.query)])]);
          })),
        ])]) : el('p', { class: 'sd-empty' }, [q ? 'No searches match.' : 'No search data yet.']),
      ]),
    ]);
  }

  // ---------- Rankings ----------

  function viewRankings() {
    var gate = searchGate();
    var tracked = (S.search && S.search.tracked) || S.core.tracked || [];
    var input = el('input', { class: 'sd-input sd-grow', id: 'sd-track', placeholder: 'e.g. adjustable stairs for roof access', maxlength: '80' });
    var add = function () { var v = input.value.trim(); if (v) trackKeyword(v); };
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    var table;
    if (gate) table = gate;
    else {
      var s = S.search;
      table = el('div', { class: 'sd-table-wrap' }, [el('table', { class: 'sd-table' }, [
        el('thead', {}, [el('tr', {}, [el('th', {}, ['Keyword']), el('th', { class: 'num' }, ['Position']), el('th', { class: 'num' }, ['Change']), el('th', {}, ['12-week trend']), el('th', { class: 'num' }, ['Impressions']), el('th', { class: 'num' }, ['Clicks']), el('th', {}, ['Best page']), el('th', {}, [''])])]),
        el('tbody', {}, s.rankings.length ? s.rankings.map(function (r) {
          var ch = r.change;
          var chEl = ch == null ? el('span', { class: 'sd-change flat' }, ['–']) : el('span', { class: 'sd-change ' + (Math.abs(ch) < 0.5 ? 'flat' : ch > 0 ? 'up' : 'down') }, [Math.abs(ch) < 0.5 ? '0' : (ch > 0 ? '▲ ' : '▼ ') + num(Math.abs(ch), 1)]);
          return el('tr', {}, [
            el('td', { class: 'sd-pt' }, [r.keyword]),
            el('td', { class: 'num' }, [r.position == null ? el('span', { class: 'sd-na' }, ['not seen']) : '#' + num(r.position, 1)]),
            el('td', { class: 'num' }, [chEl]),
            el('td', {}, [spark(r.weeks.map(function (w) { return w.position; }))]),
            el('td', { class: 'num' }, [num(r.impressions12w)]),
            el('td', { class: 'num' }, [num(r.clicks12w)]),
            el('td', {}, [r.page ? el('span', { class: 'sd-path' }, [r.page]) : '–']),
            el('td', { class: 'num' }, [el('button', { class: 'sd-btn sd-btn-sm', type: 'button', title: 'Stop tracking', 'aria-label': 'Stop tracking ' + r.keyword, onClick: function () { untrack(r.keyword); } }, ['✕'])]),
          ]);
        }) : [el('tr', {}, [el('td', { colspan: '8', class: 'sd-empty' }, ['No keywords tracked yet.'])])]),
      ])]);
    }
    var quick = S.search && S.search.striking ? S.search.striking.filter(function (r) { return !isTracked(r.query); }).slice(0, 12) : [];
    return el('div', {}, [
      el('div', { class: 'sd-card-h' }, [el('p', { class: 'sd-label' }, ['Weekly positions · ' + tracked.length + '/25 tracked']), S.search && S.search.trackedIsDefault ? el('span', { class: 'sd-note' }, ['Starting list based on your goals. Add or remove any.']) : null]),
      table,
      el('p', { class: 'sd-note', style: 'margin:10px 0 18px' }, ['Positions come from real Google searches in Search Console, averaged per week (Monday to Sunday). “Not seen” means the site didn’t show for that exact search that week. ▲ means it moved up.']),
      card([
        el('p', { class: 'sd-label' }, ['Track a keyword']),
        el('div', { class: 'sd-filters', style: 'margin-top:10px' }, [input, el('button', { class: 'sd-btn sd-btn-primary', type: 'button', onClick: add }, ['+ Add'])]),
        quick.length ? el('div', {}, [el('p', { class: 'sd-label', style: 'margin:6px 0 8px' }, ['Quick add from “within reach”']), el('div', { class: 'sd-chips' }, quick.map(function (r) { return el('button', { class: 'sd-chip', type: 'button', onClick: function () { trackKeyword(r.query); } }, ['+ ' + r.query]); }))]) : null,
      ]),
    ]);
  }

  // ---------- Analytics ----------

  function viewAnalytics() {
    if (S.err.analytics) return errorBox(S.err.analytics);
    if (!S.analytics) return loading('Reading Google Analytics…');
    var a = S.analytics;
    if (!a.connected) return el('div', {}, [setupNotice('analytics'), connectionsCard()]);
    var t = a.totals, p = a.previous, ev = a.events, evp = a.eventsPrevious;
    var maxSrc = Math.max.apply(null, a.sources.map(function (x) { return x.sessions; }).concat([1]));
    var totalSrc = a.sources.reduce(function (s, x) { return s + x.sessions; }, 0) || 1;
    var gsc = {};
    S.core.pages.forEach(function (pg) { if (pg.search) gsc[pg.path] = pg.search.clicks; });
    var normal = function (path) { var x = path.replace(/\.html$/, '').replace(/\/+$/, ''); return x === '' || x === '/index' ? '/' : x; };
    return el('div', {}, [
      el('div', { class: 'sd-section-h' }, ['Last 28 days', el('span', {}, [a.window.current.startDate + ' to today vs the 28 days before'])]),
      el('div', { class: 'sd-kpis' }, [
        kpi(num(t.users), 'Users', 'people who visited', delta(t.users, p.users)),
        kpi(num(t.sessions), 'Sessions', 'visits', delta(t.sessions, p.sessions)),
        kpi(num(t.views), 'Page views', '', delta(t.views, p.views)),
        kpi(num(ev.generate_lead || 0), 'Quote requests', 'contact form sent', delta(ev.generate_lead || 0, evp.generate_lead || 0)),
        kpi(num(ev.phone_click || 0), 'Phone taps', 'tapped the phone number', delta(ev.phone_click || 0, evp.phone_click || 0)),
        kpi(num(ev.calculator_quote || 0), 'Calculator quotes', 'from the size calculator', delta(ev.calculator_quote || 0, evp.calculator_quote || 0)),
      ]),
      el('div', { class: 'sd-two' }, [
        card([
          el('div', { class: 'sd-card-h' }, [el('p', { class: 'sd-label' }, ['Daily visitors']), el('div', { class: 'sd-legend' }, [el('span', {}, [el('i', { style: 'background:#00703a' }), 'Users']), el('span', {}, [el('i', { style: 'background:#0d1117' }), 'Sessions'])])]),
          a.daily.length ? lineChart([
            { values: a.daily.map(function (d) { return d.users; }), color: '#00703a', fill: true },
            { values: a.daily.map(function (d) { return d.sessions; }), color: '#0d1117' },
          ], a.daily.map(function (d) { return shortDate(d.date); }), { label: 'Daily users and sessions' }) : el('p', { class: 'sd-empty' }, ['No visits recorded yet. Counting starts once the measurement ID is saved.']),
        ]),
        card([
          el('p', { class: 'sd-label', style: 'margin-bottom:8px' }, ['How visitors find the site']),
          el('ul', { class: 'sd-bars' }, a.sources.map(function (x) {
            return el('li', {}, [el('div', { class: 'row' }, [x.channel, el('b', {}, [num(x.sessions) + ' · ' + Math.round((x.sessions / totalSrc) * 100) + '%'])]), el('div', { class: 'bar' }, [el('i', { style: 'width:' + Math.max(2, (x.sessions / maxSrc) * 100) + '%' })])]);
          })),
          a.sources.length ? null : el('p', { class: 'sd-note' }, ['No visits yet.']),
        ]),
      ]),
      el('div', { class: 'sd-section-h' }, ['Top pages']),
      el('div', { class: 'sd-table-wrap' }, [el('table', { class: 'sd-table' }, [
        el('thead', {}, [el('tr', {}, [el('th', {}, ['Page']), el('th', { class: 'num' }, ['Views']), el('th', { class: 'num' }, ['Users']), el('th', { class: 'num' }, ['Avg time']), el('th', { class: 'num' }, ['Google clicks'])])]),
        el('tbody', {}, a.pages.length ? a.pages.map(function (r) {
          var key = normal(r.path);
          return el('tr', {}, [el('td', {}, [el('div', { class: 'sd-pt' }, [pageTitle(key)]), el('span', { class: 'sd-path' }, [r.path])]), el('td', { class: 'num' }, [num(r.views)]), el('td', { class: 'num' }, [num(r.users)]), el('td', { class: 'num' }, [Math.round(r.engagedSeconds) + 's']), el('td', { class: 'num' }, [gsc[key] != null ? num(gsc[key]) : '–'])]);
        }) : [el('tr', {}, [el('td', { colspan: '5', class: 'sd-empty' }, ['No page views yet.'])])]),
      ])]),
    ]);
  }

  // ---------- Recommendations ----------

  function setRecs(ids, status, days) {
    var info = {};
    S.core.recs.forEach(function (r) { if (ids.indexOf(r.id) > -1) info[r.id] = { title: r.title, path: r.path, pillar: r.pillar, severity: r.severity, source: r.source }; });
    S.busy.recs = true; draw();
    post({ action: 'recs', ids: ids, status: status, days: days, info: info }).then(function () {
      S.core.recs.forEach(function (r) {
        if (ids.indexOf(r.id) > -1) { r.status = status === 'open' ? 'open' : status; r.statusAt = new Date().toISOString(); r.statusBy = 'you'; if (status === 'snoozed') r.until = new Date(Date.now() + (days || 14) * 86400000).toISOString(); }
      });
      S.recs.sel = {};
    }).catch(function (e) { alert(e.message); }).then(function () { S.busy.recs = false; draw(); });
  }

  function viewRecs() {
    var c = S.core, u = S.recs;
    var counts = { open: 0, snoozed: 0, done: 0, dismissed: 0, resolved: 0 };
    c.recs.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
    var list = c.recs.filter(function (r) { return u.status === 'all' || r.status === u.status; });
    var q = u.q.trim().toLowerCase();
    if (q) list = list.filter(function (r) { return (r.title + ' ' + r.finding + ' ' + r.path).toLowerCase().indexOf(q) > -1; });
    if (u.sev) list = list.filter(function (r) { return r.severity === u.sev; });
    if (u.pillar) list = list.filter(function (r) { return r.pillar === u.pillar; });
    if (u.source) list = list.filter(function (r) { return r.source === u.source; });
    list.sort(function (a, b) { return SEV[a.severity] - SEV[b.severity] || a.title.localeCompare(b.title); });
    var sel = Object.keys(u.sel).filter(function (k) { return u.sel[k]; });
    var sources = Array.from(new Set(c.recs.map(function (r) { return r.source; }))).filter(Boolean).sort();
    var chip = function (key, label) { return el('button', { class: 'sd-chip' + (u.status === key ? ' is-active' : ''), type: 'button', onClick: function () { u.status = key; u.sel = {}; draw(); } }, [label + (key === 'all' ? '' : ' ' + (counts[key] || 0))]); };
    var allBox = el('input', { type: 'checkbox', 'aria-label': 'Select all shown', checked: list.length && list.every(function (r) { return u.sel[r.id]; }) ? true : null, onChange: function (e) { list.forEach(function (r) { u.sel[r.id] = e.target.checked; }); draw(); } });
    var canAct = u.status !== 'resolved';
    return el('div', {}, [
      el('p', { class: 'sd-note', style: 'margin-bottom:12px' }, ['Every finding from the page checks, site checks, Google’s index status and Search Console, in one list. Mark items done as you fix them. Anything marked done that still fails a week later comes back.']),
      el('div', { class: 'sd-chips', style: 'margin-bottom:12px' }, [chip('open', 'Open'), chip('snoozed', 'Snoozed'), chip('done', 'Done'), chip('dismissed', 'Dismissed'), chip('resolved', 'Resolved'), chip('all', 'All')]),
      el('div', { class: 'sd-filters' }, [
        el('input', { class: 'sd-input sd-grow', id: 'sd-rq', placeholder: 'Search title, page, search phrase…', value: u.q, onInput: function (e) { u.q = e.target.value; redrawKeepFocus('sd-rq'); } }),
        el('select', { class: 'sd-select', 'aria-label': 'Severity', onChange: function (e) { u.sev = e.target.value; draw(); } }, [['', 'All severities'], ['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']].map(function (o) { return el('option', { value: o[0], selected: u.sev === o[0] ? true : null }, [o[1]]); })),
        el('select', { class: 'sd-select', 'aria-label': 'Pillar', onChange: function (e) { u.pillar = e.target.value; draw(); } }, [['', 'All pillars'], ['SEO', 'SEO'], ['AEO', 'AEO'], ['GEO', 'GEO'], ['Tech', 'Tech']].map(function (o) { return el('option', { value: o[0], selected: u.pillar === o[0] ? true : null }, [o[1]]); })),
        el('select', { class: 'sd-select', 'aria-label': 'Source', onChange: function (e) { u.source = e.target.value; draw(); } }, [el('option', { value: '' }, ['All sources'])].concat(sources.map(function (s) { return el('option', { value: s, selected: u.source === s ? true : null }, [s]); }))),
      ]),
      canAct ? el('div', { class: 'sd-bulk' }, [
        el('b', {}, ['BULK']),
        el('button', { class: 'sd-btn sd-btn-sm sd-btn-primary', type: 'button', disabled: !sel.length || S.busy.recs ? true : null, onClick: function () { setRecs(sel, 'done'); } }, ['Mark done (' + sel.length + ')']),
        el('button', { class: 'sd-btn sd-btn-sm', type: 'button', disabled: !sel.length || S.busy.recs ? true : null, onClick: function () { setRecs(sel, 'snoozed', 14); } }, ['Snooze 14 days']),
        el('button', { class: 'sd-btn sd-btn-sm', type: 'button', disabled: !sel.length || S.busy.recs ? true : null, onClick: function () { setRecs(sel, 'dismissed'); } }, ['Dismiss']),
        u.status !== 'open' ? el('button', { class: 'sd-btn sd-btn-sm', type: 'button', disabled: !sel.length || S.busy.recs ? true : null, onClick: function () { setRecs(sel, 'open'); } }, ['Reopen']) : null,
        el('span', { style: 'margin-left:auto' }, [list.length + ' shown']),
      ]) : null,
      el('div', { class: 'sd-table-wrap' }, [el('table', { class: 'sd-table' }, [
        el('thead', {}, [el('tr', {}, [canAct ? el('th', {}, [allBox]) : null, el('th', {}, ['Severity']), el('th', {}, ['Finding']), el('th', {}, ['Pillar']), el('th', {}, ['Source']), el('th', {}, [u.status === 'open' ? '' : 'Status'])])]),
        el('tbody', {}, list.length ? list.map(function (r) {
          return el('tr', {}, [
            canAct ? el('td', {}, [el('input', { type: 'checkbox', 'aria-label': 'Select', checked: u.sel[r.id] ? true : null, onChange: function (e) { u.sel[r.id] = e.target.checked; draw(); } })]) : null,
            el('td', {}, [el('span', { class: 'sd-pill ' + r.severity }, [r.severity.charAt(0).toUpperCase() + r.severity.slice(1)])]),
            el('td', {}, [el('div', { class: 'sd-pt' }, [r.title]), el('div', { class: 'sd-fix' }, [r.finding]), el('span', { class: 'sd-path' }, [r.path])]),
            el('td', {}, [r.pillar]),
            el('td', {}, [r.source]),
            el('td', { class: 'sd-note' }, [r.status === 'open' ? '' : r.status + (r.statusAt ? ' ' + ago(r.statusAt) : '') + (r.statusBy ? ' by ' + r.statusBy : '') + (r.status === 'snoozed' && r.until ? ' · until ' + shortDate(r.until.slice(0, 10)) : '')]),
          ]);
        }) : [el('tr', {}, [el('td', { colspan: '6', class: 'sd-empty' }, ['Nothing here.'])])]),
      ])]),
    ]);
  }

  // ---------- Site audit ----------

  function viewAudit() {
    var c = S.core;
    var metaIds = null;
    var pages = c.pages.slice().sort(function (a, b) { return a.path === '/' ? -1 : b.path === '/' ? 1 : a.title.localeCompare(b.title); });
    var passed = 0, total = 0;
    var rows = pages.map(function (p) {
      var list = p.checks.filter(function (x) { return x.meta; });
      metaIds = metaIds || list.map(function (x) { return x.label; });
      var ok = list.filter(function (x) { return x.pass === true; }).length;
      var judged = list.filter(function (x) { return x.pass !== null; }).length;
      passed += ok; total += judged;
      var open = !!S.auditOpen[p.path];
      return el('div', {}, [
        el('div', { class: 'sd-audit-row', role: 'button', tabindex: '0', onClick: function () { S.auditOpen[p.path] = !open; draw(); } }, [
          el('span', { class: 'sd-caret' }, [open ? '▾' : '▸']),
          el('span', { class: 'sd-pt' }, [p.title]),
          el('span', { class: 'sd-dots', 'aria-label': ok + ' of ' + judged + ' checks passed' }, list.map(function (x) { return el('i', { class: x.pass === true ? '' : x.pass === false ? 'fail' : 'na', title: x.label + (x.pass === false ? ': ' + x.fix : '') }); })),
          el('span', { class: 'sd-x sd-pill ' + (ok === judged ? 'good' : 'bad') }, [ok + '/' + judged]),
        ]),
        open ? el('div', { style: 'padding:6px 30px 14px' }, [el('ul', { class: 'sd-checks' }, list.map(function (x) {
          var cls = x.pass === true ? 'pass' : x.pass === false ? 'fail' : 'na';
          return el('li', {}, [el('span', { class: 'sd-i ' + cls }, [x.pass === true ? '✓' : x.pass === false ? '!' : '–']), el('div', {}, [x.label, x.pass === false ? el('small', {}, [x.fix]) : null])]);
        }))]) : null,
      ]);
    });
    var sitePass = c.siteChecks.filter(function (x) { return x.pass === true; }).length;
    return el('div', {}, [
      card([
        el('div', { class: 'sd-card-h' }, [
          el('div', {}, [el('p', { class: 'sd-label' }, ['Site audit']), el('p', { class: 'sd-note', style: 'margin-top:4px' }, [passed + '/' + total + ' page checks passed across ' + pages.length + ' pages · ' + sitePass + '/' + c.siteChecks.length + ' site-wide checks passed'])]),
          el('span', { class: 'sd-pill ' + (passed === total ? 'good' : 'medium') }, [total ? Math.round((passed / total) * 100) + '%' : '–']),
        ]),
        el('p', { class: 'sd-label', style: 'margin:6px 0 8px' }, ['Site-wide']),
        el('div', { class: 'sd-chips' }, c.siteChecks.map(function (x) {
          return el('span', { class: 'sd-chip static ' + (x.pass === true ? 'pass' : x.pass === false ? 'fail' : 'na'), title: (x.pass === false ? x.fix : x.detail) || '' }, [x.label + (x.detail ? ' (' + x.detail + ')' : '')]);
        })),
        c.siteChecks.some(function (x) { return x.pass === false; }) ? el('ul', { class: 'sd-checks', style: 'margin-top:12px' }, c.siteChecks.filter(function (x) { return x.pass === false; }).map(function (x) { return el('li', {}, [el('span', { class: 'sd-i fail' }, ['!']), el('div', {}, [x.label, el('small', {}, [x.fix])])]); })) : null,
        el('p', { class: 'sd-label', style: 'margin:20px 0 4px' }, ['Every page']),
        el('p', { class: 'sd-note', style: 'margin-bottom:6px' }, ['Each dot is one check: ' + (metaIds || []).join(', ') + '. Hover a dot to see it, or click a page for details.']),
        el('div', {}, rows),
      ]),
    ]);
  }


  // ---------- How to Improve ----------

  var PILLARS = [
    ['SEO', 'seo', 'Classic search', 'How well Google can find, understand and rank each page: titles, descriptions, headings, links between pages, photo descriptions and speed.'],
    ['AEO', 'aeo', 'Answer engines', 'How easily Google’s answer boxes, voice assistants and tools like ChatGPT can lift a direct answer from the page: FAQs, question headings, a short answer near the top, lists and structured data.'],
    ['GEO', 'geo', 'AI citations', 'How likely AI tools are to cite the page as a source: specific facts and numbers, links to official sources, who published it, when it was updated, and depth.'],
  ];

  function pillarKpi(key, val, label, sub) {
    var n = kpi(val == null ? '–' : val, label, sub + ' · see why');
    n.style.cursor = 'pointer';
    n.setAttribute('role', 'button');
    n.setAttribute('tabindex', '0');
    n.title = 'See what’s costing points and how to fix it';
    var go = function () { S.tab = 'improve'; S.improveFocus = key; draw(); window.scrollTo(0, 0); };
    n.addEventListener('click', go);
    n.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    return n;
  }

  // For each check that fails somewhere: how many points the site average
  // would gain if it were fixed everywhere, and on which pages.
  function pointsAtStake(pillar) {
    var c = S.core, byId = {};
    c.pages.forEach(function (p) {
      var list = p.checks.filter(function (x) { return x.pillar === pillar && x.pass !== null; });
      var total = list.reduce(function (a, x) { return a + x.weight; }, 0);
      if (!total) return;
      list.filter(function (x) { return x.pass === false; }).forEach(function (x) {
        var e = byId[x.id] || (byId[x.id] = { id: x.id, label: x.label, severity: x.severity, gain: 0, pages: [] });
        e.gain += (x.weight / total) * 100 / c.pages.length;
        e.pages.push({ path: p.path, title: p.title, fix: x.fix });
      });
    });
    return Object.keys(byId).map(function (k) { return byId[k]; }).sort(function (a, b) { return b.gain - a.gain; });
  }

  function pageChips(pages) {
    return el('div', { class: 'sd-chips', style: 'margin-top:8px' }, pages.map(function (p) {
      return el('button', { class: 'sd-chip', type: 'button', title: p.fix || '', onClick: function () { openEditor(p.title); } }, [p.title + ' ✎']);
    }));
  }

  function viewImprove() {
    var c = S.core, g = c.guide || {}, sm = c.summary;
    var out = el('div', {}, [
      el('p', { class: 'sd-note', style: 'margin-bottom:14px' }, ['Each page is scored from 0 to 100 on three things. A page’s score is the share of that pillar’s checks it passes, weighted by how much each check matters. The site score is the average of all pages. Below, every check that’s failing is ranked by how many points it would add to the site average, with how to fix it and a button to open each page in the editor.']),
    ]);
    out.appendChild(el('div', { class: 'sd-kpis' }, PILLARS.map(function (pl) {
      var items = pointsAtStake(pl[0]);
      var gain = items.reduce(function (a, x) { return a + x.gain; }, 0);
      var cardEl = el('div', { class: 'sd-kpi', style: 'cursor:pointer', onClick: function () { var t = document.getElementById('sd-pl-' + pl[1]); if (t) t.scrollIntoView({ behavior: 'smooth' }); } }, [
        el('div', { class: 'sd-kpi-n' }, [String(sm[pl[1]] == null ? '–' : sm[pl[1]]), el('span', { class: 'sd-delta ' + (gain >= 0.5 ? 'up' : 'flat') }, [gain >= 0.5 ? 'up to +' + Math.round(gain) : 'maxed'])]),
        el('div', { class: 'sd-kpi-l' }, [pl[0] + ' · ' + pl[2]]),
        el('div', { class: 'sd-kpi-s', style: 'line-height:1.55;margin-top:6px' }, [pl[3]]),
      ]);
      return cardEl;
    })));

    PILLARS.forEach(function (pl) {
      var items = pointsAtStake(pl[0]);
      var sec = card([
        el('div', { class: 'sd-card-h', id: 'sd-pl-' + pl[1] }, [
          el('p', { class: 'sd-label' }, ['Raise ' + pl[0] + ' (now ' + (sm[pl[1]] == null ? '–' : sm[pl[1]]) + ')']),
          el('span', { class: 'sd-note' }, [items.length ? items.length + ' thing(s) to fix' : 'Nothing failing']),
        ]),
        items.length ? el('ul', { class: 'sd-alerts' }, items.map(function (it) {
          var gd = g[it.id] || {};
          var factsExtra = null;
          if (it.id === 'facts' && c.factPrompts) {
            factsExtra = el('ul', { class: 'sd-checks', style: 'margin-top:8px' }, it.pages.filter(function (p) { return c.factPrompts[p.path]; }).map(function (p) {
              return el('li', {}, [el('span', { class: 'sd-i na' }, ['?']), el('div', {}, [el('b', {}, [p.title + ': ']), c.factPrompts[p.path]])]);
            }));
          }
          return el('li', {}, [
            el('span', { class: 'sd-dot ' + it.severity }),
            el('div', { style: 'flex:1' }, [
              el('div', {}, [el('b', {}, [it.label]), ' ', el('span', { class: 'sd-delta up' }, ['+' + (it.gain >= 1 ? Math.round(it.gain) : it.gain.toFixed(1)) + ' pts']), ' ', el('span', { class: 'sd-note' }, [it.pages.length + ' page' + (it.pages.length === 1 ? '' : 's')])]),
              gd.why ? el('div', { class: 'sd-fix', style: 'max-width:none' }, [el('b', {}, ['Why it matters: ']), gd.why]) : null,
              gd.how ? el('div', { class: 'sd-fix', style: 'max-width:none' }, [el('b', {}, ['How to fix it: ']), gd.how]) : null,
              factsExtra,
              pageChips(it.pages),
            ]),
          ]);
        })) : el('p', { class: 'sd-note' }, ['Every page passes every ' + pl[0] + ' check that applies to it.']),
      ]);
      out.appendChild(sec);
    });

    var factPages = c.pages.filter(function (p) { return p.checks.some(function (x) { return x.id === 'facts' && x.pass === false; }) && c.factPrompts && c.factPrompts[p.path]; });
    if (factPages.length) {
      out.appendChild(card([
        el('p', { class: 'sd-label' }, ['Facts only you can provide']),
        el('p', { class: 'sd-note', style: 'margin:6px 0 10px' }, ['These pages need real, specific facts that only ATI knows. Never add a number that isn’t true: AI tools and Google check claims against other sources, and a wrong one hurts trust in the whole site.']),
        el('ul', { class: 'sd-conn' }, factPages.map(function (p) {
          return el('li', {}, [el('span', { class: 'sd-dot medium' }), el('div', { style: 'flex:1' }, [el('b', {}, [p.title]), el('small', {}, ['Ideas: ' + c.factPrompts[p.path]])]),
            el('button', { class: 'sd-btn sd-btn-sm', type: 'button', onClick: function () { openEditor(p.title); } }, ['Open in the editor'])]);
        })),
      ]));
    }

    var info = c.checksInfo || [];
    out.appendChild(el('div', { class: 'sd-section-h' }, ['Every check explained', el('span', {}, ['Points are each check’s weight within its pillar.'])]));
    PILLARS.forEach(function (pl) {
      var list = info.filter(function (x) { return x.pillar === pl[0]; });
      var total = list.reduce(function (a, x) { return a + x.weight; }, 0);
      out.appendChild(el('details', { class: 'sd-card', open: S.improveFocus === pl[1] ? true : null }, [
        el('summary', { style: 'cursor:pointer;font-weight:700' }, [pl[0] + ': ' + pl[2] + ' (' + list.length + ' checks)']),
        el('ul', { class: 'sd-checks', style: 'margin-top:12px' }, list.map(function (x) {
          var gd = g[x.id] || {};
          var failing = c.pages.filter(function (p) { return p.checks.some(function (y) { return y.id === x.id && y.pass === false; }); }).length;
          return el('li', { style: 'padding:8px 0;border-top:1px solid #f0f2f4' }, [
            el('span', { class: 'sd-i ' + (failing ? 'fail' : 'pass') }, [failing ? '!' : '✓']),
            el('div', {}, [el('b', {}, [x.label]), ' ', el('span', { class: 'sd-note' }, ['· ' + Math.round((x.weight / total) * 100) + '% of ' + pl[0] + ' · ' + (failing ? failing + ' page(s) failing' : 'all pages pass')]),
              el('small', {}, [gd.why || '']), el('small', {}, [el('b', {}, ['Fix: ']), gd.how || ''])]),
          ]);
        })),
      ]));
    });
    if (S.improveFocus) { var f = S.improveFocus; S.improveFocus = null; setTimeout(function () { var t = document.getElementById('sd-pl-' + f); if (t) t.scrollIntoView(); }, 30); }
    return out;
  }

  // ---------- tips inside the page editor ----------

  function pageTips(container, file, getDraftHtml) {
    var body = el('div', { class: 'sd sd-tips' }, []);
    var btn = el('button', { class: 'sd-btn sd-btn-primary sd-btn-sm', type: 'button' }, ['Check this page']);
    var note = el('span', { class: 'sd-note' }, ['Scores this page the way it would look if you published now, including unpublished changes.']);
    container.appendChild(el('div', { style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px' }, [btn, note]));
    container.appendChild(body);
    btn.addEventListener('click', function () {
      btn.disabled = true; btn.textContent = 'Checking…';
      body.innerHTML = '';
      body.appendChild(loading('Scoring this page against the live site…'));
      var html;
      try { html = getDraftHtml(); } catch (e) { html = null; }
      if (!html) { body.innerHTML = ''; body.appendChild(errorBox('Couldn’t read the page from the editor.')); btn.disabled = false; btn.textContent = 'Check this page'; return; }
      post({ action: 'audit-draft', file: file, html: html }).then(function (r) {
        body.innerHTML = '';
        var pub = r.published ? r.published.scores : {}, dr = r.draft.scores;
        var row = function (key, label) {
          var a = pub[key], b = dr[key];
          var diff = a != null && b != null ? b - a : null;
          return el('div', { class: 'sd-kpi' }, [
            el('div', { class: 'sd-kpi-n' }, [scoreTxt(b), diff ? el('span', { class: 'sd-delta ' + (diff > 0 ? 'up' : 'down') }, [(diff > 0 ? '+' : '') + diff]) : null]),
            el('div', { class: 'sd-kpi-l' }, [label]),
            el('div', { class: 'sd-kpi-s' }, [a == null ? 'not published yet' : 'published: ' + a]),
          ]);
        };
        body.appendChild(el('div', { class: 'sd-kpis' }, [row('seo', 'SEO'), row('aeo', 'AEO'), row('geo', 'GEO')]));
        var fails = r.draft.checks.filter(function (x) { return x.pass === false; }).sort(function (a, b) { return SEV[a.severity] - SEV[b.severity] || b.weight - a.weight; });
        if (!fails.length) { body.appendChild(el('p', { class: 'success-msg' }, ['This page passes every check that applies to it.'])); }
        else body.appendChild(el('ul', { class: 'sd-alerts' }, fails.map(function (x) {
          var gd = r.guide[x.id] || {};
          return el('li', {}, [el('span', { class: 'sd-dot ' + x.severity }), el('div', {}, [
            el('b', {}, [x.pillar + ': ' + x.label]), el('div', { class: 'sd-fix', style: 'max-width:none' }, [x.fix]),
            gd.how ? el('div', { class: 'sd-fix', style: 'max-width:none' }, [el('b', {}, ['How: ']), gd.how]) : null,
          ])]);
        })));
        var passed = r.draft.checks.filter(function (x) { return x.pass === true; }).length;
        body.appendChild(el('p', { class: 'sd-note', style: 'margin-top:8px' }, [passed + ' checks passed. Open SEO dashboard → How to Improve for the full guide.']));
      }).catch(function (e) {
        body.innerHTML = '';
        body.appendChild(errorBox(e.message));
      }).then(function () { btn.disabled = false; btn.textContent = 'Check again'; });
    });
  }

  window.ATISEO = {
    pageTips: pageTips,
    render: function (container) {
      root = container;
      draw();
      load('core');
    },
  };
})();
