// lib/google.js
//
// Talks to Google for the SEO dashboard: Search Console (clicks, keywords,
// index status), Google Analytics 4 (visitors) and PageSpeed Insights.
// No libraries: a Google "service account" signs in with a signed token
// made here with Node's built-in crypto.
//
// Environment variables (see SETUP.md, "SEO dashboard"):
//   GOOGLE_SERVICE_ACCOUNT_JSON  the service account's key file (the whole
//                                JSON, pasted as-is, or base64 of it)
//   GSC_SITE_URL                 Search Console property, default
//                                "sc-domain:ati-products.com"
//   GA4_PROPERTY_ID              optional; can also be saved in the dashboard
//   PAGESPEED_API_KEY            optional but recommended (higher limits)

const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = {
  gsc: 'https://www.googleapis.com/auth/webmasters.readonly',
  ga: 'https://www.googleapis.com/auth/analytics.readonly',
};

function friendly(message, status) {
  const e = new Error(message);
  e.status = status || 502;
  e.expose = true;
  return e;
}

function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  let text = raw.trim();
  if (!text.startsWith('{')) {
    try { text = Buffer.from(text, 'base64').toString('utf8'); } catch (e) { /* fall through */ }
  }
  try {
    const sa = JSON.parse(text);
    if (!sa.client_email || !sa.private_key) throw new Error('missing fields');
    sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    return sa;
  } catch (e) {
    throw friendly('GOOGLE_SERVICE_ACCOUNT_JSON in Vercel isn’t a valid Google key file. Paste the whole downloaded .json file as the value.', 500);
  }
}

function gscSite() {
  return process.env.GSC_SITE_URL || 'sc-domain:ati-products.com';
}

const tokenCache = {};

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function accessToken(scope) {
  const sa = serviceAccount();
  if (!sa) throw friendly('Google isn’t connected yet. Add GOOGLE_SERVICE_ACCOUNT_JSON in Vercel (see SETUP.md).', 400);
  const hit = tokenCache[scope];
  if (hit && hit.exp > Date.now() + 60000) return hit.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(sa.private_key))}`;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw friendly(`Google refused the service account sign-in (${data.error_description || data.error || res.status}). Check GOOGLE_SERVICE_ACCOUNT_JSON in Vercel.`);
  }
  tokenCache[scope] = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

async function googleJson(url, scope, body, what) {
  const token = await accessToken(scope);
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign({ Authorization: `Bearer ${token}` }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || res.status;
    if (res.status === 403) {
      const sa = serviceAccount();
      throw friendly(`${what}: Google says the service account (${sa ? sa.client_email : '?'}) doesn’t have access. Add it as a user in ${what === 'Google Analytics' ? 'Google Analytics (Viewer)' : 'Search Console (Full)'}. Details: ${msg}`, 403);
    }
    throw friendly(`${what} error: ${msg}`);
  }
  return data;
}

// ---------- Search Console ----------

function isoDay(d) { return d.toISOString().slice(0, 10); }

// Search Console data lags about 2 days, so "the last 28 days" ends 2 days ago.
function windows(days) {
  const n = days || 28;
  const end = new Date(Date.now() - 2 * 86400000);
  const start = new Date(end.getTime() - (n - 1) * 86400000);
  const pEnd = new Date(start.getTime() - 86400000);
  const pStart = new Date(pEnd.getTime() - (n - 1) * 86400000);
  return { current: { startDate: isoDay(start), endDate: isoDay(end) }, previous: { startDate: isoDay(pStart), endDate: isoDay(pEnd) } };
}

async function gscQuery(body) {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(gscSite())}/searchAnalytics/query`;
  const data = await googleJson(url, SCOPES.gsc, Object.assign({ rowLimit: 5000, dataState: 'all' }, body), 'Search Console');
  return data.rows || [];
}

async function inspectUrl(pageUrl) {
  const data = await googleJson('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', SCOPES.gsc,
    { inspectionUrl: pageUrl, siteUrl: gscSite(), languageCode: 'en-US' }, 'Search Console');
  const r = (data.inspectionResult && data.inspectionResult.indexStatusResult) || {};
  return {
    verdict: r.verdict || '',
    coverageState: r.coverageState || '',
    lastCrawlTime: r.lastCrawlTime || '',
    googleCanonical: r.googleCanonical || '',
    userCanonical: r.userCanonical || '',
    robotsTxtState: r.robotsTxtState || '',
    pageFetchState: r.pageFetchState || '',
    checkedAt: new Date().toISOString(),
  };
}

// ---------- Google Analytics 4 ----------

async function gaReport(propertyId, body) {
  const id = String(propertyId || '').replace(/^properties\//, '');
  if (!/^\d+$/.test(id)) throw friendly('The Google Analytics property ID should be a number, like 412345678.', 400);
  return googleJson(`https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`, SCOPES.ga, body, 'Google Analytics');
}

// ---------- PageSpeed Insights ----------

async function pagespeed(pageUrl, strategy, timeoutMs) {
  const params = new URLSearchParams({ url: pageUrl, strategy: strategy || 'mobile' });
  ['performance', 'accessibility', 'best-practices', 'seo'].forEach((c) => params.append('category', c));
  if (process.env.PAGESPEED_API_KEY) params.set('key', process.env.PAGESPEED_API_KEY);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 50000);
  try {
    const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, { signal: ctl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data.error && data.error.message) || res.status;
      if (res.status === 429) throw friendly('PageSpeed’s free limit was reached. Add PAGESPEED_API_KEY in Vercel (see SETUP.md) or try again tomorrow.', 429);
      throw friendly(`PageSpeed error: ${msg}`);
    }
    const lr = data.lighthouseResult || {};
    const cat = lr.categories || {};
    const aud = lr.audits || {};
    const pct = (c) => (cat[c] && cat[c].score != null ? Math.round(cat[c].score * 100) : null);
    const num = (a) => (aud[a] && aud[a].numericValue != null ? aud[a].numericValue : null);
    return {
      perf: pct('performance'), a11y: pct('accessibility'), bp: pct('best-practices'), seo: pct('seo'),
      lcp: num('largest-contentful-paint'), fcp: num('first-contentful-paint'), cls: num('cumulative-layout-shift'),
      tbt: num('total-blocking-time'), si: num('speed-index'),
      at: new Date().toISOString(),
    };
  } catch (e) {
    if (e.name === 'AbortError') throw friendly('PageSpeed took too long to answer for this page. It will be tried again next time.', 504);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function status() {
  let sa = null;
  let saError = '';
  try { sa = serviceAccount(); } catch (e) { saError = e.message; }
  return {
    google: !!sa,
    googleEmail: sa ? sa.client_email : '',
    googleError: saError,
    gscSite: gscSite(),
    pagespeedKey: !!process.env.PAGESPEED_API_KEY,
    cronSecret: !!process.env.CRON_SECRET,
  };
}

module.exports = { gscQuery, inspectUrl, gaReport, pagespeed, windows, status, serviceAccount, isoDay };
