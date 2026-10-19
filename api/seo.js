// api/seo.js — the SEO dashboard (admins only), plus its daily check.
//
// GET  ?view=core       page scores, site checks, recommendations, links,
//                       PageSpeed, index status and the 28-day totals
// GET  ?view=search     keyword data from Search Console and tracked keywords
// GET  ?view=analytics  visitors from Google Analytics
// POST { action: "pagespeed", strategy }      measure the 3 stalest pages
// POST { action: "index" }                    ask Google which pages are indexed
// POST { action: "recs", ids, status, days }  done / dismissed / snoozed / open
// POST { action: "track", keyword } / { action: "untrack", keyword }
// POST { action: "settings", gaMeasurementId, gaPropertyId }
// GET  ?task=cron       Vercel's daily run (needs CRON_SECRET)

const { requireAuth } = require('../lib/requireAuth');
const { getManifest } = require('../lib/manifest');
const { getFile, putFile } = require('../lib/github');
const { SITE_URL } = require('../lib/site');
const audit = require('../lib/seoAudit');
const google = require('../lib/google');
const store = require('../lib/seoStore');

// Where pages are read from. Normally the live site, the same thing Google sees.
const FETCH_BASE = String(process.env.SEO_FETCH_BASE || SITE_URL).replace(/\/+$/, '');
const PAGESPEED_PER_RUN = 3;
const TRACK_LIMIT = 25;
const DEFAULT_TRACKED = ['adjustastairs', 'debris netting', 'used scaffolding', 'website design for contractors', 'netting', 'used scaffolding for sale', 'construction safety netting', 'website building'];

async function limit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(new Array(Math.min(n, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e.message }; }
    }
  }));
  return out;
}

async function fetchText(url, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, Object.assign({ signal: ctl.signal, headers: { 'User-Agent': 'ATI-SEO-Dashboard/1.0 (+https://www.ati-products.com)' } }, opts || {}));
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    const text = opts && opts.redirect === 'manual' ? '' : await res.text();
    return { status: res.status, headers, text, location: res.headers.get('location') || '' };
  } catch (e) {
    return { status: 0, headers: {}, text: '', error: e.message };
  } finally {
    clearTimeout(t);
  }
}

function pageUrl(path) { return SITE_URL + (path === '/' ? '/' : path); }
function fetchUrl(path) { return FETCH_BASE + (path === '/' ? '/' : path); }

async function sitePages() {
  const { pages } = await getManifest();
  return pages.map((m) => ({ file: m.file, title: m.title, group: m.group, isPost: !!m.isPost, path: audit.pathFor(m.file) }));
}

// ---------- the core view ----------

