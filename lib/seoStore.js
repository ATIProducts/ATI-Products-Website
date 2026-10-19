// lib/seoStore.js
//
// Where the SEO dashboard keeps what it has learned: PageSpeed results,
// Google index checks, which recommendations were marked done, tracked
// keywords and settings. It's saved as small JSON files on a separate
// GitHub branch ("seo-data"), never on the site's own branch, so saving
// dashboard data doesn't rebuild or redeploy the website. The branch
// carries its own vercel.json that turns Vercel deployments off for it.
//
//   seo/pagespeed.json   { "/path": { mobile: {...}, desktop: {...} } }
//   seo/index.json       { "/path": { verdict, coverageState, ... } }
//   seo/recs.json        { "<id>": { status, until, at, by, title } }
//   seo/tracked.json     { keywords: ["adjustastairs", ...] }
//   seo/settings.json    { gaMeasurementId, gaPropertyId }
//   seo/runs.json        { pagespeed: {...}, index: {...}, cron: {...} }

const { ghRequest } = require('./github');

const BRANCH = process.env.SEO_DATA_BRANCH || 'seo-data';
let branchReady = false;

function enc(p) { return p.split('/').map(encodeURIComponent).join('/'); }

async function ensureBranch() {
  if (branchReady) return;
  try {
    await ghRequest('GET', `/git/ref/heads/${enc(BRANCH)}`);
    branchReady = true;
    return;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  // A brand-new branch with no history and only dashboard files in it.
  const tree = await ghRequest('POST', '/git/trees', {
    tree: [
      { path: 'vercel.json', mode: '100644', type: 'blob', content: JSON.stringify({ git: { deploymentEnabled: false } }, null, 2) + '\n' },
      { path: 'README.md', mode: '100644', type: 'blob', content: '# SEO dashboard data\n\nSaved automatically by the website admin\'s SEO dashboard. This branch is not the website and is never deployed. Please don\'t edit or merge it.\n' },
      { path: 'seo/settings.json', mode: '100644', type: 'blob', content: '{}\n' },
    ],
  });
  const commit = await ghRequest('POST', '/git/commits', { message: 'Start SEO dashboard data', tree: tree.sha, parents: [] });
  try {
    await ghRequest('POST', '/git/refs', { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  } catch (e) {
    if (e.status !== 422) throw e; // 422 = someone else just created it
  }
  branchReady = true;
}

async function read(name) {
  await ensureBranch();
  try {
    const data = await ghRequest('GET', `/contents/${enc('seo/' + name + '.json')}?ref=${encodeURIComponent(BRANCH)}`);
    const text = Buffer.from(data.content, data.encoding || 'base64').toString('utf8');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
    return { data: parsed, sha: data.sha };
  } catch (e) {
    if (e.status === 404) return { data: null, sha: null };
    throw e;
  }
}

async function readMany(names) {
  const out = {};
  await Promise.all(names.map(async (n) => { out[n] = (await read(n)).data; }));
  return out;
}

// Reads a file, lets `fn` change it, and saves it. If something else saved
// the same file in between, it re-reads and tries again.
async function update(name, fn, message) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await read(name);
    const next = fn(cur.data || {});
    const body = {
      message: message || `Update ${name}`,
      content: Buffer.from(JSON.stringify(next, null, 1) + '\n', 'utf8').toString('base64'),
      branch: BRANCH,
    };
    if (cur.sha) body.sha = cur.sha;
    try {
      await ghRequest('PUT', `/contents/${enc('seo/' + name + '.json')}`, body);
      return next;
    } catch (e) {
      lastErr = e;
      if (e.status !== 409 && e.status !== 422) throw e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr;
}

module.exports = { read, readMany, update, ensureBranch, BRANCH };