async function searchTotals(gaPropertyId) {
  const st = google.status();
  const out = { connected: st.google, error: '', current: null, previous: null, pages: {}, striking: [], window: google.windows(28) };
  if (!st.google) return out;
  const w = out.window;
  try {
    const [cur, prev, byPage, byQueryPage] = await Promise.all([
      google.gscQuery(Object.assign({ dimensions: [] }, w.current)),
      google.gscQuery(Object.assign({ dimensions: [] }, w.previous)),
      google.gscQuery(Object.assign({ dimensions: ['page'] }, w.current)),
      google.gscQuery(Object.assign({ dimensions: ['query', 'page'] }, w.current)),
    ]);
    const tot = (rows) => (rows[0] ? { clicks: rows[0].clicks, impressions: rows[0].impressions, ctr: rows[0].ctr, position: rows[0].position } : { clicks: 0, impressions: 0, ctr: 0, position: null });
    out.current = tot(cur);
    out.previous = tot(prev);
    byPage.forEach((r) => {
      const p = audit.linkTarget(r.keys[0], '/');
      if (!p) return;
      const t = out.pages[p] || (out.pages[p] = { clicks: 0, impressions: 0, posw: 0 });
      t.clicks += r.clicks; t.impressions += r.impressions; t.posw += r.position * r.impressions;
    });
    Object.keys(out.pages).forEach((p) => {
      const t = out.pages[p];
      t.ctr = t.impressions ? t.clicks / t.impressions : 0;
      t.position = t.impressions ? t.posw / t.impressions : null;
      delete t.posw;
    });
    out.striking = audit.strikingDistance(byQueryPage, 10);
    out.queryCount = new Set(byQueryPage.map((r) => r.keys[0])).size;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

async function analyticsTotals(propertyId) {
  const st = google.status();
  const out = { connected: st.google && !!propertyId, error: '', current: null, previous: null };
  if (!out.connected) return out;
  try {
    const w = google.windows(28);
    const ga = await google.gaReport(propertyId, {
      dateRanges: [{ startDate: w.current.startDate, endDate: 'today', name: 'current' }, { startDate: w.previous.startDate, endDate: w.previous.endDate, name: 'previous' }],
      metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }],
    });
    const rows = ga.rows || [];
    const pick = (name) => {
      const r = rows.find((x) => (x.dimensionValues || []).some((d) => d.value === name)) || (name === 'current' ? rows[0] : rows[1]);
      if (!r) return { users: 0, sessions: 0, views: 0 };
      const v = r.metricValues.map((m) => Number(m.value));
      return { users: v[0], sessions: v[1], views: v[2] };
    };
    out.current = pick('current');
    out.previous = pick('previous');
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

function recStatus(r, saved, now) {
  const s = saved[r.id];
  if (!s) return 'open';
  if (s.status === 'snoozed') return s.until && new Date(s.until).getTime() > now ? 'snoozed' : 'open';
  if (s.status === 'done') {
    // Marked done but the check still fails a week later: show it again.
    return s.at && now - new Date(s.at).getTime() > 7 * 86400000 ? 'open' : 'done';
  }
  return s.status || 'open';
}

async function coreView() {
  const [list, saved] = await Promise.all([sitePages(), store.readMany(['pagespeed', 'index', 'recs', 'settings', 'runs', 'tracked'])]);
  const settings = saved.settings || {};
  const gaPropertyId = settings.gaPropertyId || process.env.GA4_PROPERTY_ID || '';
  const [htmls, home, robots, sitemap, llms, notFound, apex, search, ga] = await Promise.all([
    limit(list, 8, (p) => fetchText(fetchUrl(p.path))),
    fetchText(fetchUrl('/'), { method: 'HEAD' }),
    fetchText(FETCH_BASE + '/robots.txt'),
    fetchText(FETCH_BASE + '/sitemap.xml'),
    fetchText(FETCH_BASE + '/llms.txt'),
    fetchText(FETCH_BASE + '/this-page-should-not-exist-' + Date.now(), { method: 'HEAD' }),
    fetchText(FETCH_BASE.replace('://www.', '://') + '/', { redirect: 'manual', method: 'HEAD' }),
    searchTotals(gaPropertyId),
    analyticsTotals(gaPropertyId),
  ]);
  const parsed = [];
  const failedFetch = [];
  list.forEach((p, i) => {
    const r = htmls[i];
    if (!r || r.status !== 200 || !r.text) { failedFetch.push({ path: p.path, status: r ? r.status : 0 }); return; }
    parsed.push(Object.assign(audit.parsePage(r.text, p.file), { manifestTitle: p.title, group: p.group, isPost: p.isPost }));
  });
  const site = audit.siteChecks({ home, robots, sitemap, llms, notFound, apex: FETCH_BASE.includes('://www.') ? apex : null }, parsed);
  const graph = audit.linkGraph(parsed);
  const speed = saved.pagespeed || {};
  const ctx = {
    sitemap: site.sitemap ? site.sitemap.paths : null,
    lastmod: site.sitemap ? site.sitemap.lastmod : {},
    llms: site.llms,
    aiBotsAllowed: site.aiBotsAllowed,
    inbound: graph.inbound,
    speed,
  };
  const scored = parsed.map((p) => Object.assign(p, audit.scorePage(p, ctx)));
  const index = saved.index || {};
  const recs = audit.recommendations({ pages: scored, siteChecks: site.checks, index, striking: search.striking, pageStats: search.pages });
  const savedRecs = saved.recs || {};
  const now = Date.now();
  recs.forEach((r) => { r.status = recStatus(r, savedRecs, now); const s = savedRecs[r.id]; if (s) { r.statusAt = s.at; r.statusBy = s.by; r.until = s.until; } });
  const liveIds = new Set(recs.map((r) => r.id));
  const resolved = Object.keys(savedRecs).filter((id) => !liveIds.has(id) && savedRecs[id].title)
    .map((id) => ({ id, title: savedRecs[id].title, path: savedRecs[id].path || '', pillar: savedRecs[id].pillar || '', severity: savedRecs[id].severity || 'low', source: savedRecs[id].source || '', status: 'resolved', statusAt: savedRecs[id].at, statusBy: savedRecs[id].by, finding: 'This now passes.' }));
  const pages = scored.map((p) => ({
    path: p.path, url: p.url, file: p.file, title: p.manifestTitle || p.title, seoTitle: p.title, description: p.description, group: p.group, isPost: p.isPost,
    words: p.words, faq: p.faqVisible, scores: p.scores, checks: p.checks,
    inbound: graph.inbound[p.path] || 0, inboundAll: graph.inboundAll[p.path] || 0, linkedFrom: graph.from[p.path] || [], outbound: p.internalOut,
    speed: speed[p.path] || null, index: index[p.path] || null, search: search.pages[p.path] || null,
    topFix: (p.checks.filter((c) => c.pass === false).sort((a, b) => ({ critical: 0, high: 1, medium: 2, low: 3 })[a.severity] - ({ critical: 0, high: 1, medium: 2, low: 3 })[b.severity] || b.weight - a.weight)[0] || {}).fix || '',
  }));
  const avg = (k) => { const v = pages.map((p) => p.scores[k]).filter((x) => x != null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  const perfVals = pages.map((p) => p.speed && p.speed.mobile && p.speed.mobile.perf).filter((x) => x != null);
  return {
    generatedAt: new Date().toISOString(),
    site: SITE_URL,
    summary: {
      pages: list.length, scored: pages.length, seo: avg('seo'), aeo: avg('aeo'), geo: avg('geo'),
      speed: perfVals.length ? Math.round(perfVals.reduce((a, b) => a + b, 0) / perfVals.length) : null, speedMeasured: perfVals.length,
      indexed: Object.keys(index).filter((k) => /indexed/i.test(index[k].coverageState || '') && !/not indexed/i.test(index[k].coverageState || '')).length,
      indexChecked: Object.keys(index).length,
    },
    pages,
    failedFetch,
    siteChecks: site.checks,
    links: { opportunities: graph.opportunities },
    recs: recs.concat(resolved),
    search: { connected: search.connected, error: search.error, current: search.current, previous: search.previous, window: search.window, striking: search.striking, queryCount: search.queryCount || 0 },
    analytics: ga,
    connections: Object.assign(google.status(), {
      gaMeasurementId: settings.gaMeasurementId || '',
      gaPropertyId,
      dataBranch: store.BRANCH,
    }),
    runs: saved.runs || {},
    guide: audit.GUIDE,
    factPrompts: audit.FACT_PROMPTS,
    checksInfo: audit.CHECKS.map((c) => ({ id: c.id, pillar: c.pillar, label: c.label, weight: c.weight, severity: c.severity })),
    tracked: (saved.tracked && saved.tracked.keywords) || DEFAULT_TRACKED,
    trackedIsDefault: !(saved.tracked && saved.tracked.keywords),
  };
}

// ---------- scoring one page, including unpublished edits ----------
//
// The page editor sends the page as it would be published. It is scored
// against the live site (for links, sitemap and llms.txt) next to the
// published version, so you can see what your edits change before
// publishing.

async function auditDraft(body) {
  const file = String(body.file || '');
  const draft = String(body.html || '');
  if (draft.length > 3000000) { const e = new Error('That page is too large to check.'); e.status = 400; e.expose = true; throw e; }
  const [list, saved] = await Promise.all([sitePages(), store.readMany(['pagespeed'])]);
  const me = list.find((p) => p.file === file);
  if (!me) { const e = new Error('That page isn’t in the admin page list.'); e.status = 404; e.expose = true; throw e; }
  const [htmls, robots, sitemap, llms] = await Promise.all([
    limit(list, 8, (p) => fetchText(fetchUrl(p.path))),
    fetchText(FETCH_BASE + '/robots.txt'),
    fetchText(FETCH_BASE + '/sitemap.xml'),
    fetchText(FETCH_BASE + '/llms.txt'),
  ]);
  const live = [];
  list.forEach((p, i) => {
    const r = htmls[i];
    if (r && r.status === 200 && r.text) live.push(Object.assign(audit.parsePage(r.text, p.file), { manifestTitle: p.title }));
  });
  const site = audit.siteChecks({ robots, sitemap, llms }, live);
  const score = (pages, target) => {
    const graph = audit.linkGraph(pages);
    const ctx = {
      sitemap: site.sitemap ? site.sitemap.paths : null, lastmod: site.sitemap ? site.sitemap.lastmod : {},
      llms: site.llms, aiBotsAllowed: site.aiBotsAllowed, inbound: graph.inbound, speed: saved.pagespeed || {},
    };
    // Publishing from the editor updates the date, so count it as fresh.
    if (target.isDraft) ctx.lastmod = Object.assign({}, ctx.lastmod, { [target.path]: new Date().toISOString().slice(0, 10) });
    return audit.scorePage(target, ctx);
  };
  const published = live.find((p) => p.file === file) || null;
  const draftPage = Object.assign(audit.parsePage(draft, file), { manifestTitle: me.title, isDraft: true });
  const withDraft = live.filter((p) => p.file !== file).concat([draftPage]);
  return {
    file, title: me.title, path: me.path,
    published: published ? score(live, published) : null,
    draft: score(withDraft, draftPage),
    guide: audit.GUIDE,
  };
}

// ---------- the search (keywords and rankings) view ----------

function weekStart(day) {
  const d = new Date(day + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return google.isoDay(new Date(d.getTime() - dow * 86400000));
}

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function searchView() {
  const saved = await store.readMany(['tracked']);
  const tracked = (saved.tracked && saved.tracked.keywords) || DEFAULT_TRACKED;
  if (!google.status().google) return { connected: false, tracked };
  const w = google.windows(28);
  const end = w.current.endDate;
  const start12 = google.isoDay(new Date(new Date(end + 'T00:00:00Z').getTime() - 83 * 86400000));
  const [queries, queryPages, trend] = await Promise.all([
    google.gscQuery(Object.assign({ dimensions: ['query'], rowLimit: 1000 }, w.current)),
    google.gscQuery(Object.assign({ dimensions: ['query', 'page'] }, w.current)),
    tracked.length ? google.gscQuery({
      startDate: start12, endDate: end, dimensions: ['query', 'date'],
      dimensionFilterGroups: [{ filters: [{ dimension: 'query', operator: 'includingRegex', expression: '^(' + tracked.map((k) => escRe(k.toLowerCase())).join('|') + ')$' }] }],
    }) : Promise.resolve([]),
  ]);
  const topPage = {};
  queryPages.forEach((r) => { const q = r.keys[0]; if (!topPage[q] || r.clicks + r.impressions / 1000 > topPage[q].score) topPage[q] = { page: audit.linkTarget(r.keys[1], '/') || r.keys[1], score: r.clicks + r.impressions / 1000 }; });
  const top = queries.slice().sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 200)
    .map((r) => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position, page: topPage[r.keys[0]] ? topPage[r.keys[0]].page : '' }));
  // Weekly average position (weighted by how often it showed) per tracked keyword.
  const weeks = [];
  for (let d = new Date(weekStart(start12) + 'T00:00:00Z'); google.isoDay(d) <= end; d = new Date(d.getTime() + 7 * 86400000)) weeks.push(google.isoDay(d));
  const rankings = tracked.map((kw) => {
    const rows = trend.filter((r) => r.keys[0].toLowerCase() === kw.toLowerCase());
    const byWeek = weeks.map((wk) => {
      const inWeek = rows.filter((r) => weekStart(r.keys[1]) === wk);
      const impressions = inWeek.reduce((s, r) => s + r.impressions, 0);
      const clicks = inWeek.reduce((s, r) => s + r.clicks, 0);
      const position = impressions ? inWeek.reduce((s, r) => s + r.position * r.impressions, 0) / impressions : null;
      return { week: wk, impressions, clicks, position };
    });
    const withPos = byWeek.filter((x) => x.position != null);
    const current = withPos.length ? withPos[withPos.length - 1] : null;
    const before = withPos.length > 1 ? withPos[withPos.length - 2] : null;
    const total = byWeek.reduce((s, x) => ({ impressions: s.impressions + x.impressions, clicks: s.clicks + x.clicks }), { impressions: 0, clicks: 0 });
    const q = queries.find((r) => r.keys[0].toLowerCase() === kw.toLowerCase());
    return {
      keyword: kw, weeks: byWeek,
      position: current ? current.position : null, week: current ? current.week : null,
      change: current && before ? before.position - current.position : null,
      impressions12w: total.impressions, clicks12w: total.clicks,
      page: q && topPage[q.keys[0]] ? topPage[q.keys[0]].page : '',
    };
  });
  return {
    connected: true, window: w, tracked, trackedIsDefault: !(saved.tracked && saved.tracked.keywords),
    striking: audit.strikingDistance(queryPages, 10), top, rankings, weeks, queryCount: queries.length,
  };
}

// ---------- the analytics view ----------

async function analyticsView() {
  const saved = await store.readMany(['settings']);
  const propertyId = (saved.settings && saved.settings.gaPropertyId) || process.env.GA4_PROPERTY_ID || '';
  if (!google.status().google || !propertyId) return { connected: false, measurementId: (saved.settings && saved.settings.gaMeasurementId) || '' };
  const w = google.windows(28);
  const range = [{ startDate: w.current.startDate, endDate: 'today' }];
  const prev = [{ startDate: w.previous.startDate, endDate: w.previous.endDate }];
  const run = (body) => google.gaReport(propertyId, body);
  const vals = (r) => (r.rows || []).map((x) => ({ dims: (x.dimensionValues || []).map((d) => d.value), m: x.metricValues.map((v) => Number(v.value)) }));
  const EVENTS = ['generate_lead', 'phone_click', 'calculator_quote', 'file_download'];
  const [daily, pages, sources, events, eventsPrev, totals, totalsPrev] = await Promise.all([
    run({ dateRanges: range, dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }, { name: 'sessions' }], orderBys: [{ dimension: { dimensionName: 'date' } }] }),
    run({ dateRanges: range, dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'userEngagementDuration' }], orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 50 }),
    run({ dateRanges: range, dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }] }),
    run({ dateRanges: range, dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }], dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: EVENTS } } } }),
    run({ dateRanges: prev, dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }], dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: EVENTS } } } }),
    run({ dateRanges: range, metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }, { name: 'engagementRate' }] }),
    run({ dateRanges: prev, metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }, { name: 'engagementRate' }] }),
  ]);
  const t = (r) => { const v = vals(r)[0]; return v ? { users: v.m[0], sessions: v.m[1], views: v.m[2], engagement: v.m[3] } : { users: 0, sessions: 0, views: 0, engagement: 0 }; };
  const ev = (r) => { const o = {}; vals(r).forEach((x) => { o[x.dims[0]] = x.m[0]; }); return o; };
  return {
    connected: true, propertyId, window: w,
    totals: t(totals), previous: t(totalsPrev),
    events: ev(events), eventsPrevious: ev(eventsPrev),
    daily: vals(daily).map((x) => ({ date: x.dims[0].replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'), users: x.m[0], sessions: x.m[1] })),
    pages: vals(pages).map((x) => ({ path: x.dims[0], views: x.m[0], users: x.m[1], engagedSeconds: x.m[1] ? x.m[2] / x.m[1] : 0 })),
    sources: vals(sources).map((x) => ({ channel: x.dims[0], sessions: x.m[0] })),
  };
}

// ---------- actions ----------

function who(req) { return req && req.user ? req.user.name || req.user.username : 'Daily check'; }

async function runPageSpeed(strategy, req, onlyPaths) {
  const strat = strategy === 'desktop' ? 'desktop' : 'mobile';
  const [list, cur] = await Promise.all([sitePages(), store.read('pagespeed')]);
  const data = cur.data || {};
  const age = (p) => { const r = data[p.path] && data[p.path][strat]; return r && r.at ? new Date(r.at).getTime() : 0; };
  const queue = (onlyPaths && onlyPaths.length ? list.filter((p) => onlyPaths.includes(p.path)) : list.slice().sort((a, b) => age(a) - age(b))).slice(0, PAGESPEED_PER_RUN);
  const results = await limit(queue, PAGESPEED_PER_RUN, (p) => google.pagespeed(pageUrl(p.path), strat));
  const errors = [];
  const saved = await store.update('pagespeed', (d) => {
    queue.forEach((p, i) => {
      const r = results[i];
      if (!r || r.error) { errors.push({ path: p.path, error: r ? r.error : 'no answer' }); return; }
      d[p.path] = Object.assign({}, d[p.path] || {}, { [strat]: r });
    });
    return d;
  }, `PageSpeed (${strat}) for ${queue.map((p) => p.path).join(', ')}`);
  const weekAgo = Date.now() - 7 * 86400000;
  const remaining = list.filter((p) => { const r = saved[p.path] && saved[p.path][strat]; return !r || !r.at || new Date(r.at).getTime() < weekAgo; }).length;
  await store.update('runs', (d) => Object.assign(d, { pagespeed: { at: new Date().toISOString(), by: who(req), strategy: strat, pages: queue.map((p) => p.path), errors } }), 'Record PageSpeed run');
  return { measured: queue.map((p) => p.path), errors, remaining, results: saved };
}

async function runIndexCheck(req) {
  if (!google.status().google) { const e = new Error('Connect Google first (see SETUP.md).'); e.status = 400; e.expose = true; throw e; }
  const list = await sitePages();
  const results = await limit(list, 5, (p) => google.inspectUrl(pageUrl(p.path)));
  const errors = [];
  const saved = await store.update('index', (d) => {
    list.forEach((p, i) => {
      const r = results[i];
      if (!r || r.error) errors.push({ path: p.path, error: r ? r.error : 'no answer' });
      else d[p.path] = r;
    });
    Object.keys(d).forEach((k) => { if (!list.some((p) => p.path === k)) delete d[k]; });
    return d;
  }, 'Index status check');
  await store.update('runs', (d) => Object.assign(d, { index: { at: new Date().toISOString(), by: who(req), checked: list.length - errors.length, errors: errors.slice(0, 5) } }), 'Record index check');
  if (errors.length === list.length) { const e = new Error(errors[0].error); e.status = 502; e.expose = true; throw e; }
  return { index: saved, errors };
}

async function setRecs(body, req) {
  const ids = Array.isArray(body.ids) ? body.ids.slice(0, 500) : [];
  const status = body.status;
  if (!ids.length || !['done', 'dismissed', 'snoozed', 'open'].includes(status)) {
    const e = new Error('Pick at least one recommendation and an action.'); e.status = 400; e.expose = true; throw e;
  }
  const info = body.info || {};
  const days = Math.min(90, Math.max(1, Number(body.days) || 14));
  return store.update('recs', (d) => {
    ids.forEach((id) => {
      if (status === 'open') { delete d[id]; return; }
      const meta = info[id] || {};
      d[id] = {
        status, at: new Date().toISOString(), by: who(req),
        until: status === 'snoozed' ? new Date(Date.now() + days * 86400000).toISOString() : undefined,
        title: String(meta.title || '').slice(0, 300), path: String(meta.path || '').slice(0, 200),
        pillar: String(meta.pillar || '').slice(0, 20), severity: String(meta.severity || '').slice(0, 20), source: String(meta.source || '').slice(0, 40),
      };
    });
    return d;
  }, `Mark ${ids.length} recommendation(s) ${status}`);
}

async function track(body, add) {
  const kw = String(body.keyword || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
  if (!kw) { const e = new Error('Type a keyword.'); e.status = 400; e.expose = true; throw e; }
  const next = await store.update('tracked', (d) => {
    let list = Array.isArray(d.keywords) ? d.keywords : DEFAULT_TRACKED.slice();
    if (add) {
      if (!list.includes(kw)) {
        if (list.length >= TRACK_LIMIT) { const e = new Error(`You can track up to ${TRACK_LIMIT} keywords. Remove one first.`); e.status = 400; e.expose = true; throw e; }
        list = list.concat([kw]);
      }
    } else {
      list = list.filter((k) => k !== kw);
    }
    return { keywords: list };
  }, `${add ? 'Track' : 'Stop tracking'} keyword: ${kw}`);
  return { tracked: next.keywords };
}

function gaScript(id) {
  return `// ga.js: Google Analytics for ati-products.com, set from the admin's SEO
// dashboard. It waits until the visitor interacts with the page (or a few
// seconds pass) before loading Google's script, so it doesn't slow the
// page down. Leave the ID empty to turn tracking off.
(function () {
  var ID = ${JSON.stringify(id || '')};
  var w = window, d = document;
  w.dataLayer = w.dataLayer || [];
  w.gtag = w.gtag || function () { w.dataLayer.push(arguments); };
  // atiTrack('generate_lead', {...}) works even before Google's script loads.
  w.atiTrack = function (name, params) { if (ID) w.gtag('event', name, params || {}); };
  if (!ID || !/(^|\\.)ati-products\\.com$/.test(location.hostname)) return;
  w.gtag('js', new Date());
  w.gtag('config', ID);
  var loaded = false;
  function load() {
    if (loaded) return;
    loaded = true;
    var s = d.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ID);
    d.head.appendChild(s);
  }
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(function (e) { w.addEventListener(e, load, { once: true, passive: true }); });
  w.addEventListener('load', function () { setTimeout(load, 8000); });
  // Calls and calculator quotes are the actions that matter most.
  d.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (/^tel:/i.test(href)) w.atiTrack('phone_click', { link_url: href, page_path: location.pathname });
    else if (a.hasAttribute('data-quote')) w.atiTrack('calculator_quote', { page_path: location.pathname });
  }, true);
})();
`;
}

async function saveSettings(body) {
  const mid = String(body.gaMeasurementId || '').trim().toUpperCase();
  const pid = String(body.gaPropertyId || '').trim().replace(/^properties\//, '');
  if (mid && !/^G-[A-Z0-9]{4,15}$/.test(mid)) { const e = new Error('The measurement ID looks like G-ABC123XYZ. Find it in Google Analytics under Admin, Data streams.'); e.status = 400; e.expose = true; throw e; }
  if (pid && !/^\d{5,15}$/.test(pid)) { const e = new Error('The property ID is a number, like 412345678. Find it in Google Analytics under Admin, Property details.'); e.status = 400; e.expose = true; throw e; }
  const before = (await store.read('settings')).data || {};
  const next = await store.update('settings', (d) => Object.assign(d, { gaMeasurementId: mid, gaPropertyId: pid }), 'Update SEO dashboard settings');
  let siteUpdated = false;
  if ((before.gaMeasurementId || '') !== mid) {
    const file = await getFile('ga.js');
    const content = gaScript(mid);
    if (!file || file.content !== content) {
      await putFile('ga.js', content, mid ? 'Update Google Analytics ID via admin' : 'Turn off Google Analytics via admin', file ? file.sha : undefined);
      siteUpdated = true;
    }
  }
  return { settings: next, siteUpdated };
}

// ---------- the daily check ----------

async function cron(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Not allowed.' });
    return;
  }
  const done = { at: new Date().toISOString(), steps: [] };
  try {
    if (google.status().google) {
      const r = await runIndexCheck(null);
      done.steps.push(`index: ${Object.keys(r.index).length} checked${r.errors.length ? `, ${r.errors.length} errors` : ''}`);
    }
  } catch (e) { done.steps.push('index failed: ' + e.message); }
  try {
    const r = await runPageSpeed('mobile', null);
    done.steps.push(`pagespeed: ${r.measured.join(', ')}${r.errors.length ? ` (${r.errors.length} errors)` : ''}`);
  } catch (e) { done.steps.push('pagespeed failed: ' + e.message); }
  done.ok = !done.steps.some((s) => /failed/.test(s));
  await store.update('runs', (d) => Object.assign(d, { cron: done }), 'Record daily SEO check').catch(() => {});
  res.status(200).json(done);
}

// ---------- routing ----------

const admin = requireAuth(async (req, res) => {
  try {
    if (req.method === 'GET') {
      const view = (req.query && req.query.view) || 'core';
      if (view === 'core') return res.status(200).json(await coreView());
      if (view === 'search') return res.status(200).json(await searchView());
      if (view === 'analytics') return res.status(200).json(await analyticsView());
      return res.status(400).json({ error: 'Unknown view.' });
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      if (body.action === 'pagespeed') return res.status(200).json(await runPageSpeed(body.strategy, req, body.paths));
      if (body.action === 'index') return res.status(200).json(await runIndexCheck(req));
      if (body.action === 'recs') return res.status(200).json({ saved: Object.keys(await setRecs(body, req)).length });
      if (body.action === 'track') return res.status(200).json(await track(body, true));
      if (body.action === 'untrack') return res.status(200).json(await track(body, false));
      if (body.action === 'settings') return res.status(200).json(await saveSettings(body));
      if (body.action === 'audit-draft') return res.status(200).json(await auditDraft(body));
      return res.status(400).json({ error: 'Unknown action.' });
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(e.status && e.status < 600 ? e.status : 500).json({ error: e.expose ? e.message : `Something went wrong: ${e.message}` });
  }
}, { role: 'admin' });

module.exports = async (req, res) => {
  if (req.query && req.query.task === 'cron') return cron(req, res);
  return admin(req, res);
};
module.exports.gaScript = gaScript;
